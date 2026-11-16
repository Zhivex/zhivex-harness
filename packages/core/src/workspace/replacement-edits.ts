import { z } from "zod";
import { fileDigestSchema, workspaceFilePathSchema } from "./edit-contracts.js";

/** The exact match and replacement, together with the file digest, are approved. */
export const replacementEditSchema = z.strictObject({
  path: workspaceFilePathSchema,
  expectedDigest: fileDigestSchema,
  oldText: z.string().min(1).max(64_000),
  newText: z.string().max(64_000)
});
export type ReplacementEdit = z.infer<typeof replacementEditSchema>;
