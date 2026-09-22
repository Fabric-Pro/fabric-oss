/**
 * Backfill `ProjectContext.contentHash` for rows written before every content
 * write stamped one (Fizzy #2619).
 *
 * Until now only synced knowledge files (`upsertContextBySourcePath`) carried
 * a hash, so the Context tab's duplicate detection could not see anything
 * uploaded by hand. New writes now store the hash alongside `content`; this
 * fills it in for the rows that predate that.
 *
 * EXACTNESS OVER SPEED. The hash is computed here, in Node, with the same
 * `hashContextContent` every runtime writer uses, rather than with SQL
 * `sha256()`: a backfilled hash that differed from the runtime one by so much
 * as an encoding detail would split one piece of content into two groups and
 * hide exactly the duplicates this exists to find. So each batch reads
 * `content` into the process; only `id` and `content` are selected.
 *
 * NEVER OVERWRITES. Each row is written with `updateMany` keyed on
 * `contentHash IS NULL` AND the content that was read. A concurrent write that
 * stamped its own hash, or changed the content since the read, makes the
 * update match nothing, and the row is counted as skipped rather than given a
 * hash for content it no longer holds.
 *
 * IDEMPOTENT AND RESUMABLE. Only rows with `contentHash IS NULL` and non-empty
 * content are candidates, and filling one removes it from that set, so a
 * re-run — after an interruption or on another environment — picks up exactly
 * where the last one stopped. Within a run, pages advance by an `id` cursor so
 * a row that is skipped is never re-read in a loop.
 *
 * Empty content is left at NULL on purpose: the runtime writers store no hash
 * for it either (`contextContentHashOrNull`).
 *
 * Dry-run by default; pass --apply to write.
 *   pnpm --filter @repo/database backfill:context-content-hash -- --apply
 */
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../prisma/client";
import { hashContextContent } from "../prisma/queries/projects/context-content-hash";

export const BACKFILL_BATCH_SIZE = 200;

/** The rows a run still has to fill: no hash yet, and something to hash. */
const CANDIDATE_WHERE = {
	contentHash: null,
	content: { not: "" },
};

/**
 * The slice of the client this job uses, injectable so the batch loop can be
 * tested without a database.
 */
export type ContentHashBackfillClient = {
	projectContext: Pick<
		typeof db.projectContext,
		"findMany" | "updateMany" | "count"
	>;
};

export interface ContentHashBackfillResult {
	/** Rows given a hash (in dry-run: rows that would be). */
	filled: number;
	/** Rows a concurrent write changed between read and write. */
	skipped: number;
	/** Candidates still without a hash when the run ended. */
	remaining: number;
}

export async function backfillContextContentHash({
	apply,
	client = db,
	batchSize = BACKFILL_BATCH_SIZE,
	log = console.info,
}: {
	apply: boolean;
	client?: ContentHashBackfillClient;
	batchSize?: number;
	log?: (message: string) => void;
}): Promise<ContentHashBackfillResult> {
	log(
		apply
			? "Backfilling ProjectContext.contentHash (writing)."
			: "Backfilling ProjectContext.contentHash (DRY RUN — pass --apply to write).",
	);

	if (!apply) {
		const candidates = await client.projectContext.count({
			where: CANDIDATE_WHERE,
		});
		log(`  ${candidates} row(s) would be given a content hash`);
		return { filled: candidates, skipped: 0, remaining: candidates };
	}

	let filled = 0;
	let skipped = 0;
	let cursor: string | undefined;
	let batchNumber = 0;

	for (;;) {
		const rows = await client.projectContext.findMany({
			where: {
				...CANDIDATE_WHERE,
				...(cursor ? { id: { gt: cursor } } : {}),
			},
			select: { id: true, content: true },
			orderBy: { id: "asc" },
			take: batchSize,
		});
		if (rows.length === 0) {
			break;
		}
		batchNumber += 1;

		let batchFilled = 0;
		for (const row of rows) {
			const { count } = await client.projectContext.updateMany({
				where: { id: row.id, contentHash: null, content: row.content },
				data: { contentHash: hashContextContent(row.content) },
			});
			if (count > 0) {
				batchFilled += 1;
			} else {
				skipped += 1;
			}
		}
		filled += batchFilled;
		log(
			`  batch ${batchNumber}: ${batchFilled} of ${rows.length} row(s) hashed`,
		);

		cursor = rows[rows.length - 1]?.id;
		if (rows.length < batchSize) {
			break;
		}
	}

	const remaining = await client.projectContext.count({
		where: CANDIDATE_WHERE,
	});
	log(
		`Done. ${filled} row(s) hashed, ${skipped} skipped (changed while running), ${remaining} candidate(s) remaining.`,
	);
	return { filled, skipped, remaining };
}

// Only self-execute when run as a CLI; tests import the function.
const invokedDirectly =
	process.argv[1] !== undefined &&
	fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);

if (invokedDirectly) {
	backfillContextContentHash({ apply: process.argv.includes("--apply") })
		.catch((error) => {
			console.error("Backfill failed:", error);
			process.exitCode = 1;
		})
		.finally(async () => {
			await db.$disconnect();
		});
}
