import { expect, test } from "bun:test";
import { formatConsoleWelcome, ZHIVEX_TERMINAL_LOGO } from "../src/console-welcome.js";
import { formatConsoleHelp, searchConsoleCommands } from "../src/console-commands.js";
import { parseCliArgs } from "../src/cli.js";

test("welcome escapes project metadata and adapts to narrow, colorless terminals", () => {
 const rendered = formatConsoleWelcome({version:"1",workspace:"/tmp/project\x1b[2J",sessionId:"s",provider:"qwen",model:"example"},{color:false,columns:80});
 const logoLines = ZHIVEX_TERMINAL_LOGO.split("\n");
 expect(rendered.split("\n").slice(0, logoLines.length).map((line, index) => line.slice(0, logoLines[index]!.length)).join("\n")).toBe(ZHIVEX_TERMINAL_LOGO);
 expect(rendered.split("\n")[3]).toContain("   Zhivex Harness 1");
 expect(rendered.split("\n")[7]).toContain("session s");
 expect(rendered).toContain("Welcome");
 expect(rendered).toContain("qwen/example");
 expect(rendered).toContain("\\u001b[2J");
 expect(rendered).not.toContain("\x1b");
 expect(formatConsoleWelcome({version:"1",workspace:"project",service:true},{color:false,columns:30})).toContain("( Z )");
 expect(formatConsoleWelcome({version:"1",workspace:"project"},{color:false,columns:30}).split("\n")[0]).toBe("( Z )   Zhivex Harness 1");
 expect(formatConsoleWelcome({version:"1",workspace:"project"},{color:false,columns:20}).split("\n").slice(0,2)).toEqual(["( Z )", "Zhivex Harness 1"]);
 expect(formatConsoleWelcome({version:"1",workspace:"project",service:true},{color:false})).toContain("managed by host");
});

test("service help and search expose only supported commands", () => {
 expect(formatConsoleHelp("service")).not.toContain("/model");
 expect(searchConsoleCommands("/provider","service")).toHaveLength(0);
 expect(searchConsoleCommands("/conversation","service").map(([name])=>name)).toContain("/sessions");
 expect(formatConsoleHelp()).not.toContain("/cancel");
});

test("short console resume aliases preserve one-shot and machine contracts", () => {
 expect(parseCliArgs(["--continue"])).toMatchObject({command:"chat",continueSession:true});
 expect(parseCliArgs(["--session","session_a"])).toMatchObject({command:"chat",sessionId:"session_a"});
 expect(parseCliArgs(["a task"])).toMatchObject({command:"run",prompt:"a task"});
 expect(()=>parseCliArgs(["run","--continue"])).toThrow();
 expect(()=>parseCliArgs(["--json","--continue"])).toThrow();
});
