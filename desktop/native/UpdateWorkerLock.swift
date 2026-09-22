import Darwin

// fd 3 is opened and checked by the trusted host. Keep its flock across exec:
// there is no supervisor whose death can release a live worker's lock.
var arguments = Array(CommandLine.arguments.dropFirst())
var stateCount = 0
if arguments.first == "--state-fds" {
    guard arguments.count >= 4, let count = Int(arguments[1]), count >= 0, count <= 600 else { exit(64) }
    stateCount = count
    arguments.removeFirst(2)
}
guard arguments.count >= 2, arguments[0].hasPrefix("/") else { exit(64) }
// fd 3 serializes workers; fd 4 onward carry the host's exclusive state leases.
// Reassert exclusivity and preserve every descriptor across exec without unlocking.
for descriptor in 3...(3 + stateCount) {
    let fd = Int32(descriptor)
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
          info.st_uid == getuid(), info.st_nlink == 1,
          (info.st_mode & 0o077) == 0, info.st_size == 0 else { exit(77) }
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { exit(75) }
    let flags = fcntl(fd, F_GETFD)
    guard flags >= 0, fcntl(fd, F_SETFD, flags & ~FD_CLOEXEC) == 0 else { exit(71) }
}
let argv = arguments.map { strdup($0) } + [nil]
argv.withUnsafeBufferPointer { buffer in
    _ = execv(arguments[0], buffer.baseAddress!)
}
exit(71)
