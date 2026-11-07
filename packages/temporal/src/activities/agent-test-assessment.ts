import { createHash } from "node:crypto";
import { agentRunText } from "@repo/agent-types";
import { db, Prisma, readAgentExecutionAdmission } from "@repo/database";
import { gradeResultQuality } from "@repo/utils/result-quality";
import { Context, heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { getTemporalClient } from "../client";
import { hasUnconfirmedAgentEffect } from "../lib/agent-execution-native-protocol";
import {
	assertAgentTestSourceScope,
	loadAgentTestScope,
} from "../lib/agent-test-access";
import {
	AGENT_TEST_WORKFLOW,
	type AgentTestReport,
	agentTestChecksSchema,
	agentTestReportSchema,
} from "../lib/agent-test-contracts";
import type { AgentTestAssessmentInput } from "../workflows/agent-test-assessment";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function forbidden(
	message: string,
	type = "AGENT_TEST_IDENTITY_INVALID",
): never {
	throw ApplicationFailure.nonRetryable(message, type);
}
async function owned(input: AgentTestAssessmentInput) {
	const row = await db.agentTestRun.findFirst({
		where: {
			id: input.testRunId,
			userId: input.userId,
			organizationId: input.organizationId,
		},
		include: { testCase: true, execution: true },
	});
	const info = Context.current().info;
	const current = info.workflowExecution;
	if (
		!input.userId ||
		!input.organizationId ||
		!row ||
		row.userId !== input.userId ||
		row.organizationId !== input.organizationId ||
		info.workflowType !== AGENT_TEST_WORKFLOW ||
		!current ||
		current.workflowId !== row.evaluationWorkflowId ||
		(row.evaluationRunId !== null && row.evaluationRunId !== current.runId)
	) {
		forbidden(
			"The test assessment identity is invalid.",
			"AGENT_TEST_FORBIDDEN",
		);
	}
	// The worker can begin before the API persists evaluationRunId. Verify that
	// exact running execution's admission memo even in that acknowledgement race.
	const client = await getTemporalClient();
	const description = await client.workflow
		.getHandle(current.workflowId, current.runId, { followRuns: false })
		.describe();
	const memo = record(description.memo?.fabricAgentTest);
	if (
		description.type !== AGENT_TEST_WORKFLOW ||
		description.runId !== current.runId ||
		memo?.version !== 1 ||
		memo.testRunId !== row.id ||
		memo.userId !== input.userId ||
		memo.organizationId !== input.organizationId ||
		memo.requestHash !== row.requestHash
	) {
		forbidden(
			"The test assessment identity is invalid.",
			"AGENT_TEST_FORBIDDEN",
		);
	}
	return row;
}
async function checkSources(
	input: AgentTestAssessmentInput,
	row: Awaited<ReturnType<typeof owned>>,
	configuration = false,
) {
	const scopes = record(row.sourceScopeJson);
	if (!scopes) {
		forbidden(
			"The test source snapshot is invalid.",
			"AGENT_TEST_FORBIDDEN",
		);
	}
	await assertAgentTestSourceScope(input, scopes.origin);
	const executionScope = await assertAgentTestSourceScope(
		input,
		scopes.execution,
	);
	if (executionScope.instanceId !== row.instanceId) {
		forbidden(
			"The test source snapshot is invalid.",
			"AGENT_TEST_FORBIDDEN",
		);
	}
	// Historical completed results retain their original source authority. Only an
	// in-flight assessment checks that its recorded execution configuration stayed fixed.
	if (configuration && executionScope.configHash) {
		const current = await loadAgentTestScope(input, row.instanceId);
		if (
			current.instance.id !== row.instanceId ||
			current.instance.version !== row.agentVersion ||
			current.instance.sId !== row.agentSId ||
			current.scope.configHash !== executionScope.configHash
		) {
			forbidden(
				"The agent configuration changed while this test was running. Start a new test run for the current configuration.",
				"AGENT_TEST_CONFIG_CHANGED",
			);
		}
	}
	return executionScope;
}
const nativeTypes = new Set([
	"nativeDeploymentExecutionWorkflow",
	"nativeGoalOrientedAgentWorkflow",
]);
function uncertainEffects(state: Record<string, unknown>) {
	const output = record(state.output);
	if (
		state.inspectionRequired === true ||
		output?.inspectionRequired === true
	) {
		return true;
	}
	for (const values of [state.toolCalls, output?.toolCalls]) {
		if (values === undefined) {
			continue;
		}
		if (!Array.isArray(values)) {
			return true;
		}
		const calls: Array<{
			status: string;
			result?: unknown;
			inspectionRequired?: boolean;
		}> = [];
		for (const value of values) {
			const call = record(value);
			if (!call || typeof call.status !== "string") {
				return true;
			}
			calls.push({
				status: call.status,
				result: call.result,
				inspectionRequired: call.inspectionRequired === true,
			});
		}
		if (hasUnconfirmedAgentEffect(calls)) {
			return true;
		}
	}
	return false;
}
function decimalCost(value: unknown): string | null {
	if (
		typeof value !== "number" &&
		typeof value !== "string" &&
		!Prisma.Decimal.isDecimal(value)
	) {
		return null;
	}
	if (
		(typeof value === "number" && (!Number.isFinite(value) || value < 0)) ||
		(typeof value === "string" && value.length > 100)
	) {
		return null;
	}
	try {
		const cost = new Prisma.Decimal(String(value));
		if (!cost.isFinite() || cost.isNegative()) {
			return null;
		}
		const plain = cost.toFixed();
		return plain.length <= 40 ? plain : null;
	} catch {
		return null;
	}
}
export async function assessAgentTestRun(input: AgentTestAssessmentInput) {
	const timer = setInterval(
		() => heartbeat({ phase: "Waiting for saved agent run" }),
		5000,
	);
	try {
		const row = await owned(input);
		const terminal = ["COMPLETED", "CANCELLED", "ERROR"].includes(
			row.status,
		);
		const source = await checkSources(input, row, !terminal);
		if (terminal) {
			return { status: row.status };
		}
		const execution = row.execution;
		const admission = execution && readAgentExecutionAdmission(execution);
		if (
			!execution ||
			!admission ||
			!row.nativeWorkflowId ||
			!row.nativeRunId ||
			execution.id !== row.executionId ||
			execution.userId !== input.userId ||
			execution.organizationId !== input.organizationId ||
			admission.dispatch.instanceId !== row.instanceId ||
			admission.dispatch.projectId !== source.projectId ||
			!nativeTypes.has(admission.dispatch.workflowType) ||
			execution.workflowId !== row.nativeWorkflowId ||
			(execution.runId !== null && execution.runId !== row.nativeRunId)
		) {
			forbidden("The saved agent run could not be verified.");
		}
		const client = await getTemporalClient();
		const handle = client.workflow.getHandle(
			row.nativeWorkflowId,
			row.nativeRunId,
			{ followRuns: false },
		);
		const verifyNative = (
			description: Awaited<ReturnType<typeof handle.describe>>,
		) => {
			const memo = record(description.memo?.fabricAgentAdmission);
			if (
				description.runId !== row.nativeRunId ||
				description.type !== admission.dispatch.workflowType ||
				memo?.version !== 1 ||
				memo.executionId !== execution.id ||
				memo.userId !== input.userId ||
				memo.organizationId !== input.organizationId ||
				memo.requestHash !== admission.requestHash
			) {
				forbidden("The saved agent run could not be verified.");
			}
		};
		verifyNative(await handle.describe());
		heartbeat({ phase: "Waiting for saved agent run" });
		// Native Temporal owns execution/recovery. Await its pinned result once; no
		// application execution loop, resubmission, or periodic execution query exists.
		const output = await client.workflow
			.withAbortSignal(Context.current().cancellationSignal, () =>
				handle.result(),
			)
			.catch((error) => {
				Context.current().cancellationSignal.throwIfAborted();
				throw error;
			});
		await checkSources(input, row);
		const state = record(output) ?? {};
		const status = state.status;
		const finalDescription = await handle.describe();
		verifyNative(finalDescription);
		if (finalDescription.status.name !== "COMPLETED") {
			forbidden(
				"The agent did not complete the test task.",
				"AGENT_TEST_EXECUTION_FAILED",
			);
		}
		const current = await owned(input);
		if (["COMPLETED", "CANCELLED", "ERROR"].includes(current.status)) {
			return { status: current.status };
		}
		await checkSources(input, current, true);
		if (status === "CANCELLED") {
			await db.agentTestRun.updateMany({
				where: {
					id: row.id,
					userId: input.userId,
					organizationId: input.organizationId,
					status: "RUNNING",
				},
				data: {
					status: "CANCELLED",
					completedAt: new Date(),
					reportJson: Prisma.DbNull,
					verdict: null,
				},
			});
			return { status: "CANCELLED" };
		}
		if (uncertainEffects(state)) {
			forbidden(
				"Inspect the agent's unconfirmed external effects before running a new test.",
				"AGENT_TEST_EFFECT_UNCONFIRMED",
			);
		}
		if (
			(state.executionId !== undefined &&
				state.executionId !== execution.executionId) ||
			status !== "COMPLETED"
		) {
			forbidden(
				"The agent did not complete the test task with a confirmed outcome.",
				"AGENT_TEST_EXECUTION_FAILED",
			);
		}
		const rawOutput = record(state.output);
		const answer =
			rawOutput && typeof rawOutput.response === "string"
				? rawOutput.response
				: agentRunText(state) || agentRunText(state.output);
		if (!answer.trim() || Buffer.byteLength(answer) > 1024 * 1024) {
			forbidden(
				"This test requires a bounded text answer.",
				"AGENT_TEST_NO_TEXT",
			);
		}
		const checks = agentTestChecksSchema.parse(row.checksJson);
		const grade = gradeResultQuality(answer, checks);
		const usage = record(state.tokenUsage) ?? {};
		const integer = (value: unknown) =>
			typeof value === "number" &&
			Number.isSafeInteger(value) &&
			value >= 0
				? value
				: null;
		const report: AgentTestReport = agentTestReportSchema.parse({
			...(checks.version === 2
				? grade
				: {
						version: 1,
						method: "exact-text",
						passed: grade.passed,
						total: grade.total,
						results: grade.results.map(
							({ kind, index, passed }) => ({
								kind,
								index,
								passed,
							}),
						),
					}),
			outputHash: createHash("sha256").update(answer).digest("hex"),
			durationMs:
				integer(state.durationMs) ??
				(finalDescription.closeTime
					? Math.max(
							0,
							finalDescription.closeTime.getTime() -
								finalDescription.startTime.getTime(),
						)
					: null),
			inputTokens: integer(usage.inputTokens),
			outputTokens: integer(usage.outputTokens),
			totalCost:
				decimalCost(usage.totalCost) ??
				decimalCost(current.execution?.totalCost),
		});
		await db.agentTestRun.updateMany({
			where: {
				id: row.id,
				userId: input.userId,
				organizationId: input.organizationId,
				status: "RUNNING",
			},
			data: {
				status: "COMPLETED",
				verdict:
					report.version === 2 && report.status === "NOT_ASSESSED"
						? null
						: report.passed === report.total
							? "PASSED"
							: "FAILED",
				reportJson: report as unknown as Prisma.InputJsonValue,
				completedAt: new Date(),
				errorCode: null,
			},
		});
		return { status: "COMPLETED" };
	} finally {
		clearInterval(timer);
	}
}
const failureCodes = new Set([
	"AGENT_TEST_EXECUTION_FAILED",
	"AGENT_TEST_NO_TEXT",
	"AGENT_TEST_EFFECT_UNCONFIRMED",
	"AGENT_TEST_CONFIG_CHANGED",
	"AGENT_TEST_IDENTITY_INVALID",
	"AGENT_TEST_FORBIDDEN",
]);
export async function failAgentTestAssessment(
	input: AgentTestAssessmentInput & { errorCode?: string },
) {
	const row = await owned(input);
	await db.agentTestRun.updateMany({
		where: {
			id: row.id,
			userId: input.userId,
			organizationId: input.organizationId,
			status: { in: ["RUNNING", "ADMITTING"] },
		},
		data: {
			status: "ERROR",
			errorCode: failureCodes.has(input.errorCode ?? "")
				? input.errorCode
				: "ASSESSMENT_UNAVAILABLE",
			completedAt: new Date(),
			reportJson: Prisma.DbNull,
			verdict: null,
		},
	});
	return { status: "ERROR" };
}
