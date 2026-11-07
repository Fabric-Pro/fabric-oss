import { createHash } from "node:crypto";
import {
	type RunQualityActor,
	RunQualityError,
	type RunQualityTarget,
	runQualityRulesSchema,
} from "@repo/utils/run-quality-contracts";
import { db, type Prisma } from "../client";
import { getAgentTemplateInstanceForRead } from "./agent-instance-execution-scope";
import { recordAuditTx } from "./audit-log";
import {
	canConfigureOrganizationAgentQuality,
	canReadOrganizationAgents,
	canReadOrganizationWorkflows,
	canUpdateOrganizationWorkflows,
} from "./organization-permissions";
import {
	canEditProject,
	hasProjectAccess,
	isProjectSoftDeleted,
} from "./projects/projects";
import { getWorkflowById } from "./workflows/workflows";

export const qualityDigest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const qualityTargetWhere = (target: RunQualityTarget) =>
	target.targetType === "WORKFLOW"
		? { workflowId: target.targetId, instanceId: null }
		: { instanceId: target.targetId, workflowId: null };

/** Scope and current authority are repeated by API commands and background assessments. */
export async function loadRunQualityTarget(
	actor: RunQualityActor,
	target: RunQualityTarget,
	write = false,
) {
	if (!actor.organizationId || !actor.userId)
		throw new RunQualityError(
			"FORBIDDEN",
			"An organization and current member are required.",
		);
	const permitted =
		target.targetType === "WORKFLOW"
			? await (write
					? canUpdateOrganizationWorkflows
					: canReadOrganizationWorkflows)(
					actor.userId,
					actor.organizationId,
				)
			: await (write
					? canConfigureOrganizationAgentQuality
					: canReadOrganizationAgents)(
					actor.userId,
					actor.organizationId,
				);
	if (!permitted)
		throw new RunQualityError(
			"FORBIDDEN",
			"Your current role cannot access these quality controls.",
		);
	if (target.targetType === "WORKFLOW") {
		const row = await getWorkflowById(
			target.targetId,
			actor.userId,
			actor.organizationId,
		);
		if (!row) throw new RunQualityError("NOT_FOUND", "Workflow not found.");
		await project(actor, row.projectId, write);
		return {
			version: row.version,
			projectId: row.projectId,
			nodes: row.nodes,
			updatedAt: row.updatedAt,
		};
	}
	const scoped = await getAgentTemplateInstanceForRead({
		instanceId: target.targetId,
		...actor,
	});
	if (!scoped || scoped.instance.userId !== actor.userId)
		throw new RunQualityError(
			"NOT_FOUND",
			"Agent not found. Automatic checks use the owner's saved configuration.",
		);
	await project(actor, scoped.projectId, write);
	return {
		version: scoped.instance.version,
		projectId: scoped.projectId,
		nodes: null,
		updatedAt: scoped.instance.updatedAt,
	};
}
async function project(
	actor: RunQualityActor,
	projectId: string | null | undefined,
	write: boolean,
) {
	if (
		projectId &&
		((await isProjectSoftDeleted(projectId)) ||
			!(await (write
				? canEditProject(projectId, actor.userId)
				: hasProjectAccess(
						projectId,
						actor.userId,
						actor.organizationId,
					))))
	)
		throw new RunQualityError(
			"NOT_FOUND",
			"Project access is unavailable.",
		);
}

export async function admitRunQualityAssessment(
	input: RunQualityActor &
		RunQualityTarget & {
			sourceVersion: number;
			workflowExecutionId?: string;
			agentExecutionId?: string;
			nativeWorkflowId: string;
			nativeRunId: string;
			sourceScopeJson: Prisma.InputJsonValue;
		},
) {
	// Caller proves the execution and its native context before admission. Definitions are
	// snapshotted once, before business effects; retries never substitute a newer policy.
	const { targetType, targetId, sourceScopeJson, ...identity } = input;
	return db
		.$transaction(async (tx) => {
			const policy = await tx.runQualityPolicy.findFirst({
				where: {
					organizationId: input.organizationId,
					userId: input.userId,
					...qualityTargetWhere(input),
				},
			});
			if (!policy) return null;
			const source = input.workflowExecutionId
				? { workflowExecutionId: input.workflowExecutionId }
				: { agentExecutionId: input.agentExecutionId };
			const existing = await tx.runQualityAssessment.findFirst({
				where: {
					policyId: policy.id,
					organizationId: input.organizationId,
					userId: input.userId,
					...source,
					nativeRunId: input.nativeRunId,
				},
			});
			if (existing) {
				if (
					existing.nativeWorkflowId !== input.nativeWorkflowId ||
					existing.nativeRunId !== input.nativeRunId
				)
					throw new RunQualityError(
						"CONFLICT",
						"Assessment native identity differs.",
					);
				return existing;
			}
			if (!policy.enabled) return null;
			const rules = runQualityRulesSchema.parse(policy.rulesJson);
			const id = `quality-${qualityDigest([input.organizationId, input.userId, policy.id, source, input.nativeRunId]).slice(0, 48)}`;
			const row = await tx.runQualityAssessment.create({
				data: {
					id,
					...identity,
					workflowExecutionId: input.workflowExecutionId,
					agentExecutionId: input.agentExecutionId,
					policyId: policy.id,
					policyRevision: policy.revision,
					rulesJson: rules as unknown as Prisma.InputJsonValue,
					rulesHash: qualityDigest(rules),
					sourceScopeJson,
					assessmentWorkflowId: `run-quality-${id}`,
					deadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
				},
			});
			await recordAuditTx(tx, {
				action: "quality.assessment_started",
				category: "org",
				organizationId: input.organizationId,
				actor: { type: "user", userId: input.userId },
				resource: { type: "quality_assessment", id: row.id },
				metadata: {
					targetType,
					targetId,
					policyRevision: policy.revision,
					sourceVersion: input.sourceVersion,
				},
			});
			return row;
		})
		.catch(async (error: unknown) => {
			if (
				!error ||
				typeof error !== "object" ||
				!("code" in error) ||
				error.code !== "P2002"
			)
				throw error;
			const existing = await db.runQualityAssessment.findFirst({
				where: {
					organizationId: input.organizationId,
					userId: input.userId,
					policy: qualityTargetWhere(input),
					nativeRunId: input.nativeRunId,
					...(input.workflowExecutionId
						? { workflowExecutionId: input.workflowExecutionId }
						: { agentExecutionId: input.agentExecutionId }),
				},
			});
			if (
				!existing ||
				existing.nativeWorkflowId !== input.nativeWorkflowId ||
				existing.nativeRunId !== input.nativeRunId
			)
				throw error;
			return existing;
		});
}
