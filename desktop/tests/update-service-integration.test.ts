import {expect, test} from "bun:test";
import {mkdir, mkdtemp, rm} from "node:fs/promises";
import path from "node:path";
import {createMockLanguageModel} from "@zhivex-ai/agents/testing";
import type {LanguageModel} from "@zhivex-ai/agents";
import {createHarness} from "../../src/runtime/harness.js";
import {startHarnessLocalService, readHarnessLocalCredentials, requestHarnessLocalService} from "../../src/client/local-service.js";
import {exportHarnessStateBackup, readHarnessStateBackup} from "../../src/persistence/state-backup.js";
import {createUpdateCoordinator} from "../src/update-coordinator.js";

test("real local service preserves active work and blocks other client mutations during update preparation", async () => {
 const root = await mkdtemp("/tmp/har-update-service-"), workspace = path.join(root, "repo"); await mkdir(workspace);
 let begin!: () => void, release!: () => void, cancelled = false;
 const began = new Promise<void>(r => {begin = r;}), gate = new Promise<void>(r => {release = r;});
 const mock = createMockLanguageModel();
 const model: LanguageModel = {...mock, async stream(input) {
  return (async function* () {
   input.abortSignal?.addEventListener("abort", () => {cancelled = true; release();}, {once: true});
   begin(); await gate;
   yield {type: "text-delta" as const, textDelta: "completed without update cancellation"};
   yield {type: "finish" as const, finishReason: "stop" as const};
  })();
 }};
 const harness = await createHarness({workspace, provider: "openai", modelInstance: model, storeBackend: "sqlite", subagentProfiles: []});
 const service = await startHarnessLocalService(harness, {directory: path.join(root, "socket")});
 let alive = true, backupCalls = 0;
 try {
  const credentials = await readHarnessLocalCredentials(service.credentialsPath);
  const hello = await requestHarnessLocalService(credentials, "hello", {versions: [1]});
  if (!hello.ok || !("connectionId" in hello)) throw new Error("HELLO_FAILED");
  let n = 0;
  const call = (command: Record<string, unknown>) => requestHarnessLocalService(credentials, "command", {protocolVersion: 1, connectionId: hello.connectionId, requestId: `update_${++n}`, command: {projectId: hello.projectId, ...command}});
  const created = await call({method: "session.create", idempotencyKey: "create"});
  if (!created.ok || created.data.kind !== "session") throw new Error();
  const session = created.data.session;
  const work = call({method: "run.start", sessionId: session.sessionId, expectedRevision: session.revision, idempotencyKey: "run", prompt: "preserve this work"});
  const coordinator = createUpdateCoordinator({
   busy: () => false,
   hosts: async () => [{isAlive: () => alive, async controlClose(op: "pause" | "resume") {if (op === "pause") return service.pauseAdmission(); service.resumeAdmission(); return false;}, async close() {await service.close(); alive = false;}}],
   async backup() {
    backupCalls++;
    // This request enters through the real Unix socket, independently of the desktop gate.
    await expect(call({method: "session.create", idempotencyKey: "during-backup"})).rejects.toThrow("HTTP_503");
    expect(await call({method: "session.list"})).toMatchObject({ok: true});
    const target = path.join(root, "backup.json");
    await exportHarnessStateBackup(harness.config, target);
    const bundle = await readHarnessStateBackup(target);
    expect(bundle.records.runs).toHaveLength(1);
    expect(bundle.records.runs[0]!.state.status).toBe("completed");
    // Deliberate pre-install failure verifies resumption, not a fake successful installation.
    throw new Error("fixture stops before installation");
   },
   async markRecovery() {throw new Error("MUST_NOT_RUN");},
   async install() {throw new Error("MUST_NOT_RUN");},
   async recover() {throw new Error("MUST_NOT_RUN");},
   async clearRecovery() {throw new Error("MUST_NOT_RUN");},
   clearClosedHosts() {throw new Error("MUST_NOT_RUN");},
  });
  await began;
  await expect(coordinator.apply()).rejects.toThrow("UPDATE_WORK_ACTIVE");
  expect(cancelled).toBe(false); expect(backupCalls).toBe(0); expect(alive).toBe(true);
  // Admission resumed: the adapter reports its ordinary active-run BUSY response, not HTTP_503.
  expect(await call({method: "session.create", idempotencyKey: "after-refusal"})).toMatchObject({ok: false, error: {code: "BUSY"}});
  release(); expect(await work).toMatchObject({ok: true, data: {kind: "run", run: {status: "completed"}}});
  await expect(coordinator.apply()).rejects.toThrow("UPDATE_PREPARATION_FAILED");
  expect(backupCalls).toBe(1); expect(coordinator.blocked).toBe(false); expect(cancelled).toBe(false);
  expect(await call({method: "session.get", sessionId: session.sessionId})).toMatchObject({ok: true, data: {session: {runs: [{status: "completed"}]}}});
  expect(await call({method: "session.create", idempotencyKey: "after-backup"})).toMatchObject({ok: true});
 } finally {release(); await service.cancelActive(); if (alive) await service.close(); await rm(root, {recursive: true, force: true});}
}, 20_000);
