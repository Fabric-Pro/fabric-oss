/**
 * One-time repair for INTEGRATION contexts that are demonstrably indexed but
 * still sitting on the schema default `PENDING` (Fizzy #2228, R13).
 *
 * Cause: the Notion PRD bind procedures embed inline via `embedProjectContext`
 * instead of starting `contextEmbeddingWorkflow`. That helper writes `qdrantId`
 * and `embeddedAt` and nothing else — the `extractionStatus` write lives in
 * `embedSingleContextActivity`, which the inline path never reaches. So rows
 * holding several kilobytes of real text, with a vector already in the store,
 * never left `PENDING`. The source is fixed in
 * `packages/api/modules/projects/procedures/notion-prd/sync-notion-prd.ts`;
 * this script repairs rows written before that fix.
 *
 * The selection is deliberately narrow, and every clause is evidence rather
 * than inference:
 *   - `qdrantId` and `embeddedAt` are both set, so a vector really was stored;
 *   - `content` holds at least one non-whitespace character, so the row is not
 *     a metadata-only pointer whose data lives in a monitored channel;
 *   - the status is still `PENDING`, so nothing has reached a terminal state.
 * A row missing any of these is left alone. Flipping an unindexed row to
 * COMPLETED would reproduce the "Ready pill that lies" defect that the
 * metadata-only INTEGRATION wiring was fixed for — this script exists to stop
 * under-reporting, not to start over-reporting.
 *
 * Provider-agnostic on purpose: the qualifying evidence is "indexed but not
 * marked", which is a property of the row, not of who wrote it.
 *
 * Idempotent — a repaired row no longer matches the filter. Dry-run by
 * default; pass `--apply` to write.
 */
import { db } from "../prisma/client";
import { updateContextExtractionStatus } from "../prisma/queries/projects/contexts";

const apply = process.argv.includes("--apply");

interface StuckContextRow {
	id: string;
	projectId: string;
	sourceTitle: string | null;
	contentLength: number;
}

async function main() {
	// Raw SQL for the content predicate: `content <> ''` is not enough, because
	// a whitespace-only body is non-empty and carries no text. Postgres `btrim`
	// defaults to spaces only, so the character class is the version that holds
	// for newlines and tabs. Same predicate `resolveContextIdsWithContent` uses.
	const rows = await db.$queryRaw<StuckContextRow[]>`
		SELECT id,
		       "projectId",
		       "sourceTitle",
		       length(content) AS "contentLength"
		  FROM project_context
		 WHERE type = 'INTEGRATION'
		   AND "extractionStatus" = 'PENDING'
		   AND "qdrantId" IS NOT NULL
		   AND "embeddedAt" IS NOT NULL
		   AND content ~ '[^[:space:]]'
		 ORDER BY "projectId", id
	`;

	let repaired = 0;

	for (const row of rows) {
		const label = `context ${row.id} (project ${row.projectId}, ${
			row.sourceTitle ?? "untitled"
		}, ${Number(row.contentLength)} chars)`;

		if (!apply) {
			console.log(`WOULD mark COMPLETED: ${label} (dry-run)`);
			repaired += 1;
			continue;
		}

		// Clearing `extractionError` matches what the runtime path now writes on
		// a successful embed: a row being declared indexed must not keep
		// carrying a message that describes a failure which no longer holds.
		await updateContextExtractionStatus(row.id, "COMPLETED", {
			extractionError: null,
		});
		repaired += 1;
		console.log(`marked COMPLETED: ${label}`);
	}

	console.log(
		`done. candidates=${rows.length} repaired=${repaired} mode=${
			apply ? "APPLY" : "DRY-RUN"
		}`,
	);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Repair failed:", err);
		process.exit(1);
	});
