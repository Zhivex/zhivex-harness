import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Per-launch AEAD key stays on the host. This protects cookie contents, not HTTP transport or bearer replay. */
export function createSessionCookieCipher() {
  const key = randomBytes(32);
  let destroyed = false;
  const aad = (audience: string) =>
    Buffer.from(`zhivex-code-web-session-v1\0${audience}`, "utf8");
  return {
    seal(identity: string, audience: string) {
      if (destroyed) throw new Error("WEB_COOKIE_CIPHER_CLOSED");
      if (!/^[a-f0-9]{64}$/.test(identity))
        throw new Error("WEB_COOKIE_IDENTITY_INVALID");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, {
        authTagLength: 16,
      });
      cipher.setAAD(aad(audience));
      const encrypted = Buffer.concat([
        cipher.update(Buffer.from(identity, "hex")),
        cipher.final(),
      ]);
      return ["v1", nonce, encrypted, cipher.getAuthTag()]
        .map((part) =>
          typeof part === "string" ? part : part.toString("base64url"),
        )
        .join(".");
    },
    open(value: unknown, audience: string): string | undefined {
      if (destroyed || typeof value !== "string") return;
      const match =
        /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/.exec(
          value,
        );
      if (!match) return;
      const encoded = match.slice(1);
      const parts = encoded.map((part) => Buffer.from(part, "base64url"));
      if (parts.some((part, i) => part.toString("base64url") !== encoded[i]))
        return;
      const [nonce, encrypted, tag] = parts;
      try {
        const cipher = createDecipheriv("aes-256-gcm", key, nonce!, {
          authTagLength: 16,
        });
        cipher.setAAD(aad(audience));
        cipher.setAuthTag(tag!);
        return Buffer.concat([
          cipher.update(encrypted!),
          cipher.final(),
        ]).toString("hex");
      } catch {
        return;
      }
    },
    destroy() {
      destroyed = true;
      key.fill(0);
    },
  };
}
