import { expect, test } from "bun:test";
import { TerminalMarkdown } from "../src/cli/terminal/terminal-markdown.js";
import { terminalCellWidth } from "../src/cli/terminal/terminal-table.js";

const withoutStyles = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const table = "| Check | Result |\n| --- | --- |\n| `bun test` | 30 pass / 0 fail |\n";

test("renders complete tables with aligned borders and readable inline code", () => {
  let output = "";
  const renderer = new TerminalMarkdown(value => { output += value; }, false);
  renderer.write(table); renderer.flush();
  expect(output).toBe([
    "┌──────────┬──────────────────┐",
    "│ Check    │ Result           │",
    "├──────────┼──────────────────┤",
    "│ bun test │ 30 pass / 0 fail │",
    "└──────────┴──────────────────┘", ""
  ].join("\n"));
});

test("tables survive every token boundary and pauses without duplicate output", async () => {
  let output = "";
  const renderer = new TerminalMarkdown(value => { output += value; }, true);
  renderer.write("| Che"); await new Promise(resolve => setTimeout(resolve, 40));
  expect(output).toBe("");
  for (const char of table.slice(5)) renderer.write(char);
  renderer.write("\nDone"); renderer.flush();
  expect(withoutStyles(output)).toContain("│ bun test │ 30 pass / 0 fail │");
  expect(output.match(/┌/g)).toHaveLength(1);
  expect(output).toEndWith("\n\nDone");
  const completed = output; renderer.flush(); expect(output).toBe(completed);
});

test("wraps long paths and Unicode by visible terminal width", () => {
  let output = "";
  const renderer = new TerminalMarkdown(value => { output += value; }, true, () => 40);
  renderer.write("| Hallazgo | Estado |\n| :--- | ---: |\n| café 中文 👩‍💻 | src/very-long-unbroken-file-name.ts recuperado sin perder información |\n");
  renderer.flush();
  const lines = withoutStyles(output).trimEnd().split("\n");
  expect(new Set(lines.map(terminalCellWidth)).size).toBe(1);
  expect(terminalCellWidth(lines[0]!)).toBeLessThan(40);
  expect(output).toContain("👩‍💻");
  const text = withoutStyles(output).replace(/[│\s]/g, "");
  expect(text).toContain("src/very-long-unbroken-file-name.ts".slice(0, 12));
  expect(text).toContain("información");
});

test("uses stacked cells in narrow terminals and resolves width at render time", () => {
  let output = "", width = 80;
  const renderer = new TerminalMarkdown(value => { output += value; }, false, () => width);
  renderer.write(table); width = 14; renderer.flush();
  expect(output).toContain("Check:\nbun test\nResult:\n");
  expect(output).not.toContain("┌");
  expect(output.trimEnd().split("\n").every(line => terminalCellWidth(line) < width)).toBe(true);
});

test("preserves escaped pipes, code pipes and a final row without newline", () => {
  let output = "";
  const renderer = new TerminalMarkdown(value => { output += value; }, false);
  renderer.write("| A | B |\n| --- | --- |\n| `a|b` | c\\|d |"); renderer.flush();
  expect(output).toContain("│ a|b  │ c|d  │");
});

test("does not consume incomplete tables, malformed rows or fenced pipe text", () => {
  for (const text of ["| not a table |\nprose\n", "| A | B |", "```text\n" + table + "```\n",
    "| A | B |\n| -- | -- |\n", "|" + "x".repeat(9000)]) {
    let output = "";
    const renderer = new TerminalMarkdown(value => { output += value; }, false);
    renderer.write(text); renderer.flush(); expect(output).toBe(text);
  }
});

test("table cells cannot inject terminal controls", () => {
  let output = "";
  const renderer = new TerminalMarkdown(value => { output += value; }, true);
  renderer.write("| A | B |\n| --- | --- |\n| \x1b[2J | \x1b]52;c;payload\x07 |\n"); renderer.flush();
  expect(output).toContain("\\u001b[2J");
  expect(output).not.toContain("\x1b[2J");
  expect(output).not.toContain("\x1b]52");
});

test("bounded tables retain rows beyond the buffering limit", () => {
  let output = "";
  const renderer = new TerminalMarkdown(value => { output += value; }, false);
  renderer.write("| A | B |\n| --- | --- |\n" + Array.from({ length: 150 }, (_, i) => `| row-${i} | value |\n`).join(""));
  renderer.flush();
  for (let i = 0; i < 150; i++) expect(output.match(new RegExp(`row-${i}(?=\\s)`, "g"))).toHaveLength(1);
});

test("empty narrow tables retain headers and alignment markers are honored", () => {
  let output = "";
  const renderer = new TerminalMarkdown(value => { output += value; }, false, () => 12);
  renderer.write("| A | B |\n| --- | --- |\n"); renderer.flush();
  expect(output).toBe("A\nB\n");
  let aligned = "";
  const wide = new TerminalMarkdown(value => { aligned += value; }, false);
  wide.write("| A | B | C |\n| :--- | :---: | ---: |\n| x | y | z |\n"); wide.flush();
  expect(aligned).toContain("│ x    │  y   │    z │");
});

for (const color of [false, true]) {
  test(`handles heading prefixes without content at flush (color=${color})`, () => {
    for (let level = 1; level <= 6; level++) {
      let output = "";
      const renderer = new TerminalMarkdown(text => { output += text; }, color);
      renderer.write("#".repeat(level) + " ");
      expect(() => renderer.flush()).not.toThrow();
      expect(output).toBe("");
      renderer.write("Title\nPlain\n");
      renderer.flush();
      expect(output).toBe(color ? "\x1b[1mTitle\x1b[0m\nPlain\n" : "Title\nPlain\n");
    }
  });

  test(`handles heading prefixes and split Unicode across timed frames (color=${color})`, async () => {
    let output = "";
    const renderer = new TerminalMarkdown(text => { output += text; }, color);
    renderer.write("## ");
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(output).toBe("");
    renderer.write("Title\n## \uD83D");
    expect(output.replace(/\x1b\[[0-9;]*m/g, "")).toBe("Title\n");
    renderer.write("\uDE42 listo\nPlain\n");
    renderer.flush();
    expect(output.replace(/\x1b\[[0-9;]*m/g, "")).toBe("Title\n🙂 listo\nPlain\n");
  });
}

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
