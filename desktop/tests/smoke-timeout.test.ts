import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("smoke bounds an unresponsive renderer and its failure snapshot, then exits naturally", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "desktop-smoke-timeout-"));
    // Isolate the Electron stub: it must never affect other Desktop tests.
    const source = `
        import { mock } from "bun:test";
        mock.module("electron", () => ({ app: {} }));
        const { verifyDesktopSmoke } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/smoke-verification.ts"))});
        const window = { webContents: { executeJavaScript: () => new Promise(() => {}) } };
        try {
            await verifyDesktopSmoke(window, new Map(), ${JSON.stringify(directory)});
            process.exitCode = 2;
        } catch (error) {
            if (error.message !== "RENDERER_OPERATION_TIMEOUT") throw error;
            console.log("bounded-renderer-timeout");
        }
    `;
    const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
    try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        expect(stdout.trim()).toBe("bounded-renderer-timeout");
        expect(await readFile(path.join(directory, "failure-script.txt"), "utf8")).toContain("data-ready");
        expect(await readFile(path.join(directory, "failure-view.txt"), "utf8")).toBe("Renderer unavailable while capturing failure context.");
        expect(JSON.parse(await readFile(path.join(directory, "progress.json"), "utf8")).phases.map((phase: { phase: string }) => phase.phase)).toEqual(["renderer-startup"]);
    } finally {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
        await rm(directory, { recursive: true, force: true });
    }
}, 30000);
