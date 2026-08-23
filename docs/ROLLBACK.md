# Release rollback and recovery

Published npm versions and Git tags are immutable. Never delete or reuse a version/tag and never rebuild bytes under the same version. Preserve the failing artifact, checksum, provenance, workflow URL, provider evidence, and incident notes.

For a defective prerelease, leave the version on the registry, deprecate it through an authorized protected operation, publish a forward-fix RC, and move `next` only after the replacement passes the full gate. For a defective stable release, prefer a forward-fix patch. Moving `latest` back is an emergency distribution-pointer change, not deletion or state rollback, and requires an explicit protected operator action plus verification of the exact prior artifact.

Before running an older harness against existing state, inspect the migration notes and schema/fingerprint compatibility. Terminal history may remain readable while active or waiting approvals are not resumable. Complete or deny an old paused approval only with the exact artifact and policy context that created it. Never rewrite fingerprints to make an incompatible approval resume.

Registry propagation failures are recovered by rerunning only the failed protected publish job when it proves the already-published bytes are identical. Do not introduce a long-lived npm token as a fallback for OIDC.
