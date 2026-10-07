import { expect, test } from "bun:test";
import { ComposerDrafts } from "../src/composer-drafts.js";
const atlas = { workspaceKey: "atlas", sessionId: "one" };

test("consume clears immediately; success or pause never clears a newer draft", () => {
  const drafts = new ComposerDrafts();
  drafts.edit(atlas, "sent");
  const sent = drafts.consume(atlas);
  expect(sent.text).toBe("sent");
  expect(drafts.read(atlas).text).toBe("");
  drafts.edit(atlas, "next");
  expect(drafts.read(atlas).text).toBe("next");
});
test("failure restores untouched draft and preserves recoverable text", () => {
  const drafts = new ComposerDrafts();
  drafts.edit(atlas, "sent");
  const sent = drafts.consume(atlas);
  drafts.failed(sent);
  expect(drafts.read(atlas)).toMatchObject({ text: "sent", recovery: "sent" });
});
for (const edited of ["different", "sent", ""]) {
  test(`failure keeps newer edit ${JSON.stringify(edited)}, including identical text`, () => {
    const drafts = new ComposerDrafts();
    drafts.edit(atlas, "sent");
    const sent = drafts.consume(atlas);
    drafts.edit(atlas, edited);
    const version = drafts.read(atlas).version;
    drafts.failed(sent);
    expect(drafts.read(atlas)).toEqual({ text: edited, version, recovery: "sent" });
    expect(drafts.recover(atlas)).toBe(edited === "");
    expect(drafts.read(atlas).text).toBe(edited || "sent");
  });
}
test("failure recovery stays bound to original workspace/session", () => {
  const drafts = new ComposerDrafts();
  drafts.edit(atlas, "sent");
  const sent = drafts.consume(atlas);
  const otherSession = { ...atlas, sessionId: "two" };
  const otherWorkspace = { ...atlas, workspaceKey: "beacon" };
  drafts.edit(otherSession, "session draft");
  drafts.edit(otherWorkspace, "workspace draft");
  drafts.failed(sent);
  expect(drafts.read(otherSession).text).toBe("session draft");
  expect(drafts.read(otherWorkspace).text).toBe("workspace draft");
  expect(drafts.read(otherSession).recovery).toBeUndefined();
  expect(drafts.read(atlas).recovery).toBe("sent");
});
test("scoped identity cannot collide on separator characters", () => {
  const drafts = new ComposerDrafts();
  drafts.edit({ workspaceKey: "a:b", sessionId: "c" }, "one");
  expect(drafts.read({ workspaceKey: "a", sessionId: "b:c" }).text).toBe("");
});
