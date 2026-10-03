import { afterEach, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fixture } from "./fixture.js";
import { parseWebArgs } from "../src/cli.js";
import { startWebServer, staticInventory } from "../src/server.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
type Doc = {
  data: {
    session: { sessionId: string; revision: number };
    run: { runId: string; revision: number; status: string };
    sessions: { sessionId: string }[];
  };
};
async function setup() {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const host = await f.boot();
  cleanups.push(() => host.server.close());
  const origin = host.server.origin;
  const headers = {
    origin,
    "content-type": "application/json",
    "x-zhivex-web": "1",
  };
  const token = new URL(host.server.launchUrl).hash.slice(9);
  const pair = await fetch(origin + "/api/connect", {
    method: "POST",
    headers,
    body: JSON.stringify({ token }),
  });
  const doc = (await pair.json()) as {
    csrf: string;
    workspaces: { key: string }[];
  };
  const cookie = pair.headers.get("set-cookie")!.split(";")[0]!;
  const call = async (action: string, args: Record<string, unknown> = {}) => {
    const r = await fetch(origin + "/api/action", {
      method: "POST",
      headers: { ...headers, cookie, "x-zhivex-csrf": doc.csrf },
      body: JSON.stringify({
        action,
        workspaceKey: doc.workspaces[0]!.key,
        ...args,
      }),
    });
    return (await r.json()) as Doc;
  };
  const session = (await call("create", { idempotencyKey: randomUUID() })).data
    .session;
  return {
    ...f,
    ...host,
    origin,
    headers,
    cookie,
    csrf: doc.csrf,
    workspaceKey: doc.workspaces[0]!.key,
    call,
    session,
    token,
  };
}

test("strict loopback options, immutable asset inventory and symlink rejection", async () => {
  expect(() => parseWebArgs(["--host", "0.0.0.0"])).toThrow();
  expect(() => parseWebArgs(["--port", "-1"])).toThrow();
  expect(() =>
    parseWebArgs([
      "--workspace",
      "a",
      "--workspace",
      "b",
      "--state-dir",
      "shared",
    ]),
  ).toThrow();
  await expect(
    startWebServer({ runtimes: [], assetsDirectory: ".", host: "0.0.0.0" }),
  ).rejects.toThrow("LOOPBACK");
  const dir = await mkdtemp("/tmp/zcw-assets-");
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(dir + "/index.html", "safe");
  await mkdir(dir + "/assets");
  await symlink("/etc/passwd", dir + "/assets/escape");
  await expect(staticInventory(dir)).rejects.toThrow("UNSAFE");
});
test("HTTP security rejects unauthenticated actions, CSRF, rebinding, foreign Origin and traversal", async () => {
  const f = await setup();
  const body = JSON.stringify({
    action: "sessions",
    workspaceKey: f.workspaceKey,
  });
  for (const [headers, status] of [
    [f.headers, 401],
    [{ ...f.headers, cookie: f.cookie }, 403],
    [
      {
        ...f.headers,
        cookie: f.cookie,
        "x-zhivex-csrf": f.csrf,
        origin: "http://evil.invalid",
      },
      403,
    ],
    [
      {
        ...f.headers,
        cookie: f.cookie,
        "x-zhivex-csrf": f.csrf,
        "sec-fetch-site": "cross-site",
      },
      403,
    ],
  ] as const) {
    expect(
      (await fetch(f.origin + "/api/action", { method: "POST", headers, body }))
        .status,
    ).toBe(status);
  }
  const rebinding = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      f.origin,
      { headers: { host: "evil.invalid" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      },
    );
    req.once("error", reject);
    req.end();
  });
  expect(rebinding).toBe(403);
  for (const route of [
    "/%2e%2e/etc/passwd",
    "/assets/%2fetc%2fpasswd",
    "/.git/config",
    "/review.txt",
  ]) {
    expect((await fetch(f.origin + route)).status).toBe(404);
  }
  expect(
    (
      await fetch(f.origin + "/api/connect", {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify({ token: f.token }),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(f.origin + "/api/context", {
        method: "POST",
        headers: { ...f.headers, cookie: f.cookie, "x-zhivex-csrf": f.csrf },
        body: "{}",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await fetch(f.origin + "/api/context", {
        method: "POST",
        headers: { ...f.headers, cookie: f.cookie },
        body: "{}",
      })
    ).status,
  ).toBe(403);
  const html = await fetch(f.origin);
  expect(html.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  expect(html.headers.get("referrer-policy")).toBe("no-referrer");
  const invalid = await fetch(f.origin + "/api/action", {
    method: "POST",
    headers: { ...f.headers, cookie: f.cookie, "x-zhivex-csrf": f.csrf },
    body: JSON.stringify({
      action: "start",
      workspaceKey: f.workspaceKey,
      workspace: "/",
      provider: "openai",
    }),
  });
  expect(invalid.status).toBe(400);
  expect(await f.call("sessions", { workspaceKey: "outside" })).toMatchObject({
    error: { code: "WEB_WORKSPACE_REJECTED" },
  });
});
test("opaque HTTP session credentials expire, require CSRF and rotate on shutdown", async () => {
  let clock = 1000;
  const options = {
    runtimes: [],
    assetsDirectory: new URL("../dist/", import.meta.url).pathname,
    now: () => clock,
  };
  const host = await startWebServer(options);
  cleanups.push(() => host.close());
  const headers = {
    origin: host.origin,
    "content-type": "application/json",
    "x-zhivex-web": "1",
  };
  const response = await fetch(host.origin + "/api/connect", {
    method: "POST",
    headers,
    body: JSON.stringify({ token: new URL(host.launchUrl).hash.slice(9) }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly; SameSite=Strict; Path=/");
  expect(cookie).not.toMatch(/Max-Age|Expires/i);
  const context = (await response.json()) as { csrf: string };
  const credentials = {
    ...headers,
    cookie: cookie.split(";")[0]!,
    "x-zhivex-csrf": context.csrf,
  };
  const read = (origin: string, proof = credentials) =>
    fetch(origin + "/api/context", {
      method: "POST",
      headers: { ...proof, origin },
      body: "{}",
    });
  expect((await read(host.origin)).status).toBe(200);
  expect(
    (await read(host.origin, { ...credentials, "x-zhivex-csrf": "" })).status,
  ).toBe(403);
  clock += 12 * 3600_000;
  expect((await read(host.origin)).status).toBe(401);
  await host.close();
  const restarted = await startWebServer(options);
  cleanups.push(() => restarted.close());
  expect((await read(restarted.origin)).status).toBe(401);
  const fresh = await fetch(restarted.origin + "/api/connect", {
    method: "POST",
    headers: { ...headers, origin: restarted.origin },
    body: JSON.stringify({ token: new URL(restarted.launchUrl).hash.slice(9) }),
  });
  expect(fresh.status).toBe(200);
  expect(fresh.headers.get("set-cookie")).not.toBe(cookie);
  expect(((await fresh.json()) as { csrf: string }).csrf).not.toBe(
    context.csrf,
  );
});

test("an expired launch capability cannot create an HTTP session", async () => {
  let clock = 1000;
  const host = await startWebServer({
    runtimes: [],
    assetsDirectory: new URL("../dist/", import.meta.url).pathname,
    now: () => clock,
  });
  cleanups.push(() => host.close());
  clock += 120_000;
  const response = await fetch(host.origin + "/api/connect", {
    method: "POST",
    headers: {
      origin: host.origin,
      "content-type": "application/json",
      "x-zhivex-web": "1",
    },
    body: JSON.stringify({ token: new URL(host.launchUrl).hash.slice(9) }),
  });
  expect(response.status).toBe(401);
  expect(response.headers.get("set-cookie")).toBeNull();
});
test("real engine approval is scoped, single-use, durable on restart and rejects stale or cross-session tickets", async () => {
  const f = await setup();
  const sessionId = f.session.sessionId;
  const started = await f.call("start", {
    sessionId,
    expectedRevision: f.session.revision,
    idempotencyKey: "edit",
    prompt: "edit-probe",
  });
  expect(started.data.run.status).toBe("waiting_approval");
  const runId = started.data.run.runId;
  const review = (await f.call("review", { sessionId, runId })) as unknown as {
    ticketId: string;
    canApprove: boolean;
    items: { files: { before: string; after: string }[] }[];
  };
  expect(review.canApprove).toBe(true);
  expect(review.items[0]?.files[0]?.before).toBe("before\n");
  const runtimeTicket = await f.runtime.review(
    "different-browser",
    sessionId,
    runId,
  );
  await expect(
    f.runtime.decide("another-browser", runtimeTicket.ticketId, true),
  ).rejects.toThrow("REVIEW_REQUIRED");
  const stale = (await f.call("review", { sessionId, runId })) as unknown as {
    ticketId: string;
  };
  const approved = await f.call("decide", {
    ticketId: review.ticketId,
    approve: true,
  });
  expect(approved.data.run.status).toBe("completed");
  expect(await readFile(f.workspace + "/review.txt", "utf8")).toBe(
    "after <img src=x onerror=alert(1)>\n",
  );
  expect(
    await f.call("decide", { ticketId: review.ticketId, approve: true }),
  ).toMatchObject({ error: { code: "REVIEW_REQUIRED" } });
  expect(
    await f.call("decide", { ticketId: stale.ticketId, approve: true }),
  ).toMatchObject({ ok: false });
  const receipts = await f.harness.store.listToolCalls?.(
    runId,
    f.harness.config.scope,
  );
  expect(
    receipts?.filter((r) => r.toolName === "apply_reviewed_replacement"),
  ).toHaveLength(1);
  await f.server.close();
  const host = await f.boot();
  cleanups.push(() => host.server.close());
  const persisted = await host.runtime.command({
    method: "session.get",
    sessionId,
  });
  expect(persisted).toMatchObject({
    ok: true,
    data: { session: { runs: [{ status: "completed" }] } },
  });
  expect(JSON.stringify(await host.runtime.events(sessionId, 0))).not.toContain(
    "sk-never-expose-fixturetoken",
  );
});
test("deny, active cancel, failure and engine workspace boundary use existing policy", async () => {
  const f = await setup();
  const sessionId = f.session.sessionId;
  const waiting = await f.call("start", {
    sessionId,
    expectedRevision: 0,
    idempotencyKey: "deny",
    prompt: "edit-probe",
  });
  const review = (await f.call("review", {
    sessionId,
    runId: waiting.data.run.runId,
  })) as unknown as { ticketId: string };
  await f.call("decide", { ticketId: review.ticketId, approve: false });
  expect(await readFile(f.workspace + "/review.txt", "utf8")).toBe("before\n");
  let session = (await f.call("session", { sessionId })).data.session;
  const work = f.call("start", {
    sessionId,
    expectedRevision: session.revision,
    idempotencyKey: "cancel",
    prompt: "wait-for-cancel",
  });
  let run: Doc["data"]["run"] | undefined;
  for (let i = 0; i < 60; i++) {
    const detail = await f.runtime.command({
      method: "session.get",
      sessionId,
    });
    if (
      detail.ok &&
      detail.data.kind === "session" &&
      detail.data.session.runs.length === 2
    ) {
      const last = detail.data.session.runs.at(-1)!;
      const r = await f.call("run", { sessionId, runId: last.runId });
      run = r.data.run;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(run?.status).toBe("running");
  await f.call("cancel", {
    sessionId,
    runId: run!.runId,
    expectedRevision: run!.revision,
    idempotencyKey: "cancel-now",
  });
  expect((await work).data.run.status).toBe("cancelled");
  session = (await f.call("session", { sessionId })).data.session;
  const failed = await f.call("start", {
    sessionId,
    expectedRevision: session.revision,
    idempotencyKey: "error",
    prompt: "error-probe",
  });
  expect(JSON.stringify(failed)).not.toContain("sk-never-expose-fixturetoken");
  session = (await f.call("session", { sessionId })).data.session;
  const boundary = await f.call("start", {
    sessionId,
    expectedRevision: session.revision,
    idempotencyKey: "boundary",
    prompt: "boundary-probe",
  });
  expect(JSON.stringify(boundary)).not.toContain("WEB_START_FAILED");
  expect(await readFile(f.root + "/outside.txt", "utf8")).toBe(
    "outside-boundary-sentinel",
  );
  session = (await f.call("session", { sessionId })).data.session;
  await f.call("start", {
    sessionId,
    expectedRevision: session.revision,
    idempotencyKey: "symlink",
    prompt: "symlink-probe",
  });
  expect(await readFile(f.root + "/outside.txt", "utf8")).toBe(
    "outside-boundary-sentinel",
  );
  expect(await readFile(f.workspace + "/review.txt", "utf8")).toBe("before\n");
});
