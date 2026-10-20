import { db, Prisma } from "../../client";

export interface AdoReviewBaselineBinding {
	userId: string;
	organizationId: string;
	projectId: string;
	workflowId: string;
	nodeId: string;
	selectionFingerprint: string;
}

export interface AdoReviewBaselineCandidate {
	id: string;
	completedAt: Date;
	cache: Prisma.JsonValue;
}

export interface AdoReviewBaselinePage {
	candidates: AdoReviewBaselineCandidate[];
	hasMore: boolean;
}

const CANDIDATE_LIMIT = 5;
// The authoritative cache limit is 600,000 UTF-16 units. Allow UTF-8 and JSONB spacing headroom.
const CACHE_TRANSPORT_MAX_BYTES = 4 * 600_000;
const ISO_TIMESTAMP_PATTERN =
	"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$";
const isoTimestamp = new RegExp(ISO_TIMESTAMP_PATTERN);

// Strip fractions before the timestamp cast; PostgreSQL otherwise rounds seven-digit ADO times.
function watermark(value: Prisma.Sql): Prisma.Sql {
	return Prisma.sql`CASE WHEN length(${value}) <= 64 AND ${value} ~ ${ISO_TIMESTAMP_PATTERN}
		THEN CASE WHEN pg_input_is_valid(${value}, 'timestamp with time zone')
			THEN extract(epoch FROM regexp_replace(${value}, '[.][0-9]+', '')::timestamptz)
				+ COALESCE(('0.' || substring(${value} FROM '[.]([0-9]+)'))::numeric, 0)
		END END`;
}

/** Independent, bounded cache projections; manual captures cannot replace the scheduled comparison. */
export async function listAdoReviewBaselines(options: {
	cacheVersion?: 1 | 2;
	binding: AdoReviewBaselineBinding;
	executionId: string;
	evaluatorFingerprint: string;
	requirementsAsOf: string;
	captureStartedAt: string;
}): Promise<{
	analysis: AdoReviewBaselinePage;
	comparison: AdoReviewBaselinePage;
}> {
	const { binding } = options;
	const cacheVersion =
		options.cacheVersion === undefined ? 1 : options.cacheVersion;
	const requirementsAsOf = new Date(options.requirementsAsOf);
	const captureStartedAt = new Date(options.captureStartedAt);
	if (
		(cacheVersion !== 1 && cacheVersion !== 2) ||
		Object.values(binding).some((value) => !value || value.length > 128) ||
		!options.executionId ||
		options.executionId.length > 128 ||
		options.requirementsAsOf.length > 64 ||
		options.captureStartedAt.length > 64 ||
		!isoTimestamp.test(options.requirementsAsOf) ||
		!isoTimestamp.test(options.captureStartedAt) ||
		!Number.isFinite(requirementsAsOf.getTime()) ||
		!Number.isFinite(captureStartedAt.getTime()) ||
		!/^[a-f0-9]{64}$/.test(options.evaluatorFingerprint) ||
		!/^[a-f0-9]{64}$/.test(binding.selectionFingerprint)
	) {
		throw new RangeError(
			"Invalid story review baseline binding or capture time.",
		);
	}
	const cutoff = watermark(Prisma.sql`${options.requirementsAsOf}::text`);
	const rows = await db.$transaction(
		(tx) => tx.$queryRaw<
			Array<
				AdoReviewBaselineCandidate & { kind: "analysis" | "comparison" }
			>
		>`
			WITH scoped AS (
				SELECT e.id, e."completedAt", e."triggerType", e.output -> ${binding.nodeId} -> 'cache' AS cache
				FROM workflow_execution e
				JOIN workflow w ON w.id = e."workflowId"
				WHERE e."workflowId" = ${binding.workflowId}
					AND e."userId" = ${binding.userId} AND e."organizationId" = ${binding.organizationId}
					AND w."userId" = ${binding.userId} AND w."organizationId" = ${binding.organizationId}
					AND w."projectId" = ${binding.projectId}
					AND e.status = 'COMPLETED' AND e."completedAt" <= ${options.captureStartedAt}::timestamptz
					AND e.id <> ${options.executionId}
					AND jsonb_typeof(e.output -> ${binding.nodeId} -> 'cache') = 'object'
					AND e.output -> ${binding.nodeId} -> 'cache' -> 'version' = ${String(cacheVersion)}::jsonb
					AND e.output -> ${binding.nodeId} -> 'cache' ->> 'userId' = ${binding.userId}
					AND e.output -> ${binding.nodeId} -> 'cache' ->> 'organizationId' = ${binding.organizationId}
					AND e.output -> ${binding.nodeId} -> 'cache' ->> 'projectId' = ${binding.projectId}
					AND e.output -> ${binding.nodeId} -> 'cache' ->> 'workflowId' = ${binding.workflowId}
					AND e.output -> ${binding.nodeId} -> 'cache' ->> 'nodeId' = ${binding.nodeId}
					AND e.output -> ${binding.nodeId} -> 'cache' ->> 'selectionFingerprint' = ${binding.selectionFingerprint}
			), dated AS (
				SELECT id, "completedAt", "triggerType", cache,
					${watermark(Prisma.sql`cache ->> 'requirementsAsOf'`)} AS watermark
				FROM scoped
			)
			SELECT branch.kind, candidate.id, candidate."completedAt", candidate.cache
			FROM (VALUES ('analysis'), ('comparison')) AS branch(kind)
			CROSS JOIN LATERAL (
				SELECT id, "completedAt", watermark,
					CASE WHEN octet_length(cache::text) <= ${CACHE_TRANSPORT_MAX_BYTES} THEN cache ELSE NULL END AS cache
				FROM dated
				WHERE (watermark IS NULL OR watermark <= ${cutoff})
					AND (branch.kind = 'comparison' AND "triggerType" = 'SCHEDULE'
						OR branch.kind = 'analysis' AND cache ->> 'evaluatorFingerprint' = ${options.evaluatorFingerprint})
				ORDER BY watermark DESC NULLS LAST, "completedAt" DESC, id DESC
				LIMIT ${CANDIDATE_LIMIT + 1}
			) candidate
			ORDER BY branch.kind, candidate.watermark DESC NULLS LAST, candidate."completedAt" DESC, candidate.id DESC
		`,
		{ maxWait: 5_000, timeout: 10_000 },
	);
	function page(kind: "analysis" | "comparison"): AdoReviewBaselinePage {
		const matching = rows.filter((row) => row.kind === kind);
		return {
			candidates: matching
				.slice(0, CANDIDATE_LIMIT)
				.map(({ id, completedAt, cache }) => ({
					id,
					completedAt,
					cache,
				})),
			hasMore: matching.length > CANDIDATE_LIMIT,
		};
	}
	return { analysis: page("analysis"), comparison: page("comparison") };
}
