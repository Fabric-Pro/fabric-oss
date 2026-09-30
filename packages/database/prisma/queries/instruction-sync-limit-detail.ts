/**
 * The shape of a coding-instructions sync run's `limitDetail`, kept apart
 * from the queries that write it so a caller can validate one without loading
 * the Prisma client. Re-exported by `instruction-repository-sync.ts`.
 */
import { z } from "zod";

const instructionSyncLimitDetailSchema = z.object({
	kind: z.enum([
		"fileCount",
		"fileSize",
		"totalSize",
		"inventory",
		"repositorySize",
	]),
	max: z.number().int().nonnegative(),
	actual: z.number().int().nonnegative().optional(),
});

/**
 * Which limit a LIMITS_EXCEEDED run hit, numbers only (the run row's
 * `limitDetail`). `actual` is absent when the check stopped before the true
 * value was known.
 */
export type InstructionSyncLimitDetail = z.infer<
	typeof instructionSyncLimitDetailSchema
>;

/**
 * The detail as stored: a known kind and non-negative integers, unknown keys
 * dropped, anything else null. Guards the write (the value crosses a Temporal
 * payload) and the read (the column is Json).
 */
export function parseInstructionSyncLimitDetail(
	value: unknown,
): InstructionSyncLimitDetail | null {
	const parsed = instructionSyncLimitDetailSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}
