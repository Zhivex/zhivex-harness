import { expect, test } from "bun:test";
import { chooseConsoleItem, formatComposer, formatComposerFooter } from "../src/cli/console/console-presentation.js";

test("composer distinguishes approval policy and pending actions, and bounds hostile metadata", () => {
 const text=formatComposer({model:"openai/model",status:"approval pending · /pending",title:"injected\x1b[2J\nname",automaticApprovals:true,attachments:2},100,false);
 expect(text).toContain("auto approvals");
 expect(text).toContain("approval pending");
 expect(text).toContain("2 attached");
 expect(text).not.toContain("\x1b");
 expect(formatComposer({model:"a".repeat(100),status:"ready"},30,false).split("\n").every(line=>Array.from(line).length<=30)).toBe(true);
});

test("Focus keeps pending decisions and attachments visible with long model and session labels", () => {
 const text=formatComposer({model:"m".repeat(200),reasoning:"high",title:"t".repeat(200),status:"approval pending · /pending",approvalMode:"restricted",attachments:2},80,false);
 expect(text).toContain("approval pending · /pending · restricted approvals · 2 attached");
 expect(text.split("\n").every(line=>Array.from(line).length<80)).toBe(true);
 expect(text).not.toContain("Ctrl+R");
 for(const columns of [12,30,45,80,140]) {
  expect(formatComposerFooter(columns).every(line=>Array.from(line).length<columns)).toBe(true);
 }
 expect(formatComposerFooter(30)[1]).toBe("/ commands · ? help");
 expect(formatComposerFooter(80)[1]).toContain("Alt+Enter newline");
 expect(formatComposer({model:"service",status:"ready",approvalMode:"auto"},80,false)).toContain("auto approvals");
});

test("picker filters labels and IDs, validates visible numbers and cancels without choosing", async () => {
 const items=Array.from({length:20},(_,i)=>({value:i,label:`Conversation ${i}`,detail:`ses_${i}`}));
 const answers=["19","ses_17","1"];
 let output="";
 expect(await chooseConsoleItem("Choose conversation",items,{write:t=>{output+=t;},ask:async()=>answers.shift()!})).toBe(17);
 expect(output).toContain("Choose a number from the visible list");
 expect(await chooseConsoleItem("Choose",items,{write:()=>{},ask:async()=>""})).toBeUndefined();
});
