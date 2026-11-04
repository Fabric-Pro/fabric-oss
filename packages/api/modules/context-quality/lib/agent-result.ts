import { createHash } from "node:crypto";
import { agentRunText } from "@repo/agent-types";
import { evaluateContextQuality } from "@repo/rag/lib/context-quality";
import {
	evaluateAgentResultSchema,
	inspectAgentResultSchema,
} from "../agent-run-contracts";
import { SavedEvaluationError } from "../saved-contracts";
import type { ContextQualityActor } from "./commands";

export interface AgentResultRecord {
	executionId: string;
	instanceId: string;
	projectId: string;
	workflowId: string | null;
	runId: string | null;
	status: string;
	executionStateSource: "temporal" | "database";
	completedAt: Date | string | null;
	output: unknown;
}
const hash = (text: string) =>
	createHash("sha256").update(text, "utf8").digest("hex");
/** Reuses current run access and the existing scorer. Never persists or exports private run evidence. */
export function createAgentResultCommands(
	load: (
		actor: ContextQualityActor,
		executionId: string,
	) => Promise<AgentResultRecord>,
) {
	async function inspect(actor: ContextQualityActor, raw: unknown) {
		const input = inspectAgentResultSchema.safeParse(raw);
		if (!input.success) {
			throw new SavedEvaluationError(
				"BAD_REQUEST",
				"Select a valid agent run.",
			);
		}
		const row = await load(actor, input.data.executionId);
		if (
			row.executionId !== input.data.executionId ||
			row.projectId !== actor.projectId
		) {
			throw new SavedEvaluationError(
				"NOT_FOUND",
				"Agent result not found in this project.",
			);
		}
		if (row.status !== "COMPLETED") {
			throw new SavedEvaluationError(
				"CONFLICT",
				"Wait for a completed run before checking its result.",
			);
		}
		const answer = agentRunText(row.output);
		if (!answer.trim() || answer.length > 16_384) {
			throw new SavedEvaluationError(
				"PRECONDITION_FAILED",
				"This run needs a nonempty text result of at most 16,384 characters. Its output has not been shortened for scoring.",
			);
		}
		const origin = {
			executionId: row.executionId,
			instanceId: row.instanceId,
			projectId: actor.projectId,
			workflowId: row.workflowId,
			runId: row.runId,
			executionStateSource: row.executionStateSource,
			completedAt: row.completedAt
				? new Date(row.completedAt).toISOString()
				: null,
			outputHash: hash(answer),
		};
		return {
			...origin,
			revision: hash(JSON.stringify(origin)),
			recordedAnswer: answer,
			mode: "recorded-agent-result" as const,
			targetInvoked: false as const,
			historicalReplay: false as const,
			retrievalEvidence: "not-evaluated" as const,
			saved: false as const,
		};
	}
	return {
		inspect,
		async evaluate(actor: ContextQualityActor, raw: unknown) {
			const parsed = evaluateAgentResultSchema.safeParse(raw);
			if (!parsed.success) {
				throw new SavedEvaluationError(
					"BAD_REQUEST",
					"Use an inspected run revision and bounded phrase expectations.",
				);
			}
			const input = parsed.data;
			const current = await inspect(actor, {
				executionId: input.executionId,
			});
			if (current.revision !== input.expectedRevision) {
				throw new SavedEvaluationError(
					"CONFLICT",
					"The recorded result changed. Inspect this run again before checking it.",
				);
			}
			let report: ReturnType<typeof evaluateContextQuality>;
			try {
				report = evaluateContextQuality({
					version: 1,
					sources: [],
					cases: [
						{
							id: "recorded-agent-result",
							recordedAnswer: current.recordedAnswer,
							retrievedSourceIds: [],
							citedSourceIds: [],
							expectations: {
								expectedSourceIds: [],
								requiredPhrases: [
									...new Set(input.requiredPhrases),
								],
								forbiddenPhrases: [
									...new Set(input.forbiddenPhrases),
								],
							},
						},
					],
				});
			} catch {
				throw new SavedEvaluationError(
					"BAD_REQUEST",
					"The recorded answer and expectations exceed the scoring limits. Use fewer or shorter phrases.",
				);
			}

			// Re-load through current owner, organization, project and native execution checks.
			const final = await inspect(actor, {
				executionId: input.executionId,
			});
			if (final.revision !== current.revision) {
				throw new SavedEvaluationError(
					"CONFLICT",
					"The recorded result changed while it was checked. Inspect it again.",
				);
			}
			return {
				...report,
				projectId: actor.projectId,
				organizationId: actor.organizationId,
				origin: final,
				expectations: {
					requiredPhrases: input.requiredPhrases,
					forbiddenPhrases: input.forbiddenPhrases,
				},
				expectationResults: [
					...input.requiredPhrases.map((phrase) => ({
						kind: "required" as const,
						phrase,
						passed: final.recordedAnswer.includes(phrase),
					})),
					...input.forbiddenPhrases.map((phrase) => ({
						kind: "forbidden" as const,
						phrase,
						passed: !final.recordedAnswer.includes(phrase),
					})),
				],
			};
		},
	};
}

export async function agentResultCommands() {
	const { db, readAgentExecutionAdmission } = await import("@repo/database");
	const { getAgentRunCommand } = await import(
		"../../agent-deployments/lib/run-commands"
	);
	const { requireSavedEvaluationAccess } = await import("./saved-access");
	return createAgentResultCommands(async (actor, executionId) => {
		await requireSavedEvaluationAccess(actor);
		const row = await db.agentDeploymentExecution.findFirst({
			where: {
				id: executionId,
				organizationId: actor.organizationId,
				userId: actor.userId,
			},
			select: {
				metadata: true,
				deployment: { select: { instanceId: true } },
			},
		});
		if (!row) {
			throw new SavedEvaluationError(
				"NOT_FOUND",
				"Agent result not found or access denied.",
			);
		}
		const admission = readAgentExecutionAdmission(row);
		const admitted = admission?.dispatch;
		if (!admitted?.projectId) {
			throw new SavedEvaluationError(
				"PRECONDITION_FAILED",
				"This older run has no recorded project binding. Check a new project-bound run instead.",
			);
		}
		if (
			admitted.projectId !== actor.projectId ||
			admitted.instanceId !== row.deployment.instanceId
		) {
			throw new SavedEvaluationError(
				"NOT_FOUND",
				"Agent result not found in this project.",
			);
		}
		let run: Awaited<ReturnType<typeof getAgentRunCommand>>;
		try {
			run = await getAgentRunCommand(actor, { executionId });
		} catch (error) {
			const code = (error as { code?: string })?.code;
			if (code === "FORBIDDEN" || code === "NOT_FOUND") {
				throw new SavedEvaluationError(
					code,
					"Current access to this agent result is required.",
				);
			}
			throw new SavedEvaluationError(
				"SERVICE_UNAVAILABLE",
				"The agent result could not be verified. Try again.",
			);
		}
		const current = await db.agentDeploymentExecution.findFirst({
			where: {
				id: executionId,
				organizationId: actor.organizationId,
				userId: actor.userId,
			},
			select: {
				metadata: true,
				deployment: { select: { instanceId: true } },
			},
		});
		if (
			!current ||
			current.deployment.instanceId !== row.deployment.instanceId ||
			JSON.stringify(readAgentExecutionAdmission(current)) !==
				JSON.stringify(admission)
		) {
			throw new SavedEvaluationError(
				"CONFLICT",
				"The run binding changed. Inspect the result again.",
			);
		}
		await requireSavedEvaluationAccess(actor);
		return {
			executionId,
			instanceId: row.deployment.instanceId,
			projectId: admitted.projectId,
			workflowId: run.workflowId,
			runId: run.runId,
			status: run.status,
			executionStateSource: run.nativeStateAvailable
				? "temporal"
				: "database",
			completedAt: run.completedAt,
			output: run.output,
		};
	});
}
