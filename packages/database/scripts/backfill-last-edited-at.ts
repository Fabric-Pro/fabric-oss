/**
 * One-time backfill of `UserStory.lastEditedAt`, the semantic edit clock.
 *
 * The column ships nullable and empty, so until a feature is next edited every
 * recency surface reads it as "no edit recorded" — which makes the roadmap's
 * "recently changed" and date-range filters useless on a backlog nobody has
 * touched since the deploy. This fills it from events that genuinely record a
 * change rather than from `updatedAt`, which moves on any row write and is the
 * reason the column exists at all.
 *
 * Four sources, the latest of which wins:
 *   - the most recent FeatureVersion snapshot, written at the moment of the
 *     edit that replaced it
 *   - priorityChangedAt        the priority band actually moved
 *   - draftingStageUpdatedAt   the drafting stage actually changed
 *   - coverageOverrideAt       a conscious coverage decision was recorded
 *
 * ATTRIBUTION. An author is never invented here. It is also actively CLEARED
 * when the winning event is NOT a version snapshot, because the previous code
 * only ever wrote `lastEditedByName` on a title or description edit — pairing
 * that name with a clock taken from a priority or stage change credits the wrong
 * person for that change. Where the winning event IS the version snapshot the
 * existing author describes the same class of event and is left alone. A date
 * that can be proven beats a name that would be guessed.
 *
 * KNOWN LIMIT — the backfilled date is a LOWER BOUND, not a guarantee. Only four
 * kinds of historical change left a trace: a content-version snapshot (written
 * for description, acceptance-criteria, drafting-stage and kind changes) and the
 * priority, stage and coverage stamps. Going forward the classifier counts eight
 * more fields as genuine edits — title, labels, assignee, status, points, size,
 * maturation status and needs-more-info — and none of those left anything behind.
 * So a story whose description changed on day 1 and whose title changed on day
 * 100 is stamped day 1: a real change, but not its latest one. Nothing in the
 * database records the day-100 edit, so no job can recover it; the alternative
 * would be to abandon the 60%+ of rows this does date correctly. Forward-looking
 * behaviour is unaffected — every one of those fields is stamped from now on.
 *
 * NO REPAIR PASS. An earlier version of this job paired a clock taken from a
 * priority/stage stamp with an author the previous code had written for an
 * earlier text edit. Repairing that after the fact is not safely possible: the
 * only available signals — "the clock predates this job's last run" and "no
 * version snapshot matches the clock" — are equally true of a real, correctly
 * attributed edit to a field that creates no version row (priority, status,
 * labels, assignee, size, points, maturation status, needs-more-info). A repair
 * pass built on them destroys good attribution on every subsequent run. The fill
 * pass below prevents the defect at the source instead; an environment that ran
 * the earlier version keeps a small number of mis-paired rows, each self-
 * correcting the next time someone edits that story.
 *
 * ONE STATEMENT PER BATCH. The first version of this job read a page of rows
 * into the process and wrote them back as one `updateMany` per row inside a
 * single `$transaction`. That is a round trip per row, and on a backlog larger
 * than the one it was written against the first batch of 500 blew Prisma's 5s
 * transaction timeout — which failed the seed step, and with it the whole
 * release. The work belongs in the database: the statement below selects and
 * writes in one pass, so cost is one round trip per batch rather than per row,
 * and the timestamps never make a round trip through a JS `Date` (the column is
 * `timestamp without time zone`, so that conversion is a correctness hazard as
 * well as a slow one).
 *
 * Still batched, and still resumable: `LIMIT` bounds how many rows one statement
 * locks, and because the fill filters on `lastEditedAt IS NULL` — the very
 * column it sets — each pass naturally starts where the last one stopped. No
 * cursor is needed, and an interrupted run simply continues on the next deploy.
 *
 * Dry-run by default; pass --apply to write.
 */
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../prisma/client";

const BATCH_SIZE = 500;

/**
 * The slice of the client this job uses, injectable so a test can count what a
 * run costs in round trips.
 *
 * Without the seam the regression is untestable: a correctness test fills its
 * rows and passes on either implementation, because the per-row version was
 * never *wrong* — it was linear, and only a remote database with a real backlog
 * made linear fatal. Counting calls is the only assertion that tells the two
 * apart on a local Postgres.
 */
export type BackfillClient = {
	$executeRaw: typeof db.$executeRaw;
	$queryRaw: typeof db.$queryRaw;
	userStory: { count: typeof db.userStory.count };
};

/**
 * Fill one batch, returning how many rows were written. Selecting and updating
 * in a single statement is what keeps this inside the seed runner's budget.
 */
async function fillOneBatch(client: BackfillClient): Promise<number> {
	return await client.$executeRaw`
		WITH scored AS (
			SELECT s."id",
			       s."createdAt",
			       fv.last_version_at,
			       GREATEST(
			           COALESCE(fv.last_version_at, TIMESTAMP 'epoch'),
			           COALESCE(s."priorityChangedAt", TIMESTAMP 'epoch'),
			           COALESCE(s."draftingStageUpdatedAt", TIMESTAMP 'epoch'),
			           COALESCE(s."coverageOverrideAt", TIMESTAMP 'epoch')
			       ) AS changed_at
			FROM "user_story" AS s
			LEFT JOIN (
			    SELECT "storyId", MAX("createdAt") AS last_version_at
			    FROM "feature_version"
			    GROUP BY "storyId"
			) AS fv ON fv."storyId" = s."id"
			WHERE s."lastEditedAt" IS NULL
		),
		batch AS (
			SELECT "id",
			       changed_at,
			       (last_version_at IS NOT NULL AND last_version_at = changed_at)
			           AS from_version
			FROM scored
			WHERE changed_at > TIMESTAMP 'epoch'
			  -- Never claim an edit that predates the row itself.
			  AND changed_at >= "createdAt"
			ORDER BY "id"
			LIMIT ${BATCH_SIZE}
		)
		UPDATE "user_story" AS s
		SET "lastEditedAt" = b.changed_at,
		    -- Keep the author only where it describes the same event the clock
		    -- now points at; otherwise it credits the wrong person.
		    "lastEditedByName" = CASE
		        WHEN b.from_version THEN s."lastEditedByName" ELSE NULL END,
		    "lastEditedSource" = CASE
		        WHEN b.from_version THEN s."lastEditedSource" ELSE NULL END
		FROM batch AS b
		-- The null guard lets a concurrent real edit win over the backfill
		-- rather than be overwritten by it.
		WHERE s."id" = b."id" AND s."lastEditedAt" IS NULL`;
}

/** How many rows the fill would write, without writing any of them. */
async function countFillCandidates(client: BackfillClient): Promise<number> {
	const [{ count }] = await client.$queryRaw<[{ count: bigint }]>`
		WITH scored AS (
			SELECT s."createdAt",
			       GREATEST(
			           COALESCE(fv.last_version_at, TIMESTAMP 'epoch'),
			           COALESCE(s."priorityChangedAt", TIMESTAMP 'epoch'),
			           COALESCE(s."draftingStageUpdatedAt", TIMESTAMP 'epoch'),
			           COALESCE(s."coverageOverrideAt", TIMESTAMP 'epoch')
			       ) AS changed_at
			FROM "user_story" AS s
			LEFT JOIN (
			    SELECT "storyId", MAX("createdAt") AS last_version_at
			    FROM "feature_version"
			    GROUP BY "storyId"
			) AS fv ON fv."storyId" = s."id"
			WHERE s."lastEditedAt" IS NULL
		)
		SELECT COUNT(*) AS count
		FROM scored
		WHERE changed_at > TIMESTAMP 'epoch'
		  AND changed_at >= "createdAt"`;
	return Number(count);
}

export async function backfillLastEditedAt({
	apply,
	client = db,
}: {
	apply: boolean;
	client?: BackfillClient;
}): Promise<{ filled: number; remaining: number }> {
	console.info(
		apply
			? "Backfilling UserStory.lastEditedAt (writing)."
			: "Backfilling UserStory.lastEditedAt (DRY RUN — pass --apply to write).",
	);

	let filled = 0;

	if (apply) {
		for (;;) {
			const written = await fillOneBatch(client);
			if (written === 0) {
				break;
			}
			filled += written;
			console.info(`  fill batch: ${written} row(s) written`);
		}
	} else {
		filled = await countFillCandidates(client);
		console.info(`  ${filled} row(s) would be written`);
	}

	const remaining = await client.userStory.count({
		where: { lastEditedAt: null },
	});
	console.info(
		`Done. ${filled} row(s) filled, ${remaining} row(s) still have no edit clock (no recorded change to draw on).`,
	);
	return { filled, remaining };
}

// Only self-execute when run as a CLI; the deploy wrapper imports the function.
const invokedDirectly =
	process.argv[1] !== undefined &&
	fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);

if (invokedDirectly) {
	backfillLastEditedAt({ apply: process.argv.includes("--apply") })
		.catch((error) => {
			console.error("Backfill failed:", error);
			process.exitCode = 1;
		})
		.finally(async () => {
			await db.$disconnect();
		});
}
