import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, chmod, access } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve(import.meta.dir, ".."), packaged = process.argv.includes("--packaged");
const output = await mkdtemp("/tmp/har-tasks-"), workspace = path.join(output, "repo"), report = path.join(output, "report"); await mkdir(workspace); await mkdir(report);
const env = { PATH: process.env.PATH!, HOME: output, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (args: string[]) => execFileSync("git", ["-C", workspace, ...args], { env, encoding: "utf8" });
git(["init", "-q"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.test"]); await writeFile(path.join(workspace, "review.txt"), "baseline\n"); git(["add", "review.txt"]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "baseline"]);
await writeFile(path.join(workspace, "review.txt"), "staged original\n"); git(["add", "review.txt"]); await writeFile(path.join(workspace, "review.txt"), "unstaged original\n"); await writeFile(path.join(workspace, "untracked.txt"), "preserve\n");
const status = git(["status", "--porcelain=v1"]), index = await readFile(path.join(workspace, ".git/index"));
// The application sees a GitHub-shaped configured URL, while this host-only
// executable shim routes network commands exclusively to a disposable local bare.
const remote = path.join(output, "remote.git"), bin = path.join(output, "bin"), pushTrace = path.join(output, "push-trace"), transportTrace = path.join(output, "transport-trace"); await mkdir(bin); git(["init", "--bare", "-q", remote]); git(["push", remote, "HEAD:refs/heads/main"]); git(["remote", "add", "origin", "https://github.com/fixture/repository.git"]);
await writeFile(path.join(bin, "git"),`#!/bin/bash
args=(); routed=0; pushing=0
for item in "$@"; do
 if [ "$item" = "https://github.com/fixture/repository.git" ]; then args+=("${remote}"); routed=1; else args+=("$item"); fi
 if [ "$item" = push ]; then pushing=1; fi
done
if [ "$routed" = 1 ]; then printf '%s\\n' "$2" >> "${transportTrace}"; fi
if [ "$routed" = 1 ] && [ "$pushing" = 1 ]; then printf 'push\\n' >> "${pushTrace}"; fi
if [ "$routed" = 1 ]; then exec /usr/bin/git -c protocol.file.allow=always "\${args[@]}"; else exec /usr/bin/git "\${args[@]}"; fi
`); await chmod(path.join(bin, "git"), 0o755); env.PATH = bin + ":" + env.PATH;

const prStore=path.join(output,"pr-store.json"),prTrace=path.join(output,"pr-posts");
await writeFile(prStore,"[]",{mode:0o600});
await writeFile(path.join(bin,"gh"),`#!${process.execPath}
import fs from "node:fs";
import {execFileSync} from "node:child_process";
const args=process.argv.slice(2), store=${JSON.stringify(prStore)}, trace=${JSON.stringify(prTrace)}, remote=${JSON.stringify(remote)};
if(args[0]!=="api")process.exit(2);
const method=args[args.indexOf("--method")+1],endpoint=args.at(-1),rows=JSON.parse(fs.readFileSync(store,"utf8"));
if(method==="POST"){
 const input=JSON.parse(await Bun.stdin.text()), number=rows.length+1;
 const sha=ref=>execFileSync("/usr/bin/git",["--git-dir",remote,"rev-parse","refs/heads/"+ref],{encoding:"utf8"}).trim();
 rows.push({number,html_url:"https://github.com/fixture/repository/pull/"+number,title:input.title,body:input.body,draft:input.draft,state:"open",head:{sha:sha(input.head),ref:input.head,repo:{full_name:"fixture/repository"}},base:{sha:sha(input.base),ref:input.base,repo:{full_name:"fixture/repository"}}});
 fs.writeFileSync(store,JSON.stringify(rows));fs.appendFileSync(trace,"POST\\n");process.exit(1);
}
const query=new URL(endpoint,"https://api.github.com").searchParams,head=query.get("head")?.split(":").slice(1).join(":"),base=query.get("base");
process.stdout.write("HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n"+JSON.stringify(rows.filter(row=>row.head.ref===head&&row.base.ref===base)));
`);await chmod(path.join(bin,"gh"),0o755);
const executable = packaged ? path.join(root, "out/Zhivex Harness-darwin-arm64/Zhivex Harness.app/Contents/MacOS/Zhivex Harness") : path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const phases = [];
for (const phase of ["tasks-create", "tasks-reopen"]) {
    const child = spawn(executable, [...(packaged ? [] : [root]), ...(phase === "tasks-create" ? ["--workspace", workspace] : []), "--smoke-test", "--fixture-drop-git-response", "--fixture-drop-push-response", "--fixture-drop-pr-response", "--fixture-restart-phase", phase, "--report-directory", report], { cwd: output, env, stdio: ["ignore", "pipe", "pipe"] }); let stderr = ""; child.stderr.on("data", chunk => stderr += chunk); child.stdout.resume(); const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    try { const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); assert.equal(code, 0, `${phase}: ${stderr}`); const evidence = JSON.parse(await readFile(path.join(report, `${phase}-report.json`), "utf8")); assert.equal(evidence.packaged, packaged); for (const pid of [evidence.appPid, ...evidence.runtimePids]) assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH"); phases.push(evidence); } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
 const prs=JSON.parse(await readFile(prStore,"utf8"));assert.equal(prs.length,1);assert.equal((await readFile(prTrace,"utf8")).trim(),"POST");assert.equal(JSON.parse(await readFile(path.join(report,"opened-pr.json"),"utf8")).url,prs[0].html_url);
    const checkpoint = JSON.parse(await readFile(path.join(report, "tasks-checkpoint.json"), "utf8")); assert.equal(git(["rev-list", "--count", checkpoint[0].task.branch]).trim(), "2"); assert.equal(git(["rev-list", "--count", checkpoint[1].task.branch]).trim(), "1"); assert.equal(git(["rev-list", "--count", "HEAD"]).trim(), "1");
    for (const directory of new Set((await readFile(transportTrace, "utf8")).trim().split("\n"))) await access(directory).then(() => assert.fail("Temporary network store survived shutdown"), error => assert.equal(error.code, "ENOENT"));
    assert.equal(execFileSync("/usr/bin/git", ["--git-dir", remote, "rev-parse", `refs/heads/${checkpoint[0].task.branch}`], { env, encoding: "utf8" }).trim(), git(["rev-parse", checkpoint[0].task.branch]).trim()); assert.equal((await readFile(pushTrace, "utf8")).trim(), "push");
    assert.equal(await readFile(path.join(workspace, "review.txt"), "utf8"), "unstaged original\n"); assert.equal(await readFile(path.join(workspace, "untracked.txt"), "utf8"), "preserve\n"); assert.deepEqual(await readFile(path.join(workspace, ".git/index")), index);
}
assert.equal(git(["status", "--porcelain=v1"]).split("\n").filter(line => !line.includes(".zhivex-harness")).join("\n"), status);
const evidence = { schemaVersion: 1, packaged, fixture: true, originalChangesPreserved: true, concurrentTaskIsolation: true, singleReviewedCommit: true, singleReviewedPush:true,singleReviewedPullRequest:true,verifiedPrLink:true, networkStoresRemoved: true, originalBranchUnchanged: true, wholeAppRestart: true, reviewedCleanup: true, workersExited: true, phases, evidenceDirectory: report }; await writeFile(path.join(report, "report.json"), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
