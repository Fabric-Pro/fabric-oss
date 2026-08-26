import { db, Prisma } from "../../client"; // NOT ../../../src — client.ts re-exports both

/**
 * The rule for "this terminal COUNTS AS A RUN", as one SQL fragment shared by
 * every reader in this file. `k` is the `publishing_suggestion_cycle` alias.
 *
 * Its TypeScript twin is `publishingTerminalCountsAsRun` in
 * `src/publishing-cadence.ts`, which `persistCycleTerminal` uses to decide
 * whether to record a preferences hash. The two are pinned against each other by
 * `packages/database/__tests__/publishing-preferences-hash-write.test.ts`.
 *
 * A FUNCTION rather than a module-level constant, and deliberately so. This file
 * is re-exported through `queries/projects/index.ts`, a barrel that much of
 * `@repo/api` pulls in, and a dozen suites there replace
 * `@repo/database/prisma/client` wholesale with a factory returning just `db`.
 * Dereferencing `Prisma` at module scope makes that mock throw during IMPORT, so
 * the suite collects zero tests and fails before a single assertion runs — which
 * is exactly what happened to `pr-review-comment-urls.test.ts`. Keeping the
 * dereference inside a call keeps this module's import side-effect-free, which
 * is the contract every one of those mocks already relies on. Do not "simplify"
 * this back to a `const`.
 */
const countsAsRun = () => Prisma.sql`(
	k."status" IN ('READY', 'NO_TOPICS')
	OR (
		k."status" = 'INSUFFICIENT_CONTEXT'
		AND (k."sourceFailures" IS NULL OR k."sourceFailures" = '{}'::jsonb)
	)
)`;

interface LastRunRow {
	projectId: string;
	startedAt: Date;
}

/**
 * Newest cycle per project that COUNTS AS A RUN for cadence purposes.
 *
 * Statuses that count: READY, NO_TOPICS, and INSUFFICIENT_CONTEXT **only when
 * collection was clean**. GENERATING (still in flight) and FAILED never count —
 * the dispatcher's liveness path reclaims a dead cycle by marking it FAILED, and
 * if that counted as a run one crash would suppress the project for a whole
 * cadence period. A dirty INSUFFICIENT_CONTEXT means a collector failed, and the
 * source that would have tipped the project over the sufficiency threshold
 * deserves a retry tomorrow, not next month.
 *
 * "Clean" is `sourceFailures` NULL **or** the empty JSON object: the workflow
 * initialises `sourceFailures` as `{}` and persists that object verbatim, so a
 * NULL-only test would match nothing and cadence would never engage.
 *
 * This rule is encoded TWICE — here in SQL, and as
 * `publishingTerminalCountsAsRun` in `src/publishing-cadence.ts`, which
 * `persistCycleTerminal` uses to decide whether to record a preferences hash.
 * The two are pinned against each other by
 * `packages/database/__tests__/publishing-preferences-hash-write.test.ts`. Change
 * one and that test goes red; change both and it stays green.
 *
 * The tuple comparison against the live `project` row is what stops a cycle
 * written before a project transfer from deferring a run under the new owner.
 * `IS NOT DISTINCT FROM` is required because both sides are nullable.
 *
 * The project side is NORMALIZED before comparing, exactly as
 * `dispatch-suggestion.ts` normalizes it when writing the cycle: an org cycle
 * stores `userId = NULL` even though `Project.userId` (the owner) is always
 * non-null. Comparing against the raw column would exclude every organization
 * cycle, making every org project look never-run and regenerate daily.
 *
 * Projects with no counted cycle are ABSENT from the map — callers read that as
 * "never run", which is due.
 */
export async function getLastCountedPublishingRuns(
	projectIds: string[],
): Promise<Map<string, Date>> {
	if (projectIds.length === 0) {
		return new Map();
	}

	// One row per project via CROSS JOIN LATERAL … LIMIT 1 — the same batched
	// per-id idiom as `feature-maturation.ts`. A plain findMany would return
	// every historical cycle for every project on the page.
	const rows = await db.$queryRaw<LastRunRow[]>(Prisma.sql`
		SELECT s.id AS "projectId", c."startedAt"
		FROM unnest(${projectIds}::text[]) AS s(id)
		JOIN "project" p ON p.id = s.id
		CROSS JOIN LATERAL (
			SELECT k."startedAt"
			FROM "publishing_suggestion_cycle" k
			WHERE k."projectId" = s.id
				AND ${countsAsRun()}
				AND k."organizationId" IS NOT DISTINCT FROM p."organizationId"
				-- Normalized exactly as dispatch-suggestion.ts writes it: an org
				-- cycle carries userId NULL, while Project.userId is never null.
				AND k."userId" IS NOT DISTINCT FROM (
					CASE WHEN p."organizationId" IS NULL THEN p."userId" ELSE NULL END
				)
			ORDER BY k."startedAt" DESC
			LIMIT 1
		) AS c
	`);

	return new Map(rows.map((r) => [r.projectId, r.startedAt]));
}

/**
 * The preferences fingerprint of the newest cycle that COUNTED AS A RUN for
 * this project under this tenant — `null` when there is no such cycle, and also
 * `null` when the newest one carries no hash.
 *
 * BOTH nulls must read as "changed", and collapsing them is the point rather
 * than a compromise. A counted cycle with no hash is a cycle whose preferences
 * are unknown: it may have run under a configuration nothing recorded, and it
 * advanced the watermark either way.
 *
 * NOT `WHERE preferencesHash IS NOT NULL`. That filter looks equivalent and
 * lets the reader skip PAST a newer counted cycle to an older hash — so a
 * preference changed away and then back would match an ancestor hash, cancel
 * the recovery run, and leave the content the intermediate cycle skipped buried
 * for good. The newest counted cycle is the only row that describes the
 * watermark as it now stands.
 *
 * Ordered by `startedAt` to match `getLastCountedPublishingRuns` — the cadence
 * definition of "the last run" — rather than by `completedAt`, which the
 * dispatcher's separate coverage read happens to use.
 *
 * Tenant-scoped for the same reason the coverage read is: a cycle written before
 * an org transfer must not settle a mismatch for the new tenant.
 */
export async function getLastCountedPublishingRunPreferencesHash(
	projectId: string,
	tenant: { organizationId: string | null; userId: string | null },
): Promise<string | null> {
	const rows = await db.$queryRaw<{ preferencesHash: string | null }[]>(
		Prisma.sql`
			SELECT k."preferencesHash"
			FROM "publishing_suggestion_cycle" k
			WHERE k."projectId" = ${projectId}
				AND ${countsAsRun()}
				AND k."organizationId" IS NOT DISTINCT FROM ${tenant.organizationId}
				AND k."userId" IS NOT DISTINCT FROM ${tenant.userId}
			ORDER BY k."startedAt" DESC
			LIMIT 1
		`,
	);
	return rows[0]?.preferencesHash ?? null;
}
