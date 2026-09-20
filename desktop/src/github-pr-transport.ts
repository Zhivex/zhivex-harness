import { spawn } from "node:child_process";
import os from "node:os";
import { z } from "zod";
import { pushDestinationSchema, type PushDestination, type PushSnapshot } from "./remote-delivery.js";
import { PullRequestRejectedError, pullRequestRecordSchema, type PullRequestRecord, type PullRequestTransport } from "./pr-delivery.js";
const githubRecord = z.object({ number: z.number().int().positive(), html_url: z.string(), title: z.string(), body: z.string().nullable(), draft: z.boolean(), state: z.enum(["open", "closed"]), head: z.object({ sha: z.string(), ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }), base: z.object({ sha: z.string(), ref: z.string(), repo: z.object({ full_name: z.string() }) }) });

/** Explicit REST endpoints and stdin JSON; gh retains the host's credentials. */
export function openGitHubPullRequestTransport(git: { inspectPullRequest(destination: PushDestination): Promise<PushSnapshot> }): PullRequestTransport {
    const repository = (value: PushDestination) => { const destination = pushDestinationSchema.parse(value); return new URL(destination.url).pathname.slice(1).replace(/\.git$/, ""); };
    const api = (method: "GET" | "POST", endpoint: string, body?: unknown): Promise<unknown> => new Promise((resolve, reject) => {
        const child = spawn("gh", ["api", "--include", "--hostname", "github.com", "--method", method, "--header", "Accept: application/vnd.github+json", "--header", "X-GitHub-Api-Version: 2026-03-10", ...(body === undefined ? [] : ["--input", "-"]), endpoint], { cwd: os.tmpdir(), env: { PATH: process.env.PATH, HOME: process.env.HOME, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" }, stdio: ["pipe", "pipe", "pipe"] }); let output = "", bytes = 0, failed = false;
        const timer = setTimeout(() => { failed = true; child.kill("SIGTERM"); }, 30000); child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > 4 * 1024 * 1024) { failed = true; child.kill("SIGTERM"); } else output += chunk; }); child.stderr.resume(); child.stdin.on("error", () => { });
        child.once("error", () => { clearTimeout(timer); reject(new Error("PR_API_UNAVAILABLE")); }); child.once("close", code => { clearTimeout(timer); const status = /^HTTP\/\S+ (\d{3})/.exec(output), separator = /\r?\n\r?\n/.exec(output); if (!failed && status && [400, 401, 403, 404, 422].includes(Number(status[1]))) { reject(new PullRequestRejectedError()); return; } if (code !== 0 || failed) { reject(new Error("PR_API_UNAVAILABLE")); return; } try { if (!status || !separator || Number(status[1]) < 200 || Number(status[1]) >= 300) throw new Error("INVALID_STATUS"); resolve(JSON.parse(output.slice(separator.index + separator[0].length))); } catch { reject(new Error("PR_API_RESPONSE_INVALID")); } }); child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const normalize = (raw: unknown, destination: PushDestination): PullRequestRecord => { const parsed = githubRecord.parse(raw), name = repository(destination); if (parsed.head.repo?.full_name !== name || parsed.base.repo.full_name !== name || parsed.head.ref !== destination.ref.slice(11) || parsed.base.ref !== destination.baseRef.slice(11) || parsed.html_url !== `https://github.com/${name}/pull/${parsed.number}`) throw new Error("PR_RESPONSE_MISMATCH"); return pullRequestRecordSchema.parse({ number: parsed.number, url: parsed.html_url, head: parsed.head.sha, base: parsed.base.sha, headRef: parsed.head.ref, baseRef: parsed.base.ref, title: parsed.title, body: parsed.body ?? "", draft: parsed.draft, state: parsed.state }); };
    return {
        inspect: destination => git.inspectPullRequest(destination),
        async list(destination) {
            const name = repository(destination), owner = name.split("/")[0]!, result: PullRequestRecord[] = [];
            for (let page = 1; page <= 10; page++) { const query = new URLSearchParams({ state: "all", head: `${owner}:${destination.ref.slice(11)}`, base: destination.baseRef.slice(11), sort: "created", direction: "asc", per_page: "100", page: String(page) }); const response = await api("GET", `repos/${name}/pulls?${query}`); if (!Array.isArray(response) || response.length > 100) throw new Error("PR_API_RESPONSE_INVALID"); for (const raw of response) { const parsed = githubRecord.parse(raw); if (parsed.head.repo?.full_name !== name) continue; result.push(normalize(raw, destination)); } if (response.length < 100) return result.sort((a, b) => a.number - b.number); }
            throw new Error("PR_HISTORY_LIMIT");
        },
        async create(input) { const name = repository(input.destination); const result = await api("POST", `repos/${name}/pulls`, { title: input.title, body: input.body, head: input.destination.ref.slice(11), base: input.destination.baseRef.slice(11), draft: input.draft, maintainer_can_modify: false }); return normalize(result, input.destination); }
    };
}
