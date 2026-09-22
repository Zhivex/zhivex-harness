import {createHash, randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {link, lstat, mkdir, open, realpath, unlink} from "node:fs/promises";
import path from "node:path";
import {readRegularFileNoFollow} from "../../src/internal/desktop/persistence.js";
import type {SqliteAccessLease} from "../../src/internal/desktop/persistence.js";
import {createMacApplicationVerifier} from "./mac-application-verifier.js";
import {launchDesktopUpdateWorker} from "./update-worker-launcher.js";
import type {DesktopUpdateHandoff} from "./update-handoff.js";

const LIMIT = 32 * 1024 * 1024;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Verify = (application: string, policy: {teamId: string; version: string}) => Promise<unknown>;
interface StagedWorker {readonly directory: string; readonly worker: string; readonly executable: string; readonly helper: string; readonly sha256: string}
async function readWorker(filename: string, privateFile: boolean) {
 const file = await readRegularFileNoFollow(filename, {label: "update worker", maxBytes: LIMIT, requireSingleLink: true});
 if (!file.contents.length || (privateFile && (file.stat.uid !== process.getuid?.() || (file.stat.mode & 0o077)))) throw new Error();
 return file.contents;
}
async function sync(directory: string) {const fd = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW); try {await fd.sync();} finally {await fd.close();}}

/** Host-only. Production verifies the installed source application before reading
 * its sealed resource and again before publishing the private immutable copy.
 * Native verifier injection is for component tests; never expose it through IPC.
 */
export function createDesktopUpdateWorkerStager(verify: Verify = createMacApplicationVerifier()) {
 const staged = new WeakMap<StagedWorker, {userData: string; application: string; policy: {teamId: string; version: string}}>();
 return {
  async prepare(input: {application: string; userData: string; teamId: string; version: string}): Promise<StagedWorker> {
   let temporary: string | undefined;
   try {
    input = {...input};
    const application = await realpath(input.application), userData = await realpath(input.userData);
    if (application !== input.application || userData !== input.userData || userData === application || userData.startsWith(application + path.sep)) throw new Error();
    const policy = {teamId: input.teamId, version: input.version};
    await verify(application, policy);
    const source = path.join(application, "Contents/Resources/update-worker-entry.cjs");
    if (await realpath(source) !== source) throw new Error();
    const bytes = await readWorker(source, false), digest = sha(bytes);
    await verify(application, policy);
    if (sha(await readWorker(source, false)) !== digest) throw new Error();
    const directory = path.join(userData, "update-worker"); await mkdir(directory, {mode: 0o700}).catch(error => {if (error.code !== "EEXIST") throw error;});
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) || await realpath(directory) !== directory) throw new Error();
    const worker = path.join(directory, `worker-${digest}.cjs`);
    temporary = path.join(directory, `.worker-${randomUUID()}`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {await file.writeFile(bytes); await file.sync();} finally {await file.close();}
    try {await link(temporary, worker);} catch (error) {if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;}
    await unlink(temporary); temporary = undefined;
    if (sha(await readWorker(worker, true)) !== digest) throw new Error();
    await sync(directory); await sync(userData);
    const result = Object.freeze({directory, worker, executable: path.join(application, "Contents/MacOS/Zhivex Harness"), helper: path.join(application, "Contents/Resources/update-worker-lock"), sha256: digest});
    staged.set(result, {userData, application, policy}); return result;
   } catch {throw new Error("UPDATE_WORKER_STAGING_FAILED");}
   finally {if (temporary) await unlink(temporary).catch(() => {});}
  },
  async launch(worker: StagedWorker, handoff: DesktopUpdateHandoff, stateAccess: ReadonlyArray<{databasePath: string; lease: SqliteAccessLease}>) {
   try {
    handoff = structuredClone(handoff); const access = stateAccess.map(entry => ({...entry}));
    const origin = staged.get(worker);
    if (!origin || origin.userData !== handoff.job.userData || sha(await readWorker(worker.worker, true)) !== worker.sha256) throw new Error();
    await verify(origin.application, origin.policy);
    if (sha(await readWorker(path.join(origin.application, "Contents/Resources/update-worker-entry.cjs"), false)) !== worker.sha256) throw new Error();
    return await launchDesktopUpdateWorker({...worker, arguments: [handoff.job.userData, handoff.job.id, handoff.nonce, handoff.sha256], stateAccess: access});
   } catch {throw new Error("UPDATE_WORKER_STAGING_LAUNCH_FAILED");}
  },
 };
}
