import { expect, test } from "bun:test";
import { chooseConsoleItem, formatComposer } from "../src/cli/console/console-presentation.js";

test("composer distinguishes approval policy and pending actions, and bounds hostile metadata", () => {
 const text=formatComposer({model:"openai/model",status:"approval pending · /pending",title:"injected\x1b[2J\nname",automaticApprovals:true,attachments:2},100,false);
 expect(text).toContain("auto approvals");
 expect(text).toContain("approval pending");
 expect(text).toContain("2 attached");
 expect(text).not.toContain("\x1b");
 expect(formatComposer({model:"a".repeat(100),status:"ready"},30,false).split("\n").every(line=>Array.from(line).length<=30)).toBe(true);
});

test("picker filters labels and IDs, validates visible numbers and cancels without choosing", async () => {
 const items=Array.from({length:20},(_,i)=>({value:i,label:`Conversation ${i}`,detail:`ses_${i}`}));
 const answers=["19","ses_17","1"];
 let output="";
 expect(await chooseConsoleItem("Choose conversation",items,{write:t=>{output+=t;},ask:async()=>answers.shift()!})).toBe(17);
 expect(output).toContain("Choose a number from the visible list");
 expect(await chooseConsoleItem("Choose",items,{write:()=>{},ask:async()=>""})).toBeUndefined();
});
