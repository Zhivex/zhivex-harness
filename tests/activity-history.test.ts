import {test,expect} from "bun:test";
import {ActivityHistory,formatAppliedFiles} from "../src/cli/terminal/activity-history.js";
import {compactToolResult} from "../src/cli/terminal/tool-activity.js";

test("retrospective history is bounded and excludes model reasoning and raw tool payloads",()=>{
 const history=new ActivityHistory();
 history.observe({type:"text-delta",textDelta:"SECRET"} as never);
 history.observe({type:"tool-call",toolCall:{name:"SECRET",arguments:"SECRET"}} as never);
 expect(history.render()).not.toContain("SECRET");
 for(let i=0;i<210;i++)history.observe({type:"tool-result",toolResult:{toolName:"read_file",output:"SECRET"}} as never);
 expect(history.render()).toContain("earlier entries omitted");
 expect(history.render().split("\n")).toHaveLength(202);
 history.clear();expect(history.render()).toContain("No activity");
});

test("applied file receipts come from committed audit records and distinguish verification",()=>{
 expect(formatAppliedFiles([])).toBe("");
 const result=formatAppliedFiles([{operation:"update",path:"src/a.ts\x1b[31m\nspoof"},{operation:"create",path:"src/new.ts"}]);
 expect(result).toContain("Applied 2 file changes");expect(result).toContain("src/new.ts");
 expect(result).toContain("/diff");expect(result).toContain("verification reported separately");
 expect(result).not.toContain("\x1b");expect(result).not.toContain("\nspoof");
});

test("rejected edits are labelled preparation and never described as applied",()=>{
 const result=compactToolResult({toolName:"apply_reviewed_edits",isError:true,error:{code:"TOOL_INPUT_VALIDATION_ERROR",message:"SECRET"}})!;
 expect(result).toContain("Preparing");expect(result).toContain("edits not applied");expect(result).not.toContain("SECRET");
});
