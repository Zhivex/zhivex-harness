import { z } from "zod";
export const verifierSchema = z.strictObject({ command: z.string().min(1).max(64),
  args: z.array(z.string().max(8192)).max(256).default([]), purpose: z.string().min(1).max(500) });
