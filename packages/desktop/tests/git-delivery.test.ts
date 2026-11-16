import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { openGitDelivery } from "../src/git-delivery.js";
const git = (repo: string, args: string[]) => execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
async function fixture() { const root = await mkdtemp("/tmp/har-delivery-"), repo = root + "/repo"; await mkdir(repo); git(repo, ["init", "-q", "-b", "main"]); git(repo, ["config", "user.name", "Fixture"]); git(repo, ["config", "user.email", "fixture@example.invalid"]); await writeFile(repo + "/a.txt", "base\n"); git(repo, ["add", "a.txt"]); git(repo, ["commit", "-qm", "base"]); const manager = await openGitDelivery(repo, root + "/delivery"); return { root, repo, manager, close: () => rm(root, { recursive: true, force: true }) }; }
test("reviewed commit binds the whole staged selection and preserves unstaged and foreign files", async () => {
    const f = await fixture(); try {
        await writeFile(f.repo + "/a.txt", "staged\n"); git(f.repo, ["add", "a.txt"]); await writeFile(f.repo + "/a.txt", "unstaged\n"); await writeFile(f.repo + "/foreign.txt", "untouched\n");
        const review = await f.manager.reviewCommit({ paths: ["a.txt"], message: "Reviewed change" }); expect(review.files).toEqual([{ path: "a.txt", before: "base\n", after: "staged\n", beforeMode: "100644", afterMode: "100644" }]); expect(review.destination).toBe("local");
        const first = await f.manager.commit(review.ticketId); expect(first.status).toBe("completed"); expect(git(f.repo, ["show", "HEAD:a.txt"])).toBe("staged"); expect(await readFile(f.repo + "/a.txt", "utf8")).toBe("unstaged\n"); expect(await readFile(f.repo + "/foreign.txt", "utf8")).toBe("untouched\n"); expect(git(f.repo, ["diff", "--cached", "--name-only"])).toBe("");
        expect(await f.manager.commit(review.ticketId)).toEqual(first); const reopened = await openGitDelivery(f.repo, f.root + "/delivery"); expect(await reopened.commit(review.ticketId)).toEqual(first); expect(git(f.repo, ["rev-list", "--count", "HEAD"])).toBe("2");
        // Model a crash after update-ref but before recording completion.
        await writeFile(f.root + `/delivery/${first.id}.json`, JSON.stringify({ ...first, status: "prepared" })); expect((await reopened.reconcile(first.id)).status).toBe("completed"); expect(git(f.repo, ["rev-list", "--count", "HEAD"])).toBe("2");
    } finally { await f.close(); }
});
// Keep independent Git scenarios below Bun's per-test deadline on hosted macOS.
// Each case still verifies that no commit was produced.
test("foreign staged files never produce a commit", async () => {
    const f = await fixture(); try {
        await writeFile(f.repo + "/a.txt", "one\n"); await writeFile(f.repo + "/b.txt", "foreign\n"); git(f.repo, ["add", "a.txt", "b.txt"]);
        await expect(f.manager.reviewCommit({ paths: ["a.txt"], message: "bad" })).rejects.toThrow("GIT_STAGED_SELECTION_MISMATCH");
        expect(git(f.repo, ["rev-list", "--count", "HEAD"])).toBe("1");
    } finally { await f.close(); }
});
test("changed review invalidates its ticket without producing a commit", async () => {
    const f = await fixture(); try {
        await writeFile(f.repo + "/a.txt", "one\n"); await writeFile(f.repo + "/b.txt", "foreign\n"); git(f.repo, ["add", "a.txt", "b.txt"]);
        const review = await f.manager.reviewCommit({ paths: ["a.txt", "b.txt"], message: "both" });
        await writeFile(f.repo + "/a.txt", "changed\n"); git(f.repo, ["add", "a.txt"]);
        await expect(f.manager.commit(review.ticketId)).rejects.toThrow("GIT_REVIEW_CHANGED");
        await expect(f.manager.commit(review.ticketId)).rejects.toThrow("GIT_REVIEW_REQUIRED");
        expect(git(f.repo, ["rev-list", "--count", "HEAD"])).toBe("1");
    } finally { await f.close(); }
});
test("an existing index lock is preserved and never produces a commit", async () => {
    const f = await fixture(); try {
        await writeFile(f.repo + "/a.txt", "changed\n"); await writeFile(f.repo + "/b.txt", "foreign\n"); git(f.repo, ["add", "a.txt", "b.txt"]);
        const current = await f.manager.reviewCommit({ paths: ["a.txt", "b.txt"], message: "both" });
        await writeFile(f.repo + "/.git/index.lock", "other owner");
        await expect(f.manager.commit(current.ticketId)).rejects.toThrow();
        expect(await readFile(f.repo + "/.git/index.lock", "utf8")).toBe("other owner");
        expect(git(f.repo, ["rev-list", "--count", "HEAD"])).toBe("1");
    } finally { await f.close(); }
});
test("secret paths, known values, binary previews and conflicts are rejected before projection", async () => {
    const f = await fixture(); try {
        await writeFile(f.repo + "/.env", "ordinary text"); git(f.repo, ["add", ".env"]); await expect(f.manager.reviewCommit({ paths: [".env"], message: "no" })).rejects.toThrow("GIT_DELIVERY_PATH_BLOCKED"); git(f.repo, ["reset", "-q", "HEAD", "--", ".env"]);
        await writeFile(f.repo + "/a.txt", "private-fixture-credential"); git(f.repo, ["add", "a.txt"]); const secrets = await openGitDelivery(f.repo, f.root + "/secret-delivery", ["private-fixture-credential"]); await expect(secrets.reviewCommit({ paths: ["a.txt"], message: "no" })).rejects.toThrow("GIT_DELIVERY_SECRET_DETECTED");
        await writeFile(f.repo + "/a.txt", Buffer.from([0, 1, 2])); git(f.repo, ["add", "a.txt"]); await expect(f.manager.reviewCommit({ paths: ["a.txt"], message: "no" })).rejects.toThrow("GIT_PREVIEW_INCOMPLETE");
        await writeFile(f.repo + "/.git/MERGE_HEAD", git(f.repo, ["rev-parse", "HEAD"])); await expect(f.manager.reviewCommit({ paths: ["a.txt"], message: "no" })).rejects.toThrow("GIT_OPERATION_IN_PROGRESS"); expect(git(f.repo, ["rev-list", "--count", "HEAD"])).toBe("1");
    } finally { await f.close(); }
});
test("repository hooks and diff drivers do not execute during review or commit", async () => {
    const f = await fixture(); try {
        const marker = f.root + "/executed"; for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) { const file = f.repo + "/.git/hooks/" + name; await writeFile(file, `#!/bin/sh\necho bad > '${marker}'\n`); await chmod(file, 0o755); }
        await writeFile(f.repo + "/.gitattributes", "*.txt diff=hostile\n"); git(f.repo, ["add", ".gitattributes"]); git(f.repo, ["config", "diff.hostile.command", `sh -c 'echo bad > ${marker}'`]); await writeFile(f.repo + "/a.txt", "safe\n"); git(f.repo, ["add", "a.txt"]);
        const review = await f.manager.reviewCommit({ paths: ["a.txt", ".gitattributes"], message: "safe" }); expect((await f.manager.commit(review.ticketId)).status).toBe("completed"); await expect(readFile(marker)).rejects.toThrow();
    } finally { await f.close(); }
});
test("old review cannot survive restart or authorize a changed branch head", async () => {
    const f = await fixture(); try {
        await writeFile(f.repo + "/a.txt", "staged\n"); git(f.repo, ["add", "a.txt"]); const old = await f.manager.reviewCommit({ paths: ["a.txt"], message: "review" }); const reopened = await openGitDelivery(f.repo, f.root + "/delivery"); await expect(reopened.commit(old.ticketId)).rejects.toThrow("GIT_REVIEW_REQUIRED");
        git(f.repo, ["commit", "--allow-empty", "-qm", "other client"]); await expect(f.manager.commit(old.ticketId)).rejects.toThrow(); expect(git(f.repo, ["rev-list", "--count", "HEAD"])).toBe("2");
    } finally { await f.close(); }
});
test("explicit staging preserves existing staged content and skips protected files", async () => {
    const f = await fixture(); try {
        await writeFile(f.repo + "/a.txt", "staged first\n"); git(f.repo, ["add", "a.txt"]); await writeFile(f.repo + "/a.txt", "later unstaged\n"); await writeFile(f.repo + "/b.txt", "selected\n"); await writeFile(f.repo + "/foreign.txt", "do not stage\n"); await writeFile(f.repo + "/.env", "secret\n");
        const listing = await f.manager.changes(); expect(listing.blocked).toBe(1); expect(listing.files.some(file => file.path === ".env")).toBe(false);
        await expect(f.manager.stage(["a.txt"])).rejects.toThrow("GIT_STAGED_CONTENT_PRESERVED"); await f.manager.stage(["b.txt"]); expect(git(f.repo, ["show", ":a.txt"])).toBe("staged first"); expect(git(f.repo, ["show", ":b.txt"])).toBe("selected"); expect(git(f.repo, ["diff", "--cached", "--name-only"])).toBe("a.txt\nb.txt"); expect(await readFile(f.repo + "/a.txt", "utf8")).toBe("later unstaged\n");
    } finally { await f.close(); }
});
test("staging reads literal bytes without clean filters and atomically rejects unsafe selection", async () => {
    const f = await fixture(); try {
        const marker = f.root + "/executed"; await writeFile(f.repo + "/.gitattributes", "*.txt filter=hostile\n"); git(f.repo, ["config", "filter.hostile.clean", `sh -c 'echo bad > ${marker}; cat'`]); git(f.repo, ["config", "filter.hostile.required", "true"]); await writeFile(f.repo + "/a.txt", "literal\n"); await writeFile(f.repo + "/b.txt", Buffer.from([0, 1])); const index = await readFile(f.repo + "/.git/index");
        await expect(f.manager.stage(["a.txt", "b.txt"])).rejects.toThrow("GIT_PREVIEW_INCOMPLETE"); expect(await readFile(f.repo + "/.git/index")).toEqual(index); await f.manager.stage(["a.txt"]); expect(git(f.repo, ["show", ":a.txt"])).toBe("literal"); await expect(readFile(marker)).rejects.toThrow();
    } finally { await f.close(); }
});
test("staging deleted files only removes the selected index entry", async () => {
    const f = await fixture(); try {
        await rm(f.repo + "/a.txt"); await f.manager.stage(["a.txt"]); expect(git(f.repo, ["diff", "--cached", "--name-status"])).toBe("D\ta.txt"); const review = await f.manager.reviewCommit({ paths: ["a.txt"], message: "Remove reviewed file" }); expect(review.files[0]!.after).toBe(""); expect((await f.manager.commit(review.ticketId)).status).toBe("completed");
    } finally { await f.close(); }
});
