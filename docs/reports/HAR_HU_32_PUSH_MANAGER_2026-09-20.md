# HU32 — reviewed push manager and GitHub transport, in progress

This increment implements host-side push admission and reconciliation. It is not
yet connected to main/preload/UI and is not a packaged desktop capability. PR
creation and remote user journeys remain open. No HU32 criterion is closed here.

A review binds the selected remote name, canonical GitHub HTTPS URL, destination
ref and existing base ref to the local branch/head, remote head/base, new commit
history, commit messages and complete per-parent before/after file contents/modes.
New branches are reviewed relative to the declared remote base, rather than
assuming the whole repository is unpublished. Merge commits include each parent
comparison. Divergence and staged content refuse admission; malformed destinations,
protected paths, binary/incomplete previews and detected secret history refuse
projection. Bounds are 100 commits, 100 files per commit, 256 KiB per blob and
2 MiB per review; larger deliveries require a smaller reviewed increment. Known
host-sensitive values and recognized patterns are checked; this is not universal
secret detection.

One-use five-minute reviews are revalidated immediately before durable admission.
The operation record is fsynced before sending. The transport pushes one exact SHA
to one ref with ordinary Git semantics, without force, mirror, tags, hooks or
repository-defined refspecs. A concurrent divergent update is rejected by Git and
preserved. An ambiguous response triggers only a remote read. Repeated operation
IDs and restart reconcile the stored operation without another push. Unconfirmed
outcomes remain pending, including when the remote cannot be read. Completed
records report historical success, not a claim about the remote's current tip.

The production adapter supports GitHub HTTPS URLs configured as the sole push URL
of a named remote. It uses the host's existing `gh auth git-credential` integration;
credentials stay inside Git/gh and never enter review snapshots. Network commands
run in a private temporary bare repository with an object alternate pointing at
the source object store. They do not load the source repository's URL rewrites,
URL-specific headers, proxies, credential helpers or mirror settings. Global/system
Git config is excluded; TLS verification is required and redirects are disabled.
Read-only object fetches stay in that private store and do not update source refs
or FETCH_HEAD. Callers must close the transport to remove its private temporary
store; main lifecycle integration is still pending. SSH, enterprise hosts and
custom proxy/auth configurations are not declared supported by this adapter.

Validation: six tests with 50 assertions pass; desktop typecheck passes. Manager
tests use real Git repositories and a temporary local bare remote to verify exact
SHA publication, lost-response reconciliation, restart, immutable accepted state,
divergence, staged/secret/path refusal, offline ambiguity and a racing divergent
push without force or replay. The GitHub adapter test uses real local Git object
inspection with intercepted network commands: it proves history/diff extraction,
configuration isolation, exact non-forced refspec, changed-remote rejection and
private-store cleanup. It does not contact GitHub or prove live authentication.

Remaining: remote selection and push review UI, main/runtime/shutdown coordination,
packaged offline fault journeys, PR review/create/reconcile behavior and declared
credential/setup UX. The repository branch `feat/harness-desktop` was not pushed;
all actual test pushes targeted disposable local bare repositories.
