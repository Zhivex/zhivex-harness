import { z } from "zod";
import { fileDigestSchema, workspaceFilePathSchema } from "./edit-contracts.js";

/** The exact match and replacement, together with the file digest, are approved. */
export const replacementEditSchema = z.strictObject({
  path: workspaceFilePathSchema,
  expectedDigest: fileDigestSchema,
  oldText: z.string().min(1).max(64_000),
  newText: z.string().max(64_000),
  allowControlBytes: z.literal(true).optional().describe(
    "Set true only when the resulting text file is meant to contain a NUL or other control byte. Otherwise the edit is refused."
  )
});
export type ReplacementEdit = z.infer<typeof replacementEditSchema>;
