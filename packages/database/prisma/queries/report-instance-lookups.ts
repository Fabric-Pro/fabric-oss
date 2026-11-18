import { db } from "../client";
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

/** How many reports a duplicate check compares against. */
const DUPLICATE_CANDIDATE_LIMIT = 500;

/** How many likely duplicates a warning lists. */
const DUPLICATE_RESULT_LIMIT = 10;

/** Titles and prompts compare without case or repeated whitespace. */
export function normalizeReportText(value: string | null | undefined): string {
	return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
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
	const rows = await db.templateInstance.findMany({
		where: {
			organizationId,
			...(projectId ? { projectId } : { userId }),
			status: { in: ["ACTIVE", "DRAFT"] },
		},
		orderBy: { updatedAt: "desc" },
		take: DUPLICATE_CANDIDATE_LIMIT,
		select: {
			id: true,
			sId: true,
			version: true,
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
	// Only a report's latest version is a report of its own.
	const newestVersion = new Map<string, number>();
	for (const row of rows) {
		newestVersion.set(
			row.sId,
			Math.max(newestVersion.get(row.sId) ?? 0, row.version),
		);
	}
	const canRead = await createReportAccessChecker({ userId, organizationId });
	const matches: LikelyDuplicateReport[] = [];
	for (const row of rows) {
		if (row.version !== newestVersion.get(row.sId)) {
			continue;
		}
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
	return matches;
}
