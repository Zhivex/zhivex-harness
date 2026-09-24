import { expect, test } from "bun:test";
import { TerminalMarkdown } from "../src/cli/terminal/terminal-markdown.js";

test("delivers partial lines during provider pauses and flushes without replay", async () => {
  let output = "";
  const renderer = new TerminalMarkdown((text) => { output += text; }, false);
  renderer.write("Partial\u001b");
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(output).toBe("Partial\\u001b");
  renderer.write("[2J remainder");
  renderer.flush();
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(output).toBe("Partial\\u001b[2J remainder");
});

test("renders fragmented headings and fenced code without terminal injection", () => {
  let output = "";
  const renderer = new TerminalMarkdown((text) => { output += text; }, true);
  for (const delta of ["## Su", "mmary\n```js\n", "const x = '\u001b", "[2J';\n```\n**Done**", " with `x`."]) renderer.write(delta);
  renderer.flush();
  expect(output).toContain("\u001b[1mSummary\u001b[0m");
  expect(output).toContain("\\u001b[2J");
  expect(output).not.toContain("\u001b[2J");
  expect(output).toContain("\u001b[1mDone\u001b[0m");
});

test("bounds unfinished lines and honors no-color output", () => {
  let output = "";
  const renderer = new TerminalMarkdown((text) => { output += text; }, false);
  renderer.write("x".repeat(2048));
  expect(output.length).toBe(2048);
  renderer.write("\n# Heading\n`code`\n");
  renderer.flush();
  expect(output).toContain("Heading\n`code`");
  expect(output).not.toContain("\u001b");
});


test("formatting survives provider pauses and markers split across frames", async () => {
 let output = "";
 const renderer = new TerminalMarkdown(text => {output += text;}, true);
 renderer.write("**Hel"); await new Promise(resolve => setTimeout(resolve,40));
 expect(output).toBe("");
 renderer.write("lo*"); await new Promise(resolve => setTimeout(resolve,40));
 renderer.write("* and `co"); await new Promise(resolve => setTimeout(resolve,40));
 renderer.write("de`."); renderer.flush();
 expect(output.replace(/\x1b\[[0-9;]*m/g, "")).toBe("Hello and code.");
 expect(output).toContain("\x1b[1mHello\x1b[0m");
 expect(output).toContain("\x1b[36mcode\x1b[0m");
});


test("preserves Unicode split between provider frames", async () => {
 const chunks:string[]=[];
 const renderer=new TerminalMarkdown(text=>{chunks.push(text);},true);
 renderer.write("A \uD83D"); await new Promise(resolve=>setTimeout(resolve,40));
 expect(chunks.join("")).toBe("A ");
 renderer.write("\uDE42 listo");renderer.flush();
 expect(chunks.join("")).toBe("A 🙂 listo");
});

for (const text of ["prefix `unfinished", "prefix **unfinished", "a lone *", "**", "`"]) test(`final flush preserves unmatched markup: ${text}`, async () => {
 let output="";
 const renderer=new TerminalMarkdown(value=>{output+=value;},true);
 renderer.write(text);await new Promise(resolve=>setTimeout(resolve,40));renderer.flush();
 expect(output.replace(/\x1b\[[0-9;]*m/g,"")).toBe(text);
 renderer.write(" next plain line\n");renderer.flush();
 expect(output).toEndWith(" next plain line\n");
});

test("unmatched spans drain at newlines and the memory cap without losing text", () => {
 let output="";
 const renderer=new TerminalMarkdown(value=>{output+=value;},true);
 const text="**"+"x".repeat(2048);
 renderer.write(text);
 expect(output).toBe(text);
 renderer.write("\n`unfinished\nplain\n");renderer.flush();
 expect(output).toBe(text+"\n`unfinished\nplain\n");
});
