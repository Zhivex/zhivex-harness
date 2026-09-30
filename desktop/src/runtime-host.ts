import { createCheckpointReviewHost } from "./checkpoint-review.js";
import {defaultModelSelection, modelSelectionSchema} from "./model-selection.js";
import { vertexConfigured } from "@zhivex-ai/harness/desktop/v1/providers";
import {createHash} from "node:crypto";
import {openCredentialStore} from "./credential-store.js";
import { utilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { readHarnessLocalCredentials, requestHarnessLocalService } from "@zhivex-ai/harness/service";
import { ReviewTickets } from "./review-tickets.js";
import { projectApprovalReview } from "./approval-review.js";
import { desktopRedactor, hostSensitiveValues } from "./redaction.js";
import { harnessClientRequestSchema, type HarnessClientResponse } from "@zhivex-ai/harness/protocol";
import type { DesktopContext, DesktopProject } from "./bridge.js";
export async function launchProjectRuntime(project: DesktopProject, options: {toolPolicyFile?:string;credentialHelper?:string;fixtureCredentialHelper?:string; buildDirectory: string; directory: string; fixture: boolean; fixtureOci?: boolean; fixtureEffectCrash?: boolean; stateDirectory?: string; recover: boolean }) {
  const modelSelection = modelSelectionSchema.parse(project.modelSelection ?? defaultModelSelection());
  const stored=options.fixture&&!options.fixtureCredentialHelper?undefined:await openCredentialStore((options.fixture?options.fixtureCredentialHelper:options.credentialHelper)??path.join(options.buildDirectory,"credential-store"), {provider: modelSelection.provider}).read();
 if(stored&&!['present','missing'].includes(stored.status))throw new Error("CREDENTIAL_STORE_UNAVAILABLE");
 const secret=stored?.secret;
 const credentialConfigured = options.fixture || Boolean(secret) || (modelSelection.provider === "vertex" && vertexConfigured(process.env));
 const workerEnv:NodeJS.ProcessEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>options.fixture||!/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i.test(key)));
 const worker = utilityProcess.fork(path.join(options.buildDirectory, "runtime.cjs"), [JSON.stringify({ toolPolicyFile: options.toolPolicyFile, modelSelection, workspace: project.workspace, stateDirectory: options.stateDirectory, directory: options.directory, fixture: options.fixture, fixtureOci: options.fixture && options.fixtureOci === true, fixtureEffectCrash: options.fixture && options.fixtureEffectCrash === true, recover: options.recover })], { env:workerEnv, serviceName: `Harness · ${project.name}`, stdio: "pipe" });
  if (options.fixture) worker.stderr?.on("data", chunk => process.stderr.write(chunk));
  let exited = false; const stopped = new Promise<void>(resolve => worker.once("exit", () => { exited = true; resolve(); }));
  try {
    const ready = await new Promise<{ credentialProof?:{digest:string;argvClean:boolean;envClean:boolean};credentialsPath: string; pid: number; node: string; stateDirectory: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("RUNTIME_START_TIMEOUT")), 15000);
      worker.once("message", message => { clearTimeout(timer); if (message?.kind === "ready") resolve(message); else reject(new Error("RUNTIME_START_FAILED")); });
      worker.once("exit", () => { clearTimeout(timer); reject(new Error("RUNTIME_EXITED")); });
 worker.postMessage({kind:"credential-bootstrap",...(secret?{secret}:{})});
    });
    const credentials = await readHarnessLocalCredentials(ready.credentialsPath);
    const hello = await requestHarnessLocalService(credentials, "hello", { versions: [1] }); if (!hello.ok) throw new Error("PROTOCOL_UNSUPPORTED");
    const redact = desktopRedactor([...hostSensitiveValues(process.env), credentials.token,...(secret?[secret]:[])]);
    const context: DesktopContext = { credentialConfigured, modelSelection, project, projectId: hello.projectId, runtimePid: ready.pid, runtimeNode: ready.node, fixture: options.fixture };
    const tickets = new ReviewTickets();
    const checkpointReviews = createCheckpointReviewHost(async command => {
      if (fixtureOffline) throw new Error("TRANSPORT_UNAVAILABLE");
      const envelope = harnessClientRequestSchema.parse({ protocolVersion: 1, requestId: `checkpoint_${randomUUID()}`, connectionId: hello.connectionId,
        command: { ...command, projectId: hello.projectId } });
      return requestHarnessLocalService(credentials, "command", envelope);
    }, redact.redact);
    let fixtureOffline = false, fixtureDropResponse = false;
    return {
 fixtureCredentialProof(){if(!options.fixture||!secret)throw new Error("FIXTURE_DISABLED");return {verified:ready.credentialProof?.digest===createHash("sha256").update(secret).digest("hex"),argvClean:ready.credentialProof?.argvClean===true,envClean:ready.credentialProof?.envClean===true};},
      async crashFixture() { if (!options.fixture) throw new Error("FIXTURE_DISABLED"); if (!exited) worker.kill(); await stopped; }, async setFixtureApprovalClock(offset: number) {
        if (!options.fixture) throw new Error("FIXTURE_DISABLED");
        const requestId = randomUUID(); await new Promise<void>((resolve, reject) => {
          const listener = (message: { kind?: string; requestId?: string }) => { if (message.kind === "fixture-clock-ack" && message.requestId === requestId) { clearTimeout(timer); worker.off("message", listener); resolve(); } };
          const timer = setTimeout(() => { worker.off("message", listener); reject(new Error("FIXTURE_CLOCK_TIMEOUT")); }, 2000);
          worker.on("message", listener); worker.postMessage({ kind: "fixture-clock", offset, requestId });
        });
      }, fixtureCredentialsPath() { if (!options.fixture) throw new Error("FIXTURE_DISABLED"); return ready.credentialsPath; }, dropFixtureRunResponse() { if (!options.fixture) throw new Error("FIXTURE_DISABLED"); fixtureDropResponse = true; }, setFixtureOffline(value: boolean) { if (!options.fixture) throw new Error("FIXTURE_DISABLED"); fixtureOffline = value; }, context, stateDirectory: ready.stateDirectory, isAlive: () => !exited,
      reviewCheckpoint: checkpointReviews.review,
      reviewCheckpointRecovery: checkpointReviews.reviewRecovery,
      async resolveCheckpointReview(ticketId: unknown, approve: unknown) {
        const response = await checkpointReviews.resolve(ticketId, approve);
        return response ? redact.response(response) : null;
      },
      async review(sessionId: unknown, runId: unknown) {
        if (fixtureOffline) throw new Error("TRANSPORT_UNAVAILABLE");
        const envelope = harnessClientRequestSchema.parse({ protocolVersion: 1, requestId: `review_${randomUUID()}`, connectionId: hello.connectionId, command: { method: "run.get", projectId: hello.projectId, sessionId, runId, includeReview: true } });
        const response = await requestHarnessLocalService(credentials, "command", envelope);
        if (!response.ok || response.data.kind !== "run") throw new Error("REVIEW_UNAVAILABLE");
        return tickets.issue(sessionId as string, projectApprovalReview(response.data.run, redact.text));
      },
      async resolveReview(ticketId: unknown, approve: unknown) {
        if (!credentialConfigured && approve === true) throw new Error("MODEL_CREDENTIAL_REQUIRED");
        if (fixtureOffline) throw new Error("TRANSPORT_UNAVAILABLE");
        const command = tickets.consume(ticketId, approve);
        const envelope = harnessClientRequestSchema.parse({ protocolVersion: 1, requestId: `decision_${randomUUID()}`, connectionId: hello.connectionId, command: { ...command, projectId: hello.projectId } });
        const requestId = randomUUID();
        const response = await new Promise<HarnessClientResponse>((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('exit', exit); };
          const exit = () => { cleanup(); reject(new Error('REVIEW_RUNTIME_EXITED')); };
          const message = (value: { kind?: string; requestId?: string; response?: HarnessClientResponse; error?: string }) => {
            if (value?.kind !== 'reviewed-approval-result' || value.requestId !== requestId) return;
            cleanup();
            if (!value.response || value.error) reject(new Error('REVIEW_DISPATCH_FAILED'));
            else resolve(value.response);
          };
          const timer = setTimeout(() => { cleanup(); reject(new Error('REVIEW_RESPONSE_TIMEOUT')); }, 120_000);
          worker.on('message', message); worker.once('exit', exit);
          try { worker.postMessage({ kind: 'reviewed-approval', requestId, request: envelope }); }
          catch (error) { cleanup(); reject(error); }
        });
        return redact.response(response);
      },
      async command(command: unknown) {
        if (fixtureOffline) throw new Error("TRANSPORT_UNAVAILABLE");
        if (!command || typeof command !== "object" || Array.isArray(command) || "projectId" in command) throw new Error("INVALID_COMMAND");
        const parsed = harnessClientRequestSchema.safeParse({ protocolVersion: 1, requestId: `desktop_${randomUUID()}`, connectionId: hello.connectionId, command: { ...command, projectId: hello.projectId } });
        if (!parsed.success) throw new Error("INVALID_COMMAND");
        if (!credentialConfigured && parsed.data.command.method === "run.start") throw new Error("MODEL_CREDENTIAL_REQUIRED");
        const response = await requestHarnessLocalService(credentials, "command", parsed.data);
        if (fixtureDropResponse && parsed.data.command.method === "run.start") { fixtureDropResponse = false; throw new Error("TRANSPORT_RESPONSE_LOST"); }
        return redact.response(response);
      },
      async events(payload: unknown) {
        if (fixtureOffline) throw new Error("TRANSPORT_UNAVAILABLE");
        const parsed = z.object({ sessionId: z.string().min(1).max(160), after: z.number().int().nonnegative() }).strict().safeParse(payload);
        if (!parsed.success) throw new Error("INVALID_CURSOR");
        return redact.redact(await requestHarnessLocalService(credentials, "events", { projectId: hello.projectId, ...parsed.data })) as Awaited<ReturnType<typeof requestHarnessLocalService<"events">>>;
      },
      async controlClose(operation: "pause" | "resume" | "cancel"): Promise<boolean> {
        if (exited) return false;
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
          const listener = (message: { kind?: string; requestId?: string; ok?: boolean; busy?: boolean }) => { if (message.kind !== "close-control-ack" || message.requestId !== requestId) return; clearTimeout(timer); worker.off("message", listener); if (message.ok) resolve(message.busy === true); else reject(new Error("CLOSE_CONTROL_FAILED")); };
          const timer = setTimeout(() => { worker.off("message", listener); reject(new Error("CLOSE_CONTROL_TIMEOUT")); }, 5000);
          worker.on("message", listener); worker.postMessage({ kind: "close-control", requestId, operation });
        });
      },
      async close() { if (!exited) { worker.postMessage("close"); await stopped; } }
    };
  } catch (error) { if (!exited) worker.kill(); await stopped; throw error; }
}
export type ProjectRuntime = Awaited<ReturnType<typeof launchProjectRuntime>>;
