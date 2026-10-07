export type DraftSelection = { workspaceKey: string; sessionId: string };
type Draft = { text: string; version: number; recovery?: string };
export type SubmittedDraft = { key: string; text: string; consumedVersion: number };

/** Revisions track edits even when the user types the exact submitted text again. */
export class ComposerDrafts {
  private entries = new Map<string, Draft>();
  private key(selection: DraftSelection) {
    return JSON.stringify([selection.workspaceKey, selection.sessionId]);
  }
  read(selection: DraftSelection): Readonly<Draft> {
    return this.entries.get(this.key(selection)) ?? { text: "", version: 0 };
  }
  edit(selection: DraftSelection, text: string) {
    const previous = this.read(selection);
    this.entries.set(this.key(selection), { ...previous, text, version: previous.version + 1 });
  }
  consume(selection: DraftSelection): SubmittedDraft {
    const previous = this.read(selection);
    const key = this.key(selection);
    const consumedVersion = previous.version + 1;
    this.entries.set(key, { text: "", version: consumedVersion });
    return { key, text: previous.text, consumedVersion };
  }
  failed(submission: SubmittedDraft) {
    const current = this.entries.get(submission.key)!;
    const untouched = current.version === submission.consumedVersion;
    this.entries.set(submission.key, {
      ...current,
      ...(untouched ? { text: submission.text, version: current.version + 1 } : {}),
      recovery: submission.text,
    });
  }
  recover(selection: DraftSelection) {
    const current = this.read(selection);
    if (current.text || current.recovery === undefined) return false;
    this.edit(selection, current.recovery);
    return true;
  }
}
