# Reviewed workspace checkpoints

`openWorkspaceCheckpointStore(workspace, sessionStore)` provides an opt-in library API for restoring **1–20 explicitly selected, existing UTF-8 text files**, each at most 64 KiB, together with a fork of a terminal conversation turn. It stores snapshots and recovery records in the existing private session database, bound to the workspace and tenant scope. Original conversations remain intact.

This is not a whole-repository snapshot. Creation, deletion, binary files, symlinks, hard-linked files, sensitive paths and changed permission modes are unsupported. Files outside the explicitly captured set are never restored. Capture should run at the selected terminal turn, before subsequent agent changes; the API cannot prove that arbitrary files historically belonged to that conversation turn.

## Operator flow

1. Call `capture({ sessionId, turnId, paths })` at the desired restore point.
2. Keep the final file digests from the subsequent agent operation. Call `prepareRestore(checkpoint.id, expectedCurrentDigests)` with those digests. Do not silently substitute newly read digests after a conflict: that could include user edits.
3. Present the returned proposal (paths, old/current digest and replacement content) to the operator.
4. On explicit review, call `applyRestore(operation.id, operation.proposalId)`. This trusted host API is not exposed as a model tool. A proposal ID binds the reviewed bytes; possession of it is not itself an authorization system, so the integrating host must enforce operator review.
5. Continue using `forkSessionId` from the completed operation. Retrying the same completed operation returns its historical completion without altering files again.

Capture, preparation and restore share the workspace mutation lock with existing edits. Restore rechecks exact content digests and modes before applying through `Workspace.applyPatchWithModes`. Other writers that bypass the harness lock remain outside the cooperative locking contract; the normal edit preconditions still apply.

## Interruption recovery

`getOperation(id)` exposes the durable journal stages: `prepared`, `forking`, `forked`, `applying`, `applied`, `completed`.

The conversation is forked first. A failure after forking can leave an unused child conversation while files remain unchanged. A crash in the `forking` window has an uncertain outcome: inspect sessions with the title `restore:<operation id>`, then call `recoverFork(operation.id, exactChildSessionId)`. This validates the parent and branch turn. Never create a second fork blindly. If no child exists, abandon the old operation and prepare a new restore; no filesystem change happened in that stage.

After interruption in `applying`, retry checks every captured file. If all have the checkpoint digests, it completes the journal without replaying edits. If all still have the reviewed precondition digests, it retries the same patch. Mixed or unrelated contents cause a conflict requiring manual recovery; subsequent user edits are not overwritten. An `applied` record with different current content also conflicts.

There is no single transaction spanning SQLite and filesystem updates. Journaling exposes that boundary and makes recovery conservative. An interrupted partial filesystem update is detected, not automatically rolled back.

Snapshot storage is bounded to 100 records per workspace/scope (captures and restores combined), 2 MiB per record. There is currently no automatic eviction or checkpoint deletion API. Portable state export/import preserves captures and completed restore records with workspace/scope and conversation lineage validation. Unfinished restore operations block export and import because their filesystem recovery state and reviewed authorization are local to the original database. Older bundles without checkpoint records remain readable. Close the checkpoint store before state maintenance or update operations.
