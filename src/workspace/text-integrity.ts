import { HarnessWorkspaceError } from "../runtime/errors.js";

export interface ControlHit {
  line: number;
  label: string;
}

const controlLabel = (code: number) => code === 0 ? "NUL byte" : `U+${code.toString(16).padStart(4, "0")}`;

/** C0 controls other than tab, LF, and CR, plus DEL and Unicode C1 controls. */
export const firstDisallowedControl = (text: string): ControlHit | undefined => {
  let line = 1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0a) {
      line += 1;
      continue;
    }
    if (code === 0x09 || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return { line, label: controlLabel(code) };
  }
  return undefined;
};

/** Raw C0/DEL bytes. UTF-8 continuation bytes are left alone. */
export const firstDisallowedControlBytes = (bytes: Uint8Array): ControlHit | undefined => {
  let line = 1;
  for (let index = 0; index < bytes.length; index += 1) {
    const code = bytes[index] ?? 0;
    if (code === 0x0a) {
      line += 1;
      continue;
    }
    if (code === 0x09 || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) return { line, label: controlLabel(code) };
  }
  return undefined;
};

export const refuseControlMessage = (hit: ControlHit) =>
  `Refusing to write a control byte into a text file: ${hit.label} at L${hit.line}. The file was not changed. Remove the control byte, or set allowControlBytes if it is intentional.`;

export const binaryAfterEditMessage = (hit: ControlHit) =>
  `file is binary after edit: ${hit.label} at L${hit.line}. The edit was reverted. Read the file again before retrying.`;

/**
 * Text edits refuse NUL and other control bytes unless the caller sets
 * allowControlBytes. afterWrite is the publication check; tests replace it to
 * prove the rollback path.
 */
export const textGuards = {
  beforeWrite(content: string, allowControlBytes: boolean): void {
    if (allowControlBytes) return;
    const problem = firstDisallowedControl(content);
    if (problem) throw new HarnessWorkspaceError(refuseControlMessage(problem));
  },
  afterWrite(bytes: Uint8Array, allowControlBytes: boolean): ControlHit | undefined {
    if (allowControlBytes) return undefined;
    return firstDisallowedControlBytes(bytes);
  }
};
