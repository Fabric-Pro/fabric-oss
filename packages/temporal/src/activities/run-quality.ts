import { createHash } from "node:crypto";
import {
	admitRunQualityAssessment,
	db,
	loadRunQualityTarget,
	Prisma,
	qualityTargetWhere,
	readAgentExecutionAdmission,
	recordAuditTx,
} from "@repo/database";
import { WorkspaceDocumentContentError } from "@repo/database/prisma/queries/workspaces/document-content";
import {
	gradeResultQuality,
	RESULT_QUALITY_SCORER_VERSION,
} from "@repo/utils/result-quality";
import {
	type RunQualityActor,
	RunQualityError,
	type RunQualityReport,
	type RunQualityTarget,
	runQualityReasonSchema,
	runQualityReportSchema,
	runQualityRulesSchema,
} from "@repo/utils/run-quality-contracts";
import { Context, heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { z } from "zod";
import { getTemporalClient } from "../client";
import { hasUnconfirmedAgentEffect } from "../lib/agent-execution-native-protocol";
import { AgentTestError } from "../lib/agent-test-contracts";
import {
	assertRunQualitySourceAccess,
	snapshotRunQualitySources,
} from "../lib/run-quality-source-access";

export interface RunQualityAdmission extends RunQualityActor, RunQualityTarget {
	executionId: string;
	executedGraph?: { nodes: unknown; projectId: string | null };
}
export interface RunQualityObserverInput extends RunQualityActor {
	assessmentId: string;
}
const terminal = new Set(["COMPLETED", "CANCELLED"]);
const record = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
function refuse(code = "NATIVE_IDENTITY_INVALID"): never {
	throw ApplicationFailure.nonRetryable(
		"Quality evidence is unavailable.",
		code,
	);
}

/** Native context is proved independently of request arguments before freezing a policy. */
export async function admitRecordedRunQuality(input: RunQualityAdmission) {
	const info = Context.current().info;
	const native = info.workflowExecution;
	if (!native || !input.organizationId) refuse();
	const actor = {
		userId: input.userId,
		organizationId: input.organizationId,
	};
	const policy = await db.runQualityPolicy.findFirst({
		where: { ...actor, ...qualityTargetWhere(input) },
	});
	if (!policy) return null;
	let sourceVersion: number;
	let source: { workflowExecutionId: string } | { agentExecutionId: string };
	if (input.targetType === "WORKFLOW") {
		if (info.workflowType !== "workflowBuilderExecutionWorkflow") refuse();
		const row = await db.workflowExecution.findFirst({
			where: {
				id: input.executionId,
				workflowId: input.targetId,
				...actor,
			},
		});
		if (!row || row.temporalRunId !== native.workflowId) refuse();
		sourceVersion = row.version;
		source = { workflowExecutionId: row.id };
	} else {
		if (
			![
				"nativeDeploymentExecutionWorkflow",
				"nativeGoalOrientedAgentWorkflow",
			].includes(info.workflowType ?? "")
		)
			refuse();
		const row = await db.agentDeploymentExecution.findFirst({
			where: {
				id: input.executionId,
				...actor,
			},
		});
		const admitted = row && readAgentExecutionAdmission(row);
		if (
			!row ||
			!admitted ||
			row.workflowId !== native.workflowId ||
			row.runId !== native.runId ||
			admitted.dispatch.instanceId !== input.targetId ||
			admitted.dispatch.workflowType !== info.workflowType
		)
			refuse();
		const instance = await db.agentTemplateInstance.findFirst({
			where: { id: input.targetId, ...actor },
			select: { version: true },
		});
		if (!instance) return null;
		sourceVersion = instance.version;
		source = { agentExecutionId: row.id };
	}
	const prior = await db.runQualityAssessment.findFirst({
		where: {
			policyId: policy.id,
			...actor,
			...source,
			nativeRunId: native.runId,
		},
	});
	if (!policy.enabled && !prior) return null;
	let sources: unknown = prior?.sourceScopeJson;
	if (!sources) {
		try {
			sources = await snapshotRunQualitySources(
				actor,
				input,
				input.executedGraph,
			);
			if (Buffer.byteLength(JSON.stringify(sources)) > 262_144)
				throw new RunQualityError(
					"BAD_REQUEST",
					"Source selectors exceed the assessment budget.",
				);
		} catch (error) {
			// An optional check cannot block business work on a revoked selector. Retain
			// a truthful unavailable result; infrastructure failures still retry natively.
			if (
				!(
					error instanceof RunQualityError ||
					error instanceof AgentTestError ||
					error instanceof WorkspaceDocumentContentError ||
					error instanceof z.ZodError
				)
			)
				throw error;
			sources = { kind: "UNAVAILABLE" };
		}
	}
	const row = await admitRunQualityAssessment({
		...actor,
		targetType: input.targetType,
		targetId: input.targetId,
		sourceVersion,
		...source,
		nativeWorkflowId: native.workflowId,
		nativeRunId: native.runId,
		sourceScopeJson: sources as Prisma.InputJsonValue,
	});
	return row
		? {
				assessmentId: row.id,
				workflowId: row.assessmentWorkflowId,
				...actor,
			}
		: null;
}

async function ownedObserver(input: RunQualityObserverInput) {
	const info = Context.current().info;
	const current = info.workflowExecution;
	if (!current) refuse();
	const row = await db.runQualityAssessment.findFirst({
		where: {
			id: input.assessmentId,
			userId: input.userId,
			organizationId: input.organizationId,
		},
		include: { policy: true },
	});
	if (
		!row ||
		info.workflowType !== "recordedRunQualityWorkflow" ||
		current.workflowId !== row.assessmentWorkflowId ||
		(row.assessmentRunId && row.assessmentRunId !== current.runId)
	)
		refuse();
	const client = await getTemporalClient();
	const description = await client.workflow
		.getHandle(current.workflowId, current.runId, { followRuns: false })
		.describe();
	const memo = record(description.memo?.fabricRunQuality);
	if (
		description.type !== "recordedRunQualityWorkflow" ||
		description.runId !== current.runId ||
		memo?.version !== 1 ||
		memo.assessmentId !== row.id ||
		memo.userId !== input.userId ||
		memo.organizationId !== input.organizationId
	)
		refuse();
	const selected: RunQualityTarget = row.policy.workflowId
		? { targetType: "WORKFLOW", targetId: row.policy.workflowId }
		: { targetType: "AGENT", targetId: row.policy.instanceId! };
	return { row, selected };
}
async function sources(
	input: RunQualityObserverInput,
	row: Awaited<ReturnType<typeof ownedObserver>>["row"],
	selected: RunQualityTarget,
	configuration = false,
) {
	const currentTarget = await loadRunQualityTarget(input, selected);
	await assertRunQualitySourceAccess(input, row.sourceScopeJson);
	if (configuration && selected.targetType === "AGENT") {
		const old = record(row.sourceScopeJson),
			saved = record(old?.scope);
		const now = await snapshotRunQualitySources(input, selected);
		const currentScope = record(record(now)?.scope);
		if (
			currentTarget.version !== row.sourceVersion ||
			currentScope?.configHash !== saved?.configHash
		)
			refuse("POLICY_CHANGED");
	}
}
function uncertainEffects(state: Record<string, unknown>) {
	const output = record(state.output);
	if (
		state.inspectionRequired === true ||
		output?.inspectionRequired === true
	)
		return true;
	for (const values of [
		state.toolCalls,
		output?.toolCalls,
		state.toolCallSummary,
		output?.toolCallSummary,
	]) {
		if (values === undefined) continue;
		if (!Array.isArray(values)) return true;
		const calls = [];
		for (const value of values) {
			const call = record(value);
			if (!call || typeof call.status !== "string") return true;
			calls.push({
				status: call.status,
				result: call.result,
				inspectionRequired: call.inspectionRequired === true,
			});
		}
		if (hasUnconfirmedAgentEffect(calls)) return true;
		if (calls.some((call) => call.status === "error")) return true;
	}
	return false;
}
function textOf(
	value: unknown,
	pointer?: string,
):
	| { text: string }
	| {
			reason:
				| "NO_OUTPUT"
				| "OUTPUT_SELECTION_INVALID"
				| "OUTPUT_TOO_LARGE";
	  } {
	let selected = value;
	if (pointer !== undefined && pointer !== "") {
		const parts = pointer
			.slice(1)
			.split("/")
			.map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"));
		if (
			!pointer.startsWith("/") ||
			parts.length > 16 ||
			parts.some((x) =>
				["__proto__", "constructor", "prototype"].includes(x),
			)
		)
			return { reason: "OUTPUT_SELECTION_INVALID" };
		for (const part of parts) {
			if (
				!selected ||
				typeof selected !== "object" ||
				!Object.hasOwn(selected, part) ||
				(Array.isArray(selected) && !/^(?:0|[1-9]\d*)$/.test(part))
			)
				return { reason: "OUTPUT_SELECTION_INVALID" };
			selected = (selected as Record<string, unknown>)[part];
		}
	} else if (pointer === undefined) {
		const obj = record(selected);
		if (obj)
			selected =
				typeof obj.response === "string"
					? obj.response
					: typeof obj.markdown === "string"
						? obj.markdown
						: typeof obj.text === "string"
							? obj.text
							: selected;
	}
	if (selected === undefined || selected === null)
		return { reason: "NO_OUTPUT" };
	const text =
		typeof selected === "string" ? selected : JSON.stringify(selected);
	if (!text?.trim()) return { reason: "NO_OUTPUT" };
	if (Buffer.byteLength(text) > 16_384) return { reason: "OUTPUT_TOO_LARGE" };
	return { text };
}

async function saveTerminal(
	input: RunQualityObserverInput,
	report: RunQualityReport | null,
	errorCode: string | null,
) {
	const { row, selected } = await ownedObserver(input);
	if (terminal.has(row.status)) return { status: row.status };
	if (report) await sources(input, row, selected, true);
	const required = report?.rules.filter((r) => r.required) ?? [];
	const verdict = errorCode
		? "UNAVAILABLE"
		: required.some((r) => r.status === "FAILED")
			? "NEEDS_ATTENTION"
			: required.some((r) => r.status !== "PASSED")
				? "UNAVAILABLE"
				: "PASSED";
	Context.current().cancellationSignal.throwIfAborted();
	return db.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT id FROM run_quality_assessment WHERE id=${row.id} FOR UPDATE`;
		const now = new Date();
		const expired = now >= row.deadlineAt;
		const changed = await tx.runQualityAssessment.updateMany({
			where: {
				id: row.id,
				userId: input.userId,
				organizationId: input.organizationId,
				status: { in: ["PENDING", "CHECKING"] },
			},
			data: {
				status: "COMPLETED",
				verdict: expired ? "UNAVAILABLE" : verdict,
				reportJson:
					!expired && report
						? (report as unknown as Prisma.InputJsonValue)
						: Prisma.JsonNull,
				errorCode: expired ? "CHECK_BUDGET_EXCEEDED" : errorCode,
				completedAt: now,
			},
		});
		if (changed.count)
			await recordAuditTx(tx, {
				action: "quality.assessment_completed",
				category: "org",
				organizationId: input.organizationId,
				actor: { type: "user", userId: input.userId },
				resource: { type: "quality_assessment", id: row.id },
				metadata: {
					targetType: selected.targetType,
					targetId: selected.targetId,
					policyRevision: row.policyRevision,
					verdict: expired ? "UNAVAILABLE" : verdict,
				},
			});
		return { status: changed.count ? "COMPLETED" : row.status };
	});
}

/** Read a pinned native result once. No business invocation, model call or retrieval. */
export async function assessRecordedRunQuality(input: RunQualityObserverInput) {
	const timer = setInterval(
		() => heartbeat({ phase: "Waiting for the recorded execution" }),
		5_000,
	);
	try {
		const { row, selected } = await ownedObserver(input);
		if (record(row.sourceScopeJson)?.kind === "UNAVAILABLE")
			return await saveTerminal(input, null, "SOURCE_ACCESS_REVOKED");
		if (terminal.has(row.status)) return { status: row.status };
		if (Date.now() >= row.deadlineAt.getTime())
			return await saveTerminal(input, null, "CHECK_BUDGET_EXCEEDED");
		await sources(input, row, selected);
		await db.runQualityAssessment.updateMany({
			where: {
				id: row.id,
				userId: input.userId,
				organizationId: input.organizationId,
				status: { in: ["PENDING", "CHECKING"] },
			},
			data: {
				status: "CHECKING",
				assessmentRunId:
					Context.current().info.workflowExecution!.runId,
			},
		});
		const client = await getTemporalClient();
		const handle = client.workflow.getHandle(
			row.nativeWorkflowId,
			row.nativeRunId,
			{ followRuns: false },
		);
		const before = await handle.describe();
		if (
			before.runId !== row.nativeRunId ||
			(selected.targetType === "WORKFLOW"
				? before.type !== "workflowBuilderExecutionWorkflow"
				: ![
						"nativeDeploymentExecutionWorkflow",
						"nativeGoalOrientedAgentWorkflow",
					].includes(before.type))
		)
			refuse();
		let rawOutput: unknown;
		try {
			rawOutput = await client.workflow.withAbortSignal(
				Context.current().cancellationSignal,
				() => handle.result(),
			);
		} catch (error) {
			Context.current().cancellationSignal.throwIfAborted();
			const stopped = await handle.describe();
			if (stopped.runId !== row.nativeRunId) refuse();
			if (
				["FAILED", "TIMED_OUT", "TERMINATED", "CANCELLED"].includes(
					stopped.status.name,
				)
			)
				return await saveTerminal(
					input,
					null,
					stopped.status.name === "CANCELLED"
						? "EXECUTION_CANCELLED"
						: "EXECUTION_FAILED",
				);
			throw error;
		}
		const native = record(rawOutput);
		const after = await handle.describe();
		await sources(input, row, selected, true);
		if (
			after.runId !== row.nativeRunId ||
			after.status.name !== "COMPLETED" ||
			native?.status !== "COMPLETED" ||
			(after.type === "nativeGoalOrientedAgentWorkflow" &&
				native.goalAchieved !== true)
		)
			return await saveTerminal(
				input,
				null,
				native?.status === "CANCELLED"
					? "EXECUTION_CANCELLED"
					: "EXECUTION_FAILED",
			);
		const latest = await ownedObserver(input);
		if (terminal.has(latest.row.status))
			return { status: latest.row.status };
		if (
			selected.targetType === "WORKFLOW" &&
			native.executionId !== row.workflowExecutionId
		)
			refuse();
		if (
			selected.targetType === "WORKFLOW" &&
			Object.values(record(native.outputs) ?? {}).some((output) => {
				const value = record(output);
				return !!value && uncertainEffects(value);
			})
		)
			return await saveTerminal(input, null, "EVIDENCE_UNAVAILABLE");
		if (selected.targetType === "AGENT") {
			const execution = await db.agentDeploymentExecution.findFirst({
				where: {
					id: row.agentExecutionId!,
					userId: input.userId,
					organizationId: input.organizationId,
					workflowId: row.nativeWorkflowId,
					runId: row.nativeRunId,
				},
			});
			if (
				!execution ||
				execution.executionId !== native.executionId ||
				execution.status !== "COMPLETED"
			)
				refuse();
			const loaded = record(native.qualityConfiguration);
			const captured = record(record(row.sourceScopeJson)?.scope);
			if (
				!loaded ||
				loaded.version !== 1 ||
				loaded.assessmentId !== row.id
			)
				return await saveTerminal(input, null, "EVIDENCE_UNAVAILABLE");
			if (loaded.configHash !== captured?.configHash)
				return await saveTerminal(input, null, "POLICY_CHANGED");
			const admission = readAgentExecutionAdmission(execution);
			const memo = record(after.memo?.fabricAgentAdmission);
			if (
				!admission ||
				after.type !== admission.dispatch.workflowType ||
				memo?.version !== 1 ||
				memo.executionId !== execution.id ||
				memo.userId !== input.userId ||
				memo.organizationId !== input.organizationId ||
				memo.requestHash !== admission.requestHash
			)
				refuse();
			if (uncertainEffects(native))
				return await saveTerminal(input, null, "EVIDENCE_UNAVAILABLE");
		}
		const definitions = runQualityRulesSchema.parse(row.rulesJson);
		const rules: RunQualityReport["rules"] = definitions.map((rule) => {
			const output =
				selected.targetType === "WORKFLOW"
					? record(native.outputs)?.[rule.nodeId!]
					: typeof native.response === "string"
						? native.response
						: native.output;
			const selection = textOf(output, rule.pointer);
			if ("reason" in selection)
				return {
					id: rule.id,
					name: rule.name,
					required: rule.required,
					status: "UNAVAILABLE",
					reason: selection.reason,
				};
			const text = selection.text;
			const grade = gradeResultQuality(text, rule.checks);
			return {
				id: rule.id,
				name: rule.name,
				required: rule.required,
				status: grade.status,
				grade,
				outputHash: createHash("sha256").update(text).digest("hex"),
				...(grade.status === "NOT_ASSESSED"
					? { reason: "EVIDENCE_UNAVAILABLE" as const }
					: {}),
			};
		});
		const report = runQualityReportSchema.parse({
			version: 1,
			scorerVersion: RESULT_QUALITY_SCORER_VERSION,
			rules,
			coverage: {
				total: rules.length,
				passed: rules.filter((r) => r.status === "PASSED").length,
				failed: rules.filter((r) => r.status === "FAILED").length,
				unavailable: rules.filter((r) =>
					["NOT_ASSESSED", "UNAVAILABLE"].includes(r.status),
				).length,
			},
		});
		return await saveTerminal(input, report, null);
	} catch (error) {
		Context.current().cancellationSignal.throwIfAborted();
		if (
			error instanceof RunQualityError ||
			error instanceof AgentTestError ||
			error instanceof WorkspaceDocumentContentError
		)
			return await saveTerminal(
				input,
				null,
				error.code === "NOT_FOUND" || error.code === "FORBIDDEN"
					? "SOURCE_ACCESS_REVOKED"
					: "ASSESSMENT_UNAVAILABLE",
			);
		if (error instanceof ApplicationFailure) {
			const reason = runQualityReasonSchema.safeParse(error.type);
			if (reason.success)
				return await saveTerminal(input, null, reason.data);
		}
		throw error;
	} finally {
		clearInterval(timer);
	}
}
export async function failRecordedRunQuality(
	input: RunQualityObserverInput & { errorCode: string },
) {
	const parsed = runQualityReasonSchema.safeParse(input.errorCode);
	return saveTerminal(
		input,
		null,
		parsed.success ? parsed.data : "ASSESSMENT_UNAVAILABLE",
	);
}

export interface RunQualityAdmissionRecoveryInput extends RunQualityAdmission {
	nativeWorkflowId: string;
	nativeRunId: string;
}
/** Reconcile only an already committed admission after a lost activity acknowledgement.
 * Native Temporal retries this independent cleanup; business work is never resubmitted. */
export async function settleUnconfirmedRunQualityAdmission(
	input: RunQualityAdmissionRecoveryInput,
) {
	const info = Context.current().info,
		current = info.workflowExecution;
	if (
		!current ||
		info.workflowType !== "recordedRunQualityAdmissionRecoveryWorkflow" ||
		current.workflowId !== `run-quality-recovery-${input.nativeRunId}`
	)
		refuse();
	const client = await getTemporalClient();
	const description = await client.workflow
		.getHandle(current.workflowId, current.runId, { followRuns: false })
		.describe();
	const memo = record(description.memo?.fabricRunQualityAdmissionRecovery);
	if (
		description.type !== info.workflowType ||
		description.runId !== current.runId ||
		memo?.version !== 1 ||
		memo.userId !== input.userId ||
		memo.organizationId !== input.organizationId ||
		memo.nativeWorkflowId !== input.nativeWorkflowId ||
		memo.nativeRunId !== input.nativeRunId ||
		memo.executionId !== input.executionId ||
		memo.targetType !== input.targetType ||
		memo.targetId !== input.targetId
	)
		refuse();
	const row = await db.runQualityAssessment.findFirst({
		where: {
			userId: input.userId,
			organizationId: input.organizationId,
			nativeWorkflowId: input.nativeWorkflowId,
			nativeRunId: input.nativeRunId,
			policy: qualityTargetWhere(input),
			...(input.targetType === "WORKFLOW"
				? { workflowExecutionId: input.executionId }
				: { agentExecutionId: input.executionId }),
		},
	});
	if (!row) return { status: "NO_RECORDED_ADMISSION" };
	return db.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT id FROM run_quality_assessment WHERE id=${row.id} FOR UPDATE`;
		const changed = await tx.runQualityAssessment.updateMany({
			where: {
				id: row.id,
				userId: input.userId,
				organizationId: input.organizationId,
				status: { in: ["PENDING", "CHECKING"] },
			},
			data: {
				status: "COMPLETED",
				verdict: "UNAVAILABLE",
				reportJson: Prisma.JsonNull,
				errorCode: "ASSESSMENT_UNAVAILABLE",
				completedAt: new Date(),
			},
		});
		if (changed.count)
			await recordAuditTx(tx, {
				action: "quality.assessment_completed",
				category: "org",
				organizationId: input.organizationId,
				actor: { type: "user", userId: input.userId },
				resource: { type: "quality_assessment", id: row.id },
				metadata: {
					verdict: "UNAVAILABLE",
					reason: "ASSESSMENT_UNAVAILABLE",
				},
			});
		return { status: changed.count ? "COMPLETED" : row.status };
	});
}
