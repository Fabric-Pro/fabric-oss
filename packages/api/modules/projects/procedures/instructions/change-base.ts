import { z } from "zod";
import { commitShaSchema } from "./repository/commit-sha";

export const instructionChangeBaseSchema = z.union([
	z.object({
		baseSnapshotId: z.string().min(1).max(128),
		nativeBase: z.never().optional(),
	}),
	z.object({
		nativeBase: z.object({
			generation: z.number().int().positive(),
			commitSha: commitShaSchema,
		}),
		baseSnapshotId: z.never().optional(),
	}),
]);

export type InstructionChangeBase = z.infer<typeof instructionChangeBaseSchema>;
