export interface UpdateRuntime {
 isAlive(): boolean;
 controlClose(operation: "pause" | "resume"): Promise<boolean>;
 close(): Promise<void>;
}
export type UpdatePhase = "idle" | "preparing" | "installing" | "restart-required" | "recovery-required";
export type UpdateFailure = "UPDATE_WORK_ACTIVE" | "UPDATE_PREPARATION_FAILED" | "UPDATE_INSTALL_FAILED" | "UPDATE_RECOVERY_REQUIRED";
export class UpdateCoordinatorError extends Error {
 constructor(readonly code: UpdateFailure) {super(code);}
}

/** Host-only transaction coordinator. Callers must consult blocked at EVERY mutation admission.
 * Persistence/native installation are supplied by the host; none may accept renderer callbacks.
 * backup must include all state and refuse nonterminal durable runs/leases, not just in-flight IPC.
 * markRecovery must durably record the backup before returning. install returns only once
 * replacement and migration succeed; recover must restore AND verify both application and state.
 */
export function createUpdateCoordinator<Backup>(deps: {
 busy(): boolean;
 hosts(): Promise<UpdateRuntime[]>;
 backup(): Promise<Backup>;
 markRecovery(backup: Backup): Promise<void>;
 install(backup: Backup): Promise<void>;
 recover(backup: Backup): Promise<void>;
 clearRecovery(): Promise<void>;
 clearClosedHosts(): void;
}) {
 let phase: UpdatePhase = "idle";
 return {
  get phase() {return phase;},
  get blocked() {return phase !== "idle";},
  async apply(): Promise<void> {
   if (phase !== "idle" || deps.busy()) throw new UpdateCoordinatorError("UPDATE_WORK_ACTIVE");
   // Synchronous before any await, so host admission can reject concurrent requests.
   phase = "preparing";
   const paused: UpdateRuntime[] = [];
   let backup: Backup | undefined;
   let recoveryMarked = false, destructiveBoundary = false;
   let failure: UpdateFailure = "UPDATE_PREPARATION_FAILED";
   try {
    const hosts = await deps.hosts();
    if (deps.busy()) throw new UpdateCoordinatorError("UPDATE_WORK_ACTIVE");
    for (const host of hosts) {
     if (!host.isAlive()) throw new Error("UPDATE_RUNTIME_UNKNOWN");
     // Include uncertain pause acknowledgements in the resume set.
     paused.push(host);
     if (await host.controlClose("pause")) throw new UpdateCoordinatorError("UPDATE_WORK_ACTIVE");
    }
    if (deps.busy()) throw new UpdateCoordinatorError("UPDATE_WORK_ACTIVE");
    backup = await deps.backup();
    // A partial marker write is ambiguous: keep admission blocked until its cleanup succeeds.
    recoveryMarked = true;
    await deps.markRecovery(backup);
    // Recheck immediately before closing hosts, including work arriving while backing up.
    if (deps.busy()) throw new UpdateCoordinatorError("UPDATE_WORK_ACTIVE");
    destructiveBoundary = true;
    for (const host of paused) {await host.close(); if (host.isAlive()) throw new Error("UPDATE_RUNTIME_UNKNOWN");}
    deps.clearClosedHosts();
    phase = "installing";
    failure = "UPDATE_INSTALL_FAILED";
    await deps.install(backup);
    await deps.clearRecovery();
    recoveryMarked = false;
    // Old main/renderer code must never admit work against the newly installed state.
    phase = "restart-required";
   } catch (error) {
    if (error instanceof UpdateCoordinatorError) failure = error.code;
    if (destructiveBoundary) {
     // Closing even one host makes resuming the old process unsafe. Restore, then restart.
     try {
      for (const host of paused) if (host.isAlive()) {await host.close(); if (host.isAlive()) throw new Error("UPDATE_RUNTIME_UNKNOWN");}
      deps.clearClosedHosts();
      await deps.recover(backup!);
      await deps.clearRecovery();
      recoveryMarked = false;
      phase = "restart-required";
     } catch {phase = "recovery-required"; failure = "UPDATE_RECOVERY_REQUIRED";}
    } else {
     let safe = true;
     if (recoveryMarked) {
      try {await deps.clearRecovery(); recoveryMarked = false;}
      catch {safe = false;}
     }
     // A missing pause ack is not permission to proceed; resume must be confirmed as well.
     for (const host of paused) {
      try {if (!host.isAlive()) throw new Error(); await host.controlClose("resume");}
      catch {safe = false;}
     }
     phase = safe ? "idle" : "recovery-required";
     if (!safe) failure = "UPDATE_RECOVERY_REQUIRED";
    }
    throw new UpdateCoordinatorError(failure);
   }
  },
 };
}
