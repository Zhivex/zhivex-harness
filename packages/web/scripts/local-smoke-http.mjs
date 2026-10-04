/** Installed acceptance sends capabilities only to the exact numeric loopback host it launched. */
function checkedOrigin(origin) {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !parsed.port ||
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password
  )
    throw new Error("SMOKE_LOOPBACK_REQUIRED");
  return parsed;
}

export function pairingToken(contents, origin) {
  checkedOrigin(origin);
  const link = new URL(contents);
  if (
    link.origin !== origin ||
    link.pathname !== "/" ||
    link.search ||
    link.username ||
    link.password ||
    !/^#connect=[a-f0-9]{64}$/.test(link.hash)
  )
    throw new Error("SMOKE_PAIRING_INVALID");
  return link.hash.slice(9);
}

export function loopbackRequest(origin, route, options = {}) {
  checkedOrigin(origin);
  if (
    !["/", "/api/connect"].includes(route) &&
    !/^\/assets\/[A-Za-z0-9._-]+\.js$/.test(route)
  )
    throw new Error("SMOKE_ROUTE_INVALID");
  // A redirect must never forward the fixture's file-derived launch capability.
  return fetch(origin + route, { ...options, redirect: "error" });
}
