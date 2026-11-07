import {
	db,
	loadRunQualityTarget,
	type Prisma,
	qualityDigest,
	qualityTargetWhere,
	recordAuditTx,
} from "@repo/database";
import { WorkspaceDocumentContentError } from "@repo/database/prisma/queries/workspaces/document-content";
import {
	AgentTestError,
	agentTestScopeSchema,
} from "@repo/temporal/agent-test-contracts";
import { getTemporalClient } from "@repo/temporal/client";
import {
	assertRunQualitySourceAccess,
	snapshotRunQualitySources,
} from "@repo/temporal/run-quality-source-access";
import {
	compareSchema,
	configureSchema,
	identitySchema,
	listSchema,
	type RunQualityActor,
	RunQualityError,
	runQualityAssessmentSchema,
	runQualityComparisonResultSchema,
	runQualityPolicyResultSchema,
	runQualityTargetSchema,
} from "@repo/utils/run-quality-contracts";
import { z } from "zod";
import type { AgentPreviewSelectionPolicy } from "../../agents/lib/agent-preview-selection-policy";

type Assessment = NonNullable<
	Awaited<ReturnType<typeof db.runQualityAssessment.findFirst>>
>;
const json = (value: unknown) => value as Prisma.InputJsonValue;
async function target(actor: RunQualityActor, raw: unknown, write = false) {
	const selected = runQualityTargetSchema.parse(raw);
	if (write) {
		await loadRunQualityTarget(actor, selected, false);
	}
	const source = await loadRunQualityTarget(actor, selected, write);
	return { selected, source };
}
const scope = (actor: RunQualityActor) => ({
	organizationId: actor.organizationId,
	userId: actor.userId,
});
export type RunQualitySelectionPolicy = AgentPreviewSelectionPolicy;
async function selectionCeiling(
	raw: unknown,
	policy?: RunQualitySelectionPolicy,
) {
	if (!policy) {
		return;
	}
	const source = z
		.object({ kind: z.enum(["AGENT", "WORKFLOW"]) })
		.safeParse(raw);
	if (!source.success) {
		throw new RunQualityError(
			"NOT_FOUND",
			"Source selectors are unavailable.",
		);
	}
	if (source.data.kind === "AGENT") {
		const saved = z.object({ scope: agentTestScopeSchema }).safeParse(raw);
		if (!saved.success) {
			throw new RunQualityError(
				"NOT_FOUND",
				"Source selectors are unavailable.",
			);
		}
		await policy(saved.data.scope);
	} else {
		const saved = z
			.object({
				workspaceIds: z.array(z.string()),
				skillIds: z.array(z.string()).optional(),
			})
			.safeParse(raw);
		if (!saved.success) {
			throw new RunQualityError(
				"NOT_FOUND",
				"Source selectors are unavailable.",
			);
		}
		await policy({
			workspaceIds: saved.data.workspaceIds,
			skillIds: saved.data.skillIds ?? [],
		});
	}
}
async function currentSources(
	actor: RunQualityActor,
	selected: ReturnType<typeof runQualityTargetSchema.parse>,
	policy?: RunQualitySelectionPolicy,
) {
	let snapshot: unknown;
	try {
		snapshot = await snapshotRunQualitySources(actor, selected);
	} catch (error) {
		if (deniedSource(error)) {
			throw new RunQualityError(
				"NOT_FOUND",
				"Current source access is unavailable.",
			);
		}
		throw error;
	}
	await selectionCeiling(snapshot, policy);
	return snapshot;
}
async function authorizeAssessmentSources(
	actor: RunQualityActor,
	row: Assessment,
	policy?: RunQualitySelectionPolicy,
) {
	if (
		z
			.strictObject({ kind: z.literal("UNAVAILABLE") })
			.safeParse(row.sourceScopeJson).success
	) {
		if (row.reportJson !== null) {
			throw new RunQualityError(
				"NOT_FOUND",
				"Assessment source evidence is unavailable.",
			);
		}
		return;
	}
	try {
		await assertRunQualitySourceAccess(actor, row.sourceScopeJson);
	} catch (error) {
		if (deniedSource(error)) {
			throw new RunQualityError(
				"NOT_FOUND",
				"Assessment source access is unavailable.",
			);
		}
		throw error;
	}
	await selectionCeiling(row.sourceScopeJson, policy);
}
async function assessment(
	actor: RunQualityActor,
	selected: ReturnType<typeof runQualityTargetSchema.parse>,
	id: string,
	policy?: RunQualitySelectionPolicy,
) {
	const row = await db.runQualityAssessment.findFirst({
		where: {
			id,
			...scope(actor),
			policy: { ...qualityTargetWhere(selected), ...scope(actor) },
		},
	});
	if (!row) {
		throw new RunQualityError("NOT_FOUND", "Assessment not found.");
	}
	await authorizeAssessmentSources(actor, row, policy);
	return row;
}
function deniedSource(error: unknown): boolean {
	return (
		(error instanceof RunQualityError ||
			error instanceof AgentTestError ||
			error instanceof WorkspaceDocumentContentError) &&
		["NOT_FOUND", "FORBIDDEN"].includes(error.code)
	);
}
function retainedDate(value: Date | null) {
	return value === null
		? null
		: value instanceof Date && Number.isFinite(value.getTime())
			? value.toISOString()
			: undefined;
}
function summary(
	row: Assessment,
	selected: ReturnType<typeof runQualityTargetSchema.parse>,
) {
	const parsed = runQualityAssessmentSchema.safeParse({
		id: row.id,
		...selected,
		executionId: row.workflowExecutionId ?? row.agentExecutionId ?? "",
		policyRevision: row.policyRevision,
		sourceVersion: row.sourceVersion,
		status: row.status,
		verdict: row.verdict,
		report: row.reportJson,
		errorCode: row.errorCode,
		createdAt: retainedDate(row.createdAt),
		completedAt: retainedDate(row.completedAt),
	});
	if (!parsed.success) {
		throw new RunQualityError(
			"UNAVAILABLE",
			"The retained assessment could not be verified. Inspect its business execution.",
		);
	}
	return parsed.data;
}

export async function getRunQualityPolicy(
	actor: RunQualityActor,
	raw: unknown,
	policy?: RunQualitySelectionPolicy,
) {
	const { selected } = await target(actor, raw);
	await currentSources(actor, selected, policy);
	const storedPolicy = await db.runQualityPolicy.findFirst({
		where: { ...scope(actor), ...qualityTargetWhere(selected) },
	});
	let canConfigure = false;
	try {
		await loadRunQualityTarget(actor, selected, true);
		canConfigure = true;
	} catch (error) {
		if (!deniedSource(error)) {
			throw error; /* Read access never grants configuration authority. */
		}
	}
	const parsed = runQualityPolicyResultSchema.safeParse({
		...selected,
		canConfigure,
		policy: storedPolicy
			? {
					id: storedPolicy.id,
					revision: storedPolicy.revision,
					enabled: storedPolicy.enabled,
					rules: storedPolicy.rulesJson,
					updatedAt: storedPolicy.updatedAt.toISOString(),
				}
			: null,
	});
	if (!parsed.success) {
		throw new RunQualityError(
			"UNAVAILABLE",
			"The saved checking policy could not be verified. Refresh it before making changes.",
		);
	}
	return parsed.data;
}
export async function configureRunQualityPolicy(
	actor: RunQualityActor,
	raw: unknown,
	policy?: RunQualitySelectionPolicy,
) {
	const input = configureSchema.parse(raw);
	const { selected, source } = await target(
		actor,
		{ targetType: input.targetType, targetId: input.targetId },
		true,
	);
	await currentSources(actor, selected, policy);
	const nodes = Array.isArray(source.nodes)
		? new Set(
				source.nodes.flatMap((node: any) =>
					typeof node?.id === "string" ? [node.id] : [],
				),
			)
		: new Set<string>();
	if (
		input.rules.some((rule) =>
			selected.targetType === "WORKFLOW"
				? !rule.nodeId || !nodes.has(rule.nodeId)
				: rule.nodeId !== undefined,
		)
	) {
		throw new RunQualityError(
			"BAD_REQUEST",
			"Choose an existing step for workflow checks; agent checks use the agent result.",
		);
	}
	if (Buffer.byteLength(JSON.stringify(input.rules)) > 65_536) {
		throw new RunQualityError(
			"BAD_REQUEST",
			"The check definitions are too large.",
		);
	}
	await db.$transaction(async (tx) => {
		const existing = await tx.runQualityPolicy.findFirst({
			where: { ...scope(actor), ...qualityTargetWhere(selected) },
		});
		if ((existing?.revision ?? 0) !== input.expectedRevision) {
			throw new RunQualityError(
				"CONFLICT",
				"The checking policy changed. Review the latest settings.",
			);
		}
		let saved;
		if (existing) {
			const changed = await tx.runQualityPolicy.updateMany({
				where: {
					id: existing.id,
					...scope(actor),
					revision: input.expectedRevision,
				},
				data: {
					enabled: input.enabled,
					rulesJson: json(input.rules),
					revision: { increment: 1 },
				},
			});
			if (changed.count !== 1) {
				throw new RunQualityError(
					"CONFLICT",
					"The checking policy changed. Review the latest settings.",
				);
			}
			saved = { id: existing.id, revision: existing.revision + 1 };
		} else {
			try {
				saved = await tx.runQualityPolicy.create({
					data: {
						...scope(actor),
						...qualityTargetWhere(selected),
						enabled: input.enabled,
						rulesJson: json(input.rules),
					},
				});
			} catch (error) {
				if ((error as { code?: string }).code === "P2002") {
					throw new RunQualityError(
						"CONFLICT",
						"The checking policy changed. Review the latest settings.",
					);
				}
				throw error;
			}
		}
		await recordAuditTx(tx, {
			action: "quality.policy_configured",
			category: "org",
			organizationId: actor.organizationId,
			actor: { type: "user", userId: actor.userId },
			resource: { type: "quality_policy", id: saved.id },
			metadata: {
				targetType: selected.targetType,
				targetId: selected.targetId,
				revision: saved.revision,
				enabled: input.enabled,
				checkCount: input.rules.length,
			},
		});
	});
	return getRunQualityPolicy(actor, selected, policy);
}
export async function listRunQualityAssessments(
	actor: RunQualityActor,
	raw: unknown,
	policy?: RunQualitySelectionPolicy,
) {
	const input = listSchema.parse(raw);
	const { selected } = await target(actor, {
		targetType: input.targetType,
		targetId: input.targetId,
	});
	const rows = await db.runQualityAssessment.findMany({
		where: {
			...scope(actor),
			policy: { ...scope(actor), ...qualityTargetWhere(selected) },
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		skip: input.offset,
		take: input.limit + 1,
	});
	const visible: ReturnType<typeof summary>[] = [];
	let unavailableCount = 0;
	for (const row of rows.slice(0, input.limit)) {
		try {
			await authorizeAssessmentSources(actor, row, policy);
		} catch (error) {
			if (deniedSource(error)) {
				continue;
			}
			throw error;
		}
		try {
			visible.push(summary(row, selected));
		} catch (error) {
			// Only malformed retained DTOs are skipped. Database/source errors above
			// still fail the request; no private report fields leave this boundary.
			if (
				error instanceof RunQualityError &&
				error.code === "UNAVAILABLE"
			) {
				unavailableCount++;
				continue;
			}
			throw error;
		}
	}
	return {
		assessments: visible,
		hasMore: rows.length > input.limit,
		unavailableCount,
	};
}
export async function getRunQualityAssessment(
	actor: RunQualityActor,
	raw: unknown,
	policy?: RunQualitySelectionPolicy,
) {
	const input = identitySchema.parse(raw);
	const { selected } = await target(actor, {
		targetType: input.targetType,
		targetId: input.targetId,
	});
	return summary(
		await assessment(actor, selected, input.assessmentId, policy),
		selected,
	);
}
export async function cancelRunQualityAssessment(
	actor: RunQualityActor,
	raw: unknown,
	policy?: RunQualitySelectionPolicy,
) {
	const input = identitySchema.parse(raw);
	const { selected } = await target(
		actor,
		{ targetType: input.targetType, targetId: input.targetId },
		true,
	);
	const row = await assessment(actor, selected, input.assessmentId, policy);
	if (["PENDING", "CHECKING"].includes(row.status)) {
		await db.$transaction(async (tx) => {
			const changed = await tx.runQualityAssessment.updateMany({
				where: {
					id: row.id,
					...scope(actor),
					status: { in: ["PENDING", "CHECKING"] },
				},
				data: {
					status: "CANCELLED",
					verdict: "UNAVAILABLE",
					errorCode: "ASSESSMENT_CANCELLED",
					completedAt: new Date(),
				},
			});
			if (changed.count) {
				await recordAuditTx(tx, {
					action: "quality.assessment_cancelled",
					category: "org",
					organizationId: actor.organizationId,
					actor: { type: "user", userId: actor.userId },
					resource: { type: "quality_assessment", id: row.id },
					metadata: {
						targetType: selected.targetType,
						targetId: selected.targetId,
					},
				});
			}
		});
		try {
			const client = await getTemporalClient();
			const probe = client.workflow.getHandle(
				row.assessmentWorkflowId,
				row.assessmentRunId ?? undefined,
				{ followRuns: false },
			);
			const described = await probe.describe();
			const memo = z
				.strictObject({
					version: z.literal(1),
					assessmentId: z.literal(row.id),
					userId: z.literal(actor.userId),
					organizationId: z.literal(actor.organizationId),
				})
				.safeParse(described.memo?.fabricRunQuality);
			if (
				described.type === "recordedRunQualityWorkflow" &&
				typeof described.runId === "string" &&
				memo.success &&
				(!row.assessmentRunId ||
					described.runId === row.assessmentRunId) &&
				described.status.name === "RUNNING"
			) {
				await client.workflow
					.getHandle(row.assessmentWorkflowId, described.runId, {
						followRuns: false,
					})
					.cancel();
			}
		} catch {
			/* The committed cancellation fence prevents late publication, including when Temporal is unavailable. */
		}
	}
	return getRunQualityAssessment(actor, input, policy);
}
export async function compareRunQualityAssessments(
	actor: RunQualityActor,
	raw: unknown,
	policy?: RunQualitySelectionPolicy,
) {
	const input = compareSchema.parse(raw);
	const { selected } = await target(actor, {
		targetType: input.targetType,
		targetId: input.targetId,
	});
	const [left, right] = await Promise.all([
		assessment(actor, selected, input.leftId, policy),
		assessment(actor, selected, input.rightId, policy),
	]);
	if (
		input.leftId === input.rightId ||
		left.status !== "COMPLETED" ||
		right.status !== "COMPLETED"
	) {
		throw new RunQualityError(
			"CONFLICT",
			"Choose two different completed assessments.",
		);
	}
	const leftDTO = summary(left, selected);
	const rightDTO = summary(right, selected);
	if (
		left.rulesHash !== right.rulesHash ||
		!leftDTO.report ||
		!rightDTO.report ||
		leftDTO.report.scorerVersion !== rightDTO.report.scorerVersion
	) {
		throw new RunQualityError(
			"CONFLICT",
			"Compare completed assessments with the same check definitions and scorer version.",
		);
	}
	return runQualityComparisonResultSchema.parse({
		left: leftDTO,
		right: rightDTO,
		changes: {
			sameChecks: true,
			sourceVersionChanged: left.sourceVersion !== right.sourceVersion,
			verdictChanged: left.verdict !== right.verdict,
			sourceScopeChanged:
				qualityDigest(left.sourceScopeJson) !==
				qualityDigest(right.sourceScopeJson),
		},
	});
}
