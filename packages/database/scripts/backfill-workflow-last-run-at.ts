import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { db, Prisma } from "../prisma/client";

type BatchResult = { cursor: string | null; scanned: bigint; filled: bigint };
type BackfillClient = {
	$queryRaw: (query: Prisma.Sql) => Promise<BatchResult[]>;
};

/**
 * Restore historical run clocks without changing edit clocks. Each statement
 * visits at most 500 workflows and looks up history by indexed workflowId.
 * Batches commit independently; after interruption, restarting the scan
 * safely skips clocks already filled or advanced by a live run.
 */
export async function backfillWorkflowLastRunAt({
	apply,
	client = db,
	batchSize = 500,
}: {
	apply: boolean;
	client?: BackfillClient;
	batchSize?: number;
}): Promise<{ filled: number }> {
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
		throw new Error("batchSize must be an integer between 1 and 500");
	}

	let cursor: string | null = null;
	let filled = 0;
	for (;;) {
		const after =
			cursor === null
				? Prisma.empty
				: Prisma.sql`WHERE w."id" > ${cursor}`;
		const [{ cursor: nextCursor, scanned, filled: written }] =
			await client.$queryRaw(Prisma.sql`
				WITH page AS MATERIALIZED (
					SELECT w."id" FROM "workflow" AS w
					${after}
					ORDER BY w."id" LIMIT ${batchSize}
				), candidates AS MATERIALIZED (
					SELECT p."id", runs."lastStartedAt"
					FROM page AS p
					CROSS JOIN LATERAL (
						SELECT MAX(e."startedAt") AS "lastStartedAt"
						FROM "workflow_execution" AS e
						WHERE e."workflowId" = p."id"
						  AND e."status" <> 'PENDING'
						  AND (e."temporalRunId" IS NOT NULL OR e."triggerType" = 'SCHEDULE')
					) AS runs
					JOIN "workflow" AS w ON w."id" = p."id"
					WHERE runs."lastStartedAt" IS NOT NULL
					  AND (w."lastRunAt" IS NULL OR w."lastRunAt" < runs."lastStartedAt")
				), filled AS (
					${
						apply
							? Prisma.sql`UPDATE "workflow" AS w
								SET "lastRunAt" = c."lastStartedAt"
								FROM candidates AS c
								WHERE w."id" = c."id"
								  AND (w."lastRunAt" IS NULL OR w."lastRunAt" < c."lastStartedAt")
								RETURNING w."id"`
							: Prisma.sql`SELECT "id" FROM candidates`
					}
				)
				SELECT (SELECT MAX("id") FROM page) AS cursor,
				       (SELECT COUNT(*) FROM page) AS scanned,
				       (SELECT COUNT(*) FROM filled) AS filled
			`);
		filled += Number(written);
		console.info(
			`Workflow last-run backfill${apply ? "" : " (dry run)"}: ${scanned} scanned, ${written} ${apply ? "written" : "eligible"}`,
		);
		if (nextCursor === null || scanned < batchSize) {
			return { filled };
		}
		cursor = nextCursor;
	}
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);

if (invokedDirectly) {
	backfillWorkflowLastRunAt({ apply: process.argv.includes("--apply") })
		.catch((error) => {
			console.error("Workflow last-run backfill failed:", error);
			process.exitCode = 1;
		})
		.finally(() => db.$disconnect());
}
