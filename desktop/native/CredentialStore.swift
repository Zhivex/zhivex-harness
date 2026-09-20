import Foundation
import Security
import AppKit

// Secrets never appear in arguments, errors or configuration files.
let service = "ai.zhivex.harness.providers"
let account = "openai"
enum VaultError: Error { case status(OSStatus), invalid, cancelled }
func check(_ status: OSStatus) throws { if status != errSecSuccess { throw VaultError.status(status) } }
func unlocked(_ keychain: SecKeychain) throws {
    var state: SecKeychainStatus = 0
    try check(SecKeychainGetStatus(keychain, &state))
    if state & SecKeychainStatus(kSecUnlockStateStatus) == 0 { throw VaultError.status(errSecInteractionNotAllowed) }
}
func query(_ keychain: SecKeychain) -> [String: Any] {
    return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account, kSecMatchSearchList as String: [keychain]]
}
func read(_ keychain: SecKeychain) throws -> Data? {
    try unlocked(keychain)
    var q = query(keychain); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var value: CFTypeRef?
    let result = SecItemCopyMatching(q as CFDictionary, &value)
    if result == errSecItemNotFound { return nil }
    try check(result)
    guard let data = value as? Data, !data.isEmpty, data.count <= 8192 else { throw VaultError.invalid }
    return data
}
func present(_ keychain: SecKeychain) throws -> Bool {
    try unlocked(keychain)
    var q = query(keychain); q[kSecReturnAttributes as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var value: CFTypeRef?
    let result = SecItemCopyMatching(q as CFDictionary, &value)
    if result == errSecItemNotFound { return false }
    try check(result); return true
}
func save(_ keychain: SecKeychain, _ data: Data) throws {
    try unlocked(keychain)
    guard let text = String(data: data, encoding: .utf8), !text.isEmpty, data.count <= 8192,
          !text.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }) else { throw VaultError.invalid }
    let update = SecItemUpdate(query(keychain) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if update != errSecItemNotFound { try check(update); return }
    var trusted: SecTrustedApplication?
    try check(SecTrustedApplicationCreateFromPath(nil, &trusted))
    guard let trusted = trusted else { throw VaultError.invalid }
    var access: SecAccess?
    try check(SecAccessCreate("Zhivex Harness provider credentials" as CFString, [trusted] as CFArray, &access))
    guard let access = access else { throw VaultError.invalid }
    var q = query(keychain); q.removeValue(forKey: kSecMatchSearchList as String)
    q[kSecUseKeychain as String] = keychain; q[kSecValueData as String] = data
    q[kSecAttrAccess as String] = access
    try check(SecItemAdd(q as CFDictionary, nil))
}
func remove(_ keychain: SecKeychain) throws {
    try unlocked(keychain)
    let status = SecItemDelete(query(keychain) as CFDictionary)
    if status != errSecItemNotFound { try check(status) }
}
func prompt() throws -> Data {
    let app = NSApplication.shared; app.setActivationPolicy(.accessory); app.activate(ignoringOtherApps: true)
    let alert = NSAlert(); alert.messageText = "Clave de OpenAI"
    alert.informativeText = "Se guardará en el llavero de macOS. Reemplaza la clave anterior."
    alert.addButton(withTitle: "Guardar en el llavero"); alert.addButton(withTitle: "Cancelar")
    let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 26))
    field.placeholderString = "API key"; alert.accessoryView = field; alert.window.initialFirstResponder = field
    guard alert.runModal() == .alertFirstButtonReturn else { field.stringValue = ""; throw VaultError.cancelled }
    let data = Data(field.stringValue.utf8); field.stringValue = ""; return data
}
func emit(_ status: String) { print("{\"status\":\"\(status)\"}") }
// This test creates its own temporary keychain; it never opens or changes login.keychain.
func selfTest() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("har-keychain-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let filename = directory.appendingPathComponent("fixture.keychain-db").path
    let password = UUID().uuidString; var temporary: SecKeychain?
    try password.withCString { bytes in try check(SecKeychainCreate(filename, UInt32(password.utf8.count), bytes, false, nil, &temporary)) }
    guard let keychain = temporary else { throw VaultError.invalid }
    defer { SecKeychainDelete(keychain) }
    let first = Data(UUID().uuidString.utf8), second = Data(UUID().uuidString.utf8)
    guard try !present(keychain) else { throw VaultError.invalid }
    try save(keychain, first); guard try read(keychain) == first else { throw VaultError.invalid }
    try save(keychain, second); guard try read(keychain) == second else { throw VaultError.invalid }
    try check(SecKeychainLock(keychain))
    do { _ = try read(keychain); throw VaultError.invalid } catch VaultError.status(let status) { guard status == errSecInteractionNotAllowed else { throw VaultError.status(status) } }
    try password.withCString { bytes in try check(SecKeychainUnlock(keychain, UInt32(password.utf8.count), bytes, true)) }
    guard try read(keychain) == second else { throw VaultError.invalid }
    try remove(keychain); try remove(keychain); guard try !present(keychain) else { throw VaultError.invalid }
    emit("self-test-passed")
}
do {
    guard CommandLine.arguments.count == 2 else { throw VaultError.invalid }
    let command = CommandLine.arguments[1]
    if command == "self-test" { try selfTest() } else {
        guard ["status", "configure", "read", "delete"].contains(command) else { throw VaultError.invalid }
        var result: SecKeychain?; try check(SecKeychainCopyDefault(&result))
        guard let keychain = result else { throw VaultError.invalid }
        switch command {
        case "status": emit(try present(keychain) ? "present" : "missing")
        case "configure": try unlocked(keychain); try save(keychain, prompt()); emit("saved")
        case "delete": try remove(keychain); emit("deleted")
        case "read":
            guard let data = try read(keychain) else { emit("missing"); exit(0) }
            let object: [String: Any] = ["status": "present", "secret": String(data: data, encoding: .utf8)!]
            FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: object))
        default: throw VaultError.invalid
        }
    }
} catch VaultError.cancelled { emit("cancelled") }
catch VaultError.status(let status) {
    emit([errSecInteractionNotAllowed, errSecAuthFailed, errSecUserCanceled].contains(status) ? "locked" : "unavailable")
}
catch { emit("invalid") }
