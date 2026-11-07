import { z } from "zod";
/** An update preserves inherited/saved instructions unless a text field is explicitly changed. */
export const agentInstructionPatchSchema = z
	.object({
		role: z.string().trim().min(1, "Instructions are required").optional(),
		additionalContext: z
			.string()
			.trim()
			.min(1, "Instructions are required")
			.optional(),
		constraints: z.string().trim().optional(),
	})
	.passthrough()
	.optional();
