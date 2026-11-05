import { createHash } from "node:crypto";
import { db } from "../client";
import { Prisma } from "../generated/client";
import { canExecuteReportInstance } from "./lib/report-access";
import {
	isProjectKnowledgeSource,
	projectKnowledgeSelectionSchema,
	REPORT_EXECUTION_SNAPSHOT_KEY,
	reportExecutionSnapshotSchema,
} from "./lib/report-evidence";
import { getTemplateInstanceExecution } from "./reports";

interface KnowledgeRow {
	id: string;
	title: string;
	content: string;
	revision: string;
	updatedAt: Date;
	truncated: boolean;
}

/** This reader accepts no project argument. Only the admitted, authorized report
 * supplies it. SQL bounds body bytes before transport and fences tenant/project/source
 * IDs in the same revision-consistent SELECT. Store-only context never enters reports.
 */
export async function getReportProjectKnowledge(input: {
	executionId: string;
	sourceId: string;
	userId: string;
	organizationId: string;
	dateRange?: { start: string; end: string };
}) {
	const caller = {
		userId: input.userId,
		organizationId: input.organizationId,
	};
	const execution = await getTemplateInstanceExecution(
		input.executionId,
		caller,
	);
	if (
		!execution ||
		execution.userId !== input.userId ||
		execution.status === "CANCELLED" ||
		!(await canExecuteReportInstance(
			execution.instance,
			caller,
			execution.parameters,
		))
	) {
		throw new Error("Project knowledge access denied");
	}
	const snapshot = reportExecutionSnapshotSchema.parse(
		(execution.parameters as Record<string, unknown> | null)?.[
			REPORT_EXECUTION_SNAPSHOT_KEY
		],
	);
	if (
		snapshot.instanceId !== execution.instanceId ||
		snapshot.userId !== input.userId ||
		snapshot.organizationId !== input.organizationId ||
		!snapshot.config?.projectId ||
		!snapshot.window
	) {
		throw new Error(
			"Project knowledge requires an admitted project report",
		);
	}
	const definition = snapshot.instance.template as
		| { definition?: { dataSources?: unknown[] } }
		| undefined;
	const source = definition?.definition?.dataSources?.find(
		(row) =>
			row &&
			typeof row === "object" &&
			(row as { id?: string }).id === input.sourceId,
	);
	if (!isProjectKnowledgeSource(source)) {
		throw new Error("Project knowledge source is not admitted");
	}
	const config = projectKnowledgeSelectionSchema.parse(
		(source as { config?: unknown }).config ?? {},
	);
	const projectId = snapshot.config.projectId;
	const ranges = [
		snapshot.window,
		...(snapshot.window.comparison ? [snapshot.window.comparison] : []),
	];
	const range = input.dateRange
		? ranges.find(
				(candidate) =>
					Date.parse(candidate.start) ===
						Date.parse(input.dateRange?.start ?? "") &&
					Date.parse(candidate.end) ===
						Date.parse(input.dateRange?.end ?? ""),
			)
		: snapshot.window;
	if (!range) {
		throw new Error("Project knowledge evidence window is not admitted");
	}
	const cutoff = new Date(
		Math.min(Date.parse(snapshot.window.cutoff), Date.parse(range.end)),
	);

	if (!Number.isFinite(cutoff.getTime())) {
		throw new Error("Invalid project knowledge cutoff");
	}
	const documentIds = config.documentIds
		? Prisma.sql`AND d.id IN (${Prisma.join(config.documentIds.length ? config.documentIds : [""])})`
		: Prisma.empty;
	const contextIds = config.contextIds
		? Prisma.sql`AND c.id IN (${Prisma.join(config.contextIds.length ? config.contextIds : [""])})`
		: Prisma.empty;
	const [documents, contexts] = await Promise.all([
		db.$queryRaw<
			KnowledgeRow[]
		>(Prisma.sql`SELECT d.id, d.title, left(d.content, 6000) AS content, d.version::text AS revision, d."updatedAt", length(d.content) > 6000 AS truncated
		FROM project_document d JOIN project p ON p.id = d."projectId" AND p."organizationId" = ${input.organizationId} AND p."deletedAt" IS NULL
		WHERE d."organizationId" = ${input.organizationId} AND d."projectId" = ${projectId} AND d."isActive" = true AND d.status = 'COMPLETE' AND d.source = 'GENERATED' AND d."sourceContextId" IS NULL AND d."updatedAt" < ${cutoff}
		${documentIds}
		ORDER BY d."updatedAt" DESC, d.id ASC LIMIT ${config.limit + 1}`),
		db.$queryRaw<
			KnowledgeRow[]
		>(Prisma.sql`SELECT c.id, COALESCE(c."sourceTitle", c."originalFilename", 'Project context') AS title, left(c.content, 6000) AS content, COALESCE(c."sourceBlobOid", c."updatedAt"::text) AS revision, c."updatedAt", length(c.content) > 6000 AS truncated
		FROM project_context c JOIN project p ON p.id = c."projectId" AND p."organizationId" = ${input.organizationId} AND p."deletedAt" IS NULL
		WHERE c."organizationId" = ${input.organizationId} AND c."projectId" = ${projectId} AND c."indexingExcluded" = false AND COALESCE(lower(c.metadata->>'visibility'), 'shared') NOT IN ('private', 'personal', 'owner') AND COALESCE(c.metadata->>'isPrivate', 'false') <> 'true' AND COALESCE(lower(c.metadata->>'scope'), 'project') NOT IN ('user', 'private', 'personal') AND COALESCE(c.metadata->>'shared', 'true') <> 'false' AND c.type = 'TEXT' AND c."extractionStatus" NOT IN ('FAILED', 'CANCELLED', 'EXTRACTING') AND c."updatedAt" < ${cutoff} AND length(c.content) > 0 ${contextIds}
		ORDER BY c."updatedAt" DESC, c.id ASC LIMIT ${config.limit + 1}`),
	]);
	const records = [
		...documents
			.slice(0, config.limit)
			.map((row) => ({ ...row, kind: "document" })),
		...contexts
			.slice(0, config.limit)
			.map((row) => ({ ...row, kind: "context" })),
	].map((row) => ({
		...row,
		title: row.title.slice(0, 300),
		updatedAt: new Date(row.updatedAt).toISOString(),
		projectId,
		excerptHash: createHash("sha256").update(row.content).digest("hex"),
		citation:
			row.kind === "document"
				? `projects/${projectId}/documents/${row.id}`
				: `projects/${encodeURIComponent(projectId)}?tab=context&source=${encodeURIComponent(row.id)}`,
		historicalCompleteness: "unverified",
	}));
	return {
		records,
		hasMore:
			documents.length > config.limit || contexts.length > config.limit,
		cutoff: cutoff.toISOString(),
	};
}
