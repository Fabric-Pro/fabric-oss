import { db, Prisma } from "../client";
import {
	createReportAccessChecker,
	type ReportInstanceScope,
} from "./lib/report-access";
import { reportInstructions } from "./lib/report-instructions";

/** How many of a report's newest successful runs are inspected for one the caller may open. */
const LATEST_SUCCESS_CANDIDATE_LIMIT = 5;

/** The newest successful run of a report and the artifact its View action opens. */
export interface LatestSuccessfulReport {
	executionId: string;
	completedAt: Date | null;
	artifactId: string;
	artifactName: string;
}

/**
 * The newest successful run of each report that produced an artifact, keyed by
 * report id. A newer failed, cancelled or unfinished run never displaces it.
 * Each run passes the same access check as the report's execution history, so
 * a run bound to a project the caller cannot reach is skipped.
 */
export async function getLatestSuccessfulReports({
	instances,
	userId,
	organizationId,
}: {
	instances: Array<ReportInstanceScope & { id: string }>;
	userId: string;
	organizationId?: string | null;
}): Promise<Map<string, LatestSuccessfulReport>> {
	const latest = new Map<string, LatestSuccessfulReport>();
	if (instances.length === 0) {
		return latest;
	}
	const canRead = await createReportAccessChecker({
		userId,
		organizationId: organizationId ?? undefined,
	});
	await Promise.all(
		instances.map(async (instance) => {
			const candidates = await db.templateInstanceExecution.findMany({
				where: {
					instanceId: instance.id,
					status: "COMPLETED",
					artifacts: { some: {} },
				},
				orderBy: [
					{ completedAt: { sort: "desc", nulls: "last" } },
					{ createdAt: "desc" },
				],
				take: LATEST_SUCCESS_CANDIDATE_LIMIT,
				select: {
					id: true,
					completedAt: true,
					parameters: true,
					artifacts: {
						orderBy: { createdAt: "asc" },
						take: 1,
						select: { id: true, name: true },
					},
				},
			});
			for (const run of candidates) {
				const artifact = run.artifacts[0];
				if (artifact && (await canRead(instance, run.parameters))) {
					latest.set(instance.id, {
						executionId: run.id,
						completedAt: run.completedAt,
						artifactId: artifact.id,
						artifactName: artifact.name,
					});
					return;
				}
			}
		}),
	);
	return latest;
}

/** How many likely duplicates a warning lists. */
const DUPLICATE_RESULT_LIMIT = 10;

/** How many matching reports are loaded at a time for the access check. */
const DUPLICATE_ROW_BATCH = 50;

/** Titles and prompts compare without case or repeated whitespace. */
export function normalizeReportText(value: string | null | undefined): string {
	return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** A run of the whitespace `\s` and `trim()` match in JavaScript, as a Postgres regex. */
const WHITESPACE_RUN =
	"[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+";

/** {@link normalizeReportText} in SQL. */
function normalizedSql(value: Prisma.Sql): Prisma.Sql {
	return Prisma.sql`lower(btrim(regexp_replace(${value}, ${WHITESPACE_RUN}, ' ', 'g')))`;
}

/** `reportInstructions` in SQL: a person's own prompt, else the template's. */
function reportInstructionsSql(): Prisma.Sql {
	return Prisma.sql`CASE
		WHEN jsonb_typeof(ti.connections -> 'promptOverride') = 'string'
			AND ti.connections ->> 'promptOverrideSource' = 'user'
			AND ${normalizedSql(Prisma.sql`ti.connections ->> 'promptOverride'`)} <> ''
		THEN ti.connections ->> 'promptOverride'
		WHEN jsonb_typeof(rt.definition -> 'userPrompt') = 'string'
		THEN rt.definition ->> 'userPrompt'
		ELSE ''
	END`;
}

/**
 * The latest versions of the reports in scope whose title or prompt equals
 * the given ones, newest first. Compared in Postgres, so every report in
 * scope is compared, however many there are, and only matches are loaded.
 */
async function findDuplicateCandidateIds({
	userId,
	organizationId,
	projectId,
	title,
	instructions,
}: {
	userId: string;
	organizationId: string;
	projectId?: string;
	title: string;
	instructions: string;
}): Promise<string[]> {
	const matchesOn: Prisma.Sql[] = [];
	if (title) {
		matchesOn.push(
			Prisma.sql`${normalizedSql(Prisma.sql`ti.name`)} = ${normalizedSql(Prisma.sql`${title}`)}`,
		);
	}
	if (instructions) {
		matchesOn.push(
			Prisma.sql`${normalizedSql(reportInstructionsSql())} = ${normalizedSql(Prisma.sql`${instructions}`)}`,
		);
	}
	const owner = projectId
		? Prisma.sql`"projectId" = ${projectId}`
		: Prisma.sql`"userId" = ${userId}`;
	const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
		SELECT ti.id
		FROM (
			SELECT id, name, connections, "templateId", version, "updatedAt",
				max(version) OVER (PARTITION BY "sId") AS newest_version
			FROM template_instance
			WHERE "organizationId" = ${organizationId}
				AND ${owner}
				AND status IN ('ACTIVE', 'DRAFT')
		) ti
		JOIN report_template rt ON rt.id = ti."templateId"
		WHERE ti.version = ti.newest_version
			AND (${Prisma.join(matchesOn, " OR ")})
		ORDER BY ti."updatedAt" DESC, ti.id
	`);
	return rows.map((row) => row.id);
}

export interface LikelyDuplicateReport {
	id: string;
	name: string;
	templateName: string;
	status: string;
	isActive: boolean;
	ownedByCaller: boolean;
	createdAt: Date;
	lastRunAt: Date | null;
	sameTitle: boolean;
	samePrompt: boolean;
}

/**
 * Reports a new one would likely duplicate: the same title or the same
 * prompt, either one. With a project, every report the project's list shows
 * the caller is compared; without one, the caller's own reports in the
 * organization. Only reports the caller may open are returned.
 */
export async function findLikelyDuplicateReports({
	userId,
	organizationId,
	projectId,
	name,
	prompt,
}: {
	userId: string;
	organizationId: string;
	projectId?: string;
	name: string;
	prompt: string;
}): Promise<LikelyDuplicateReport[]> {
	const title = normalizeReportText(name);
	const instructions = normalizeReportText(prompt);
	if (!title && !instructions) {
		return [];
	}
	const candidateIds = await findDuplicateCandidateIds({
		userId,
		organizationId,
		projectId,
		title,
		instructions,
	});
	const canRead = await createReportAccessChecker({ userId, organizationId });
	const matches: LikelyDuplicateReport[] = [];
	for (
		let start = 0;
		start < candidateIds.length && matches.length < DUPLICATE_RESULT_LIMIT;
		start += DUPLICATE_ROW_BATCH
	) {
		const ids = candidateIds.slice(start, start + DUPLICATE_ROW_BATCH);
		const rows = await db.templateInstance.findMany({
			where: { id: { in: ids }, organizationId },
			select: {
				id: true,
				name: true,
				status: true,
				isActive: true,
				userId: true,
				organizationId: true,
				projectId: true,
				fabricConfig: true,
				connections: true,
				createdAt: true,
				lastRunAt: true,
				template: { select: { name: true, definition: true } },
			},
		});
		const rowsById = new Map(rows.map((row) => [row.id, row]));
		for (const id of ids) {
			const row = rowsById.get(id);
			if (!row) {
				continue;
			}
			// Postgres found the candidates; the comparison here is the rule.
			const sameTitle =
				title !== "" && normalizeReportText(row.name) === title;
			const samePrompt =
				instructions !== "" &&
				normalizeReportText(reportInstructions(row).instructions) ===
					instructions;
			if (!sameTitle && !samePrompt) {
				continue;
			}
			if (!(await canRead(row))) {
				continue;
			}
			matches.push({
				id: row.id,
				name: row.name,
				templateName: row.template.name,
				status: row.status,
				isActive: row.isActive,
				ownedByCaller: row.userId === userId,
				createdAt: row.createdAt,
				lastRunAt: row.lastRunAt,
				sameTitle,
				samePrompt,
			});
			if (matches.length === DUPLICATE_RESULT_LIMIT) {
				break;
			}
		}
	}
	return matches;
}
