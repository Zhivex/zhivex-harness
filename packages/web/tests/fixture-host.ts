import { fixture } from "./fixture.js";
const f = await fixture();
const host = await f.boot();
if (!process.send) throw new Error("FIXTURE_IPC_REQUIRED");
process.send({
  origin: host.server.origin,
  launchUrl: host.server.launchUrl,
  workspace: f.workspace,
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await host.server.close();
  await f.cleanup();
  process.disconnect?.();
}
process.once("SIGTERM", () => void close());
process.on("message", (message) => {
  if (message === "close") void close();
});
