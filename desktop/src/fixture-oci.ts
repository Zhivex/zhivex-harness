import type { HarnessOciRuntimeAdapter } from "../../src/internal/desktop/runtime.js";
/** Test-only boundary adapter. It does not claim container isolation or Docker evidence. */
export function fixtureOciRuntime(): HarnessOciRuntimeAdapter {
    return {
        async inspectImage(imageReference) { const imageDigest = "sha256:" + "a".repeat(64); return { runtime: "docker", runtimeVersion: "desktop-fixture", imageReference, imageId: imageDigest, imageDigest }; }, async run(request) {
            if (JSON.stringify(request.command) !== JSON.stringify(["node", "-e", "process.exit(0)"])) throw new Error("UNEXPECTED_FIXTURE_COMMAND");
            return { command: request.command, exitCode: 0, stdout: "fixture verifier receipt", stderr: "", timedOut: false, cancelled: false, outputLimitExceeded: false };
        }, async removeRunContainers() { return 0; }, async cleanupOrphans() { return 0; }
    };
}
