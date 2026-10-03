import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { loopbackRequest, pairingToken } from "../scripts/local-smoke-http.mjs";

test("installed smoke confines file-derived pairing to the exact launch origin", () => {
  const origin = "http://127.0.0.1:3210";
  const token = "a".repeat(64);
  expect(pairingToken(origin + "/#connect=" + token, origin)).toBe(token);
  for (const link of [
    "http://evil.invalid/#connect=" + token,
    "http://127.0.0.1:3211/#connect=" + token,
    origin + "/other#connect=" + token,
    origin + "/?outside=1#connect=" + token,
    origin + "/#connect=not-a-capability",
  ])
    expect(() => pairingToken(link, origin)).toThrow("SMOKE_PAIRING_INVALID");
  for (const destination of [
    "http://evil.invalid",
    "http://localhost:3210",
    "https://127.0.0.1:3210",
    "http://127.0.0.1:3210@evil.invalid",
  ])
    expect(() =>
      loopbackRequest(destination, "/api/connect", { body: token }),
    ).toThrow("SMOKE_LOOPBACK_REQUIRED");
  for (const route of [
    "//evil.invalid/",
    "@evil.invalid/",
    "/assets/../escape.js",
    "/assets/app.js?outside=1",
  ])
    expect(() => loopbackRequest(origin, route, { body: token })).toThrow(
      "SMOKE_ROUTE_INVALID",
    );
});

test("installed smoke does not forward a pairing capability through redirects", async () => {
  let received = 0;
  const destination = createServer((_req, res) => {
    received++;
    res.end("unexpected");
  });
  const redirector = createServer((_req, res) => {
    const address = destination.address();
    if (!address || typeof address === "string")
      throw new Error("FIXTURE_ADDRESS_INVALID");
    res.writeHead(307, {
      location: `http://127.0.0.1:${address.port}/api/connect`,
    });
    res.end();
  });
  const listen = (server: ReturnType<typeof createServer>) =>
    new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = (server: ReturnType<typeof createServer>) =>
    new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  try {
    await listen(destination);
    await listen(redirector);
    const address = redirector.address();
    if (!address || typeof address === "string")
      throw new Error("FIXTURE_ADDRESS_INVALID");
    await expect(
      loopbackRequest(`http://127.0.0.1:${address.port}`, "/api/connect", {
        method: "POST",
        body: JSON.stringify({ token: "a".repeat(64) }),
      }),
    ).rejects.toThrow();
    expect(received).toBe(0);
  } finally {
    await close(redirector);
    await close(destination);
  }
});
