import { z } from "zod";
import { db } from "../client";
import {
	createReportAccessChecker,
	readReportProjectBindings,
} from "./lib/report-access";
import { projectReportDiagnostics } from "./lib/report-public-diagnostics";
import { loadReportDiagnosticSources } from "./report-diagnostic-labels";
export class NativeReportHistoryError extends Error {
	constructor(
		readonly code: "NOT_FOUND" | "BAD_REQUEST",
		message: string,
	) {
		super(message);
	}
}
const cursorSchema = z.object({
	v: z.literal(1),
	owner: z.string(),
	filter: z.string(),
	createdAt: z.string().datetime(),
	id: z.string().min(1).max(128),
});
type Position = { createdAt: Date; id: string };
const encode = (row: Position, owner: string, filter: string) =>
	Buffer.from(
		JSON.stringify({
			v: 1,
			owner,
			filter,
			createdAt: row.createdAt.toISOString(),
			id: row.id,
		}),
	).toString("base64url");
function decode(
	cursor: string | undefined,
	owner: string,
	filter: string,
): Position | undefined {
	if (!cursor) {
		return undefined;
	}
	try {
		const parsed = cursorSchema.parse(
			JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
		);
		if (parsed.owner !== owner || parsed.filter !== filter) {
			throw new Error();
		}
		return { id: parsed.id, createdAt: new Date(parsed.createdAt) };
	} catch {
		throw new NativeReportHistoryError(
			"BAD_REQUEST",
			"This history cursor belongs to different filters. Start from the first page.",
		);
	}
}
const after = (position?: Position) =>
	position
		? {
				OR: [
					{ createdAt: { lt: position.createdAt } },
					{ createdAt: position.createdAt, id: { lt: position.id } },
				],
			}
		: {};
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const scope = {
	userId: true,
	organizationId: true,
	fabricConfig: true,
	connections: true,
	template: { select: { connections: true, definition: true } },
} as const;
export interface NativeReportReader {
	userId: string;
	organizationId: string;
	boundProjectId?: string;
}
function withinBinding(
	actor: NativeReportReader,
	instance: { fabricConfig?: unknown },
	parameters?: unknown,
) {
	if (!actor.boundProjectId) {
		return true;
	}
	const bindings = readReportProjectBindings(
		instance.fabricConfig,
		parameters,
	);
	return bindings.length === 1 && bindings[0] === actor.boundProjectId;
}
/** Metadata only: callers fetch bytes through an independently authorized download. */
export function nativeReportArtifactReference(artifact: {
	id: string;
	executionId: string;
	name: string;
	artifactType: string;
	mimeType: string;
	size: number | null;
	createdAt: Date;
	metadata: unknown;
}) {
	const metadata = object(artifact.metadata);
	return {
		id: artifact.id,
		executionId: artifact.executionId,
		name: artifact.name,
		artifactType: artifact.artifactType,
		mimeType: artifact.mimeType,
		size: artifact.size,
		createdAt: artifact.createdAt.toISOString(),
		linkedFrameId:
			typeof metadata.linkedFrameId === "string"
				? metadata.linkedFrameId
				: null,
		artifactHash:
			typeof metadata.sha256 === "string" &&
			/^[a-f0-9]{64}$/.test(metadata.sha256)
				? metadata.sha256
				: null,
	};
}
const artifactSelection = {
	id: true,
	executionId: true,
	name: true,
	artifactType: true,
	mimeType: true,
	size: true,
	createdAt: true,
	metadata: true,
} as const;
/** Stable keyset pagination; at most 500 candidates checked per call, independent of total run count. */
export async function listNativeReportExecutions(
	actor: NativeReportReader,
	input: {
		instanceId: string;
		limit?: number;
		cursor?: string;
		status?: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
	},
) {
	const limit = z
		.number()
		.int()
		.min(1)
		.max(50)
		.parse(input.limit ?? 10);
	const filter = input.status ?? "all";
	let position = decode(input.cursor, input.instanceId, filter);
	const canRead = await createReportAccessChecker(actor);
	const instance = await db.templateInstance.findFirst({
		where: { id: input.instanceId, organizationId: actor.organizationId },
		select: scope,
	});
	if (
		!instance ||
		!(await canRead(instance)) ||
		!withinBinding(actor, instance)
	) {
		throw new NativeReportHistoryError("NOT_FOUND", "Report not found");
	}
	const diagnosticSources = await loadReportDiagnosticSources(
		actor,
		instance,
	);
	const executions = [];
	for (let batch = 0; batch < 10; batch++) {
		const rows = await db.templateInstanceExecution.findMany({
			where: {
				instanceId: input.instanceId,
				organizationId: actor.organizationId,
				...(input.status ? { status: input.status } : {}),
				...after(position),
			},
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: 51,
			select: {
				id: true,
				instanceId: true,
				userId: true,
				status: true,
				startedAt: true,
				completedAt: true,
				duration: true,
				error: true,
				mcpDiagnostics: true,
				createdAt: true,
				parameters: true,
				artifacts: {
					select: artifactSelection,
					take: 50,
					orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				},
			},
		});
		const candidates = rows.slice(0, 50);
		for (let index = 0; index < candidates.length; index++) {
			const row = candidates[index];
			if (!row) {
				continue;
			}
			position = { id: row.id, createdAt: row.createdAt };
			if (
				(await canRead(instance, row.parameters)) &&
				withinBinding(actor, instance, row.parameters)
			) {
				executions.push({
					id: row.id,
					instanceId: row.instanceId,
					userId: row.userId,
					status: row.status,
					startedAt: row.startedAt?.toISOString() ?? null,
					completedAt: row.completedAt?.toISOString() ?? null,
					duration: row.duration,
					error: row.error
						? "The report did not finish. Review its run details before trying again."
						: null,
					mcpDiagnostics: projectReportDiagnostics(
						row.mcpDiagnostics,
						diagnosticSources,
					),
					createdAt: row.createdAt.toISOString(),
					artifacts:
						row.status === "CANCELLED"
							? []
							: row.artifacts.map(nativeReportArtifactReference),
				});
			}
			if (executions.length === limit) {
				const hasMore =
					index < candidates.length - 1 || rows.length > 50;
				return {
					executions,
					hasMore,
					nextCursor: hasMore
						? encode(position, input.instanceId, filter)
						: null,
				};
			}
		}
		if (rows.length <= 50) {
			return { executions, hasMore: false, nextCursor: null };
		}
	}
	return {
		executions,
		hasMore: true,
		nextCursor: position
			? encode(position, input.instanceId, filter)
			: null,
	};
}
export async function listNativeReportArtifacts(
	actor: NativeReportReader,
	input: {
		executionId: string;
		limit?: number;
		cursor?: string;
		artifactType?:
			| "MARKDOWN"
			| "PDF"
			| "HTML"
			| "EVIDENCE_EMBED"
			| "CHART_DATA"
			| "CSV"
			| "JSON";
	},
) {
	const limit = z
		.number()
		.int()
		.min(1)
		.max(50)
		.parse(input.limit ?? 20);
	const filter = input.artifactType ?? "all";
	const position = decode(input.cursor, input.executionId, filter);
	const canRead = await createReportAccessChecker(actor);
	const execution = await db.templateInstanceExecution.findFirst({
		where: { id: input.executionId, organizationId: actor.organizationId },
		select: { status: true, parameters: true, instance: { select: scope } },
	});
	if (
		!execution ||
		!(await canRead(execution.instance, execution.parameters)) ||
		!withinBinding(actor, execution.instance, execution.parameters)
	) {
		throw new NativeReportHistoryError(
			"NOT_FOUND",
			"Report execution not found",
		);
	}
	if (execution.status === "CANCELLED") {
		return { artifacts: [], hasMore: false, nextCursor: null };
	}
	const rows = await db.templateInstanceArtifact.findMany({
		where: {
			executionId: input.executionId,
			organizationId: actor.organizationId,
			...(input.artifactType ? { artifactType: input.artifactType } : {}),
			...after(position),
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: limit + 1,
		select: artifactSelection,
	});
	const artifacts = rows.slice(0, limit);
	const last = artifacts.at(-1);
	const hasMore = rows.length > limit;
	return {
		artifacts: artifacts.map(nativeReportArtifactReference),
		hasMore,
		nextCursor:
			hasMore && last ? encode(last, input.executionId, filter) : null,
	};
}
