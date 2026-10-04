import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createSessionCookieCipher } from "../src/session-cookie.js";

test("browser cookies seal the internal identity with independent random nonces", () => {
  const cipher = createSessionCookieCipher();
  const identity = randomBytes(32).toString("hex");
  const audience = "http://127.0.0.1:3210/zhivex_web_example";
  try {
    const first = cipher.seal(identity, audience);
    const second = cipher.seal(identity, audience);
    expect(first).not.toBe(second);
    expect(first).not.toContain(identity);
    expect(
      Buffer.from(first.split(".")[2]!, "base64url").equals(
        Buffer.from(identity, "hex"),
      ),
    ).toBe(false);
    expect(cipher.open(first, audience)).toBe(identity);
    expect(cipher.open(second, audience)).toBe(identity);
  } finally {
    cipher.destroy();
  }
});

test("sealed cookies reject tampering, plaintext fallback, wrong audience and another launch key", () => {
  const cipher = createSessionCookieCipher();
  const other = createSessionCookieCipher();
  const identity = randomBytes(32).toString("hex");
  const audience = "http://127.0.0.1:3210/zhivex_web_example";
  try {
    const sealed = cipher.seal(identity, audience);
    for (const index of [1, 2, 3]) {
      const parts = sealed.split(".");
      const changed = Buffer.from(parts[index]!, "base64url");
      changed[0] = changed[0]! ^ 1;
      parts[index] = changed.toString("base64url");
      expect(cipher.open(parts.join("."), audience)).toBeUndefined();
    }
    for (const malformed of [
      identity,
      "",
      sealed + "=",
      sealed.slice(0, -1),
      sealed.replace(/^v1/, "v2"),
      "v1." + "a".repeat(10000),
    ])
      expect(cipher.open(malformed, audience)).toBeUndefined();
    expect(
      cipher.open(sealed, "http://127.0.0.1:3211/zhivex_web_example"),
    ).toBeUndefined();
    expect(
      cipher.open(sealed, "http://127.0.0.1:3210/another_cookie"),
    ).toBeUndefined();
    expect(other.open(sealed, audience)).toBeUndefined();
    cipher.destroy();
    expect(cipher.open(sealed, audience)).toBeUndefined();
    expect(() => cipher.seal(identity, audience)).toThrow("CLOSED");
  } finally {
    cipher.destroy();
    other.destroy();
  }
});
