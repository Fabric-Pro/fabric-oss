/**
 * What a Living Memory write ended with (ADR-022): the typed outcome the write
 * workflow records on the receipt and `memoryWrites.get` hands back. Pure and
 * free of the Temporal SDK, so the API, the activities and the tests share one
 * definition; the workflow bundle imports only its types.
 *
 * One variant per settled status. The receipt's `status` column and the
 * outcome's `status` are written together, so the outcome is the whole answer
 * and a reader never has to join the two. Paths are repository paths, codes
 * are closed words, and nothing here quotes file content, a commit message or
 * a provider's text.
 */
import { z } from "zod";

/** A write the workflow settles with one of these; PENDING is the only other status. */
export const MEMORY_WRITE_SETTLED_STATUSES = [
	"COMMITTED",
	"PULL_REQUEST",
	"CONFLICT",
	"REFUSED",
	"FAILED",
] as const;

export type MemoryWriteSettledStatus =
	(typeof MEMORY_WRITE_SETTLED_STATUSES)[number];

/**
 * What the tip says about one path of a write that cannot be applied, found
 * against the branch as it stands when the write runs. The first three are
 * conflicts, a path that changed under the caller (the batch settles
 * `CONFLICT`); the last two are refusals, a path the repository rules out
 * whatever the caller knew (the batch settles `REFUSED`).
 *
 * - `PATH_EXISTS`: a PUT without `ifMatchOid` finds the path present.
 * - `PATH_MISSING`: a PUT with `ifMatchOid`, or a DELETE, finds the path absent.
 * - `IF_MATCH_MISMATCH`: the blob at the path is not the one the caller saw.
 * - `PATH_EXCLUDED`: the selected folder's `.contextignore` at the tip leaves
 *   the path out, so nothing written there would be read back.
 * - `PATH_NOT_A_FILE`: a folder, a symbolic link or a submodule stands at the
 *   path, or a file stands where one of its folders must be.
 */
export const MEMORY_WRITE_PATH_VERDICT_CODES = [
	"PATH_EXISTS",
	"PATH_MISSING",
	"IF_MATCH_MISMATCH",
	"PATH_EXCLUDED",
	"PATH_NOT_A_FILE",
] as const;

export type MemoryWritePathVerdictCode =
	(typeof MEMORY_WRITE_PATH_VERDICT_CODES)[number];

/** The verdict codes that make a batch a `CONFLICT`: the caller's view of the path was out of date. */
const CONFLICT_VERDICT_CODES: ReadonlySet<MemoryWritePathVerdictCode> = new Set(
	["PATH_EXISTS", "PATH_MISSING", "IF_MATCH_MISMATCH"],
);

export function isConflictVerdict(code: MemoryWritePathVerdictCode): boolean {
	return CONFLICT_VERDICT_CODES.has(code);
}

export const memoryWritePathVerdictSchema = z
	.object({
		path: z.string(),
		code: z.enum(MEMORY_WRITE_PATH_VERDICT_CODES),
		/**
		 * The blob now at the path (a conflict): what the caller re-reads
		 * against. Null when the path is absent; omitted when it is not about a
		 * blob.
		 */
		currentOid: z.string().nullable().optional(),
	})
	.strict();

export type MemoryWritePathVerdict = z.infer<
	typeof memoryWritePathVerdictSchema
>;

/**
 * Why a write was refused: nothing was written, and the caller or an
 * administrator can fix the cause. `PATH_REFUSED` carries the verdicts of the
 * paths; the rest are about the write as a whole.
 */
export const MEMORY_WRITE_REFUSAL_CODES = [
	"READ_ONLY_MODE",
	"TARGET_CHANGED",
	"TARGET_STALE",
	"SYNC_CHANGED",
	"SYNC_NOT_INGESTING",
	"SYNC_DELEGATE_LOST_PERMISSION",
	"PERMISSION_REVOKED",
	"STAGED_BYTES_CHANGED",
	"PATH_REFUSED",
	"IGNORE_POLICY_UNREADABLE",
	"NO_CHANGE",
	"MESSAGE_REJECTED",
	"ATTRIBUTION_REJECTED",
] as const;

export type MemoryWriteRefusalCode =
	(typeof MEMORY_WRITE_REFUSAL_CODES)[number];

/** Why a pull request was opened: the folder's mode, or a direct push the branch refused. */
export const MEMORY_WRITE_PULL_REQUEST_REASONS = [
	"configured",
	"protected",
] as const;

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const memoryWriteOutcomeSchema = z.discriminatedUnion("status", [
	/** The synced branch holds the commit. */
	z
		.object({
			status: z.literal("COMMITTED"),
			sha: objectId,
			ref: z.string(),
			fileCount: z.number().int().nonnegative(),
		})
		.strict(),
	/** A pull request into the synced branch is open. */
	z
		.object({
			status: z.literal("PULL_REQUEST"),
			sha: objectId,
			ref: z.string(),
			branch: z.string(),
			url: z.string(),
			externalId: z.string(),
			reason: z.enum(MEMORY_WRITE_PULL_REQUEST_REASONS),
			fileCount: z.number().int().nonnegative(),
		})
		.strict(),
	/** At least one path changed under the caller; nothing was written. */
	z
		.object({
			status: z.literal("CONFLICT"),
			paths: z.array(memoryWritePathVerdictSchema),
		})
		.strict(),
	/** The write is ruled out; nothing was written. */
	z
		.object({
			status: z.literal("REFUSED"),
			code: z.enum(MEMORY_WRITE_REFUSAL_CODES),
			paths: z.array(memoryWritePathVerdictSchema).optional(),
		})
		.strict(),
	/**
	 * The workflow could not finish. `retryable` says whether sending the same
	 * request again can work. `sha` names a commit that did reach the branch
	 * when its outcome could not be recorded as `COMMITTED`.
	 */
	z
		.object({
			status: z.literal("FAILED"),
			code: z.string().min(1).max(64),
			retryable: z.boolean(),
			sha: objectId.optional(),
		})
		.strict(),
]);

export type MemoryWriteOutcome = z.infer<typeof memoryWriteOutcomeSchema>;

export type MemoryWriteOutcomeOf<S extends MemoryWriteSettledStatus> = Extract<
	MemoryWriteOutcome,
	{ status: S }
>;
