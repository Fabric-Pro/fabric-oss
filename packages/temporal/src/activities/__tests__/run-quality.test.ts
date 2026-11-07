import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	row: vi.fn(),
	update: vi.fn(),
	target: vi.fn(),
	source: vi.fn(),
	snapshot: vi.fn(),
	execution: vi.fn(),
	policy: vi.fn(),
	admit: vi.fn(),
	admission: vi.fn(),
	client: vi.fn(),
	nativeDescribe: vi.fn(),
	observerDescribe: vi.fn(),
	result: vi.fn(),
	audit: vi.fn(),
	query: vi.fn(),
	info: {
		workflowType: "recordedRunQualityWorkflow",
		workflowExecution: {
			workflowId: "example-check",
			runId: "example-check-run",
		},
	},
	signal: new AbortController().signal,
}));
vi.mock("@repo/database", () => ({
	db: {
		runQualityAssessment: { findFirst: m.row, updateMany: m.update },
		runQualityPolicy: { findFirst: m.policy },
		agentDeploymentExecution: { findFirst: m.execution },
		workflowExecution: { findFirst: m.execution },
		agentTemplateInstance: {
			findFirst: vi.fn(async () => ({ version: 3 })),
		},
		$transaction: async (fn: (tx: unknown) => unknown) =>
			fn({
				runQualityAssessment: { updateMany: m.update },
				$queryRaw: m.query,
			}),
	},
	Prisma: { JsonNull: null },
	loadRunQualityTarget: m.target,
	qualityDigest: (value: unknown) =>
		createHash("sha256").update(JSON.stringify(value)).digest("hex"),
	qualityTargetWhere: () => ({ workflowId: "example-workflow" }),
	admitRunQualityAssessment: m.admit,
	readAgentExecutionAdmission: m.admission,
	recordAuditTx: m.audit,
}));
vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({ info: m.info, cancellationSignal: m.signal }),
	},
	heartbeat: vi.fn(),
}));
vi.mock("../../client", () => ({ getTemporalClient: m.client }));
vi.mock("../../lib/run-quality-source-access", () => ({
	assertRunQualitySourceAccess: m.source,
	snapshotRunQualitySources: m.snapshot,
}));

import { RunQualityError } from "@repo/utils/run-quality-contracts";
import {
	admitRecordedRunQuality,
	assessRecordedRunQuality,
	settleUnconfirmedRunQualityAdmission,
} from "../run-quality";

const actor = { userId: "example-user", organizationId: "example-org" };
const input = { ...actor, assessmentId: "example-quality" };
const rules = [
	{
		id: "ready",
		name: "Ready marker",
		nodeId: "answer",
		required: true,
		checks: { requiredPhrases: ["Ready"], forbiddenPhrases: [] },
	},
];
const row = {
	id: input.assessmentId,
	...actor,
	policyId: "example-policy",
	policyRevision: 2,
	sourceVersion: 3,
	status: "PENDING",
	assessmentWorkflowId: "example-check",
	assessmentRunId: null,
	nativeWorkflowId: "example-native",
	nativeRunId: "example-native-run",
	workflowExecutionId: "example-execution",
	agentExecutionId: null,
	policy: { workflowId: "example-workflow", instanceId: null },
	rulesJson: rules,
	sourceScopeJson: { kind: "WORKFLOW", projectId: null, workspaceIds: [] },
	deadlineAt: new Date(Date.now() + 60_000),
};
const nativeDescription = {
	type: "workflowBuilderExecutionWorkflow",
	runId: row.nativeRunId,
	status: { name: "COMPLETED" },
	memo: {},
};
function stored() {
	return m.update.mock.calls.find(
		([arg]) => arg.data.status === "COMPLETED",
	)?.[0].data;
}
beforeEach(() => {
	vi.resetAllMocks();
	m.info.workflowType = "recordedRunQualityWorkflow";
	m.info.workflowExecution = {
		workflowId: row.assessmentWorkflowId,
		runId: "example-check-run",
	};
	m.row.mockResolvedValue(structuredClone(row));
	m.target.mockResolvedValue({ version: 3 });
	m.source.mockResolvedValue(undefined);
	m.update.mockResolvedValue({ count: 1 });
	m.nativeDescribe.mockResolvedValue(nativeDescription);
	m.result.mockResolvedValue({
		status: "COMPLETED",
		executionId: row.workflowExecutionId,
		outputs: { answer: { markdown: "Ready to deliver" } },
	});
	m.observerDescribe.mockResolvedValue({
		type: "recordedRunQualityWorkflow",
		runId: "example-check-run",
		memo: {
			fabricRunQuality: {
				version: 1,
				...actor,
				assessmentId: input.assessmentId,
			},
		},
	});
	m.client.mockResolvedValue({
		workflow: {
			getHandle: (id: string) =>
				id === row.assessmentWorkflowId
					? { describe: m.observerDescribe }
					: { describe: m.nativeDescribe, result: m.result },
			withAbortSignal: async (_signal: unknown, fn: () => unknown) =>
				fn(),
		},
	});
});
describe("automatic checks inspect a recorded native result", () => {
	it("waits once and persists only minimized grade/hash, never output text", async () => {
		await assessRecordedRunQuality(input);
		expect(m.result).toHaveBeenCalledTimes(1);
		expect(stored().verdict).toBe("PASSED");
		expect(JSON.stringify(stored())).not.toContain("Ready to deliver");
		expect(stored().reportJson.coverage).toEqual({
			total: 1,
			passed: 1,
			failed: 0,
			unavailable: 0,
		});
	});
	it("keeps business completion separate from a failed quality check", async () => {
		m.result.mockResolvedValue({
			status: "COMPLETED",
			executionId: row.workflowExecutionId,
			outputs: { answer: "Missing marker" },
		});
		await assessRecordedRunQuality(input);
		expect(stored().verdict).toBe("NEEDS_ATTENTION");
		expect(m.execution).not.toHaveBeenCalled();
	});
	it("marks missing output unavailable", async () => {
		m.result.mockResolvedValue({
			status: "COMPLETED",
			executionId: row.workflowExecutionId,
			outputs: {},
		});
		await assessRecordedRunQuality(input);
		expect(stored().verdict).toBe("UNAVAILABLE");
	});
	it("does not pass a failed native business run", async () => {
		m.result.mockResolvedValue({ status: "FAILED" });
		await assessRecordedRunQuality(input);
		expect(stored()).toMatchObject({
			verdict: "UNAVAILABLE",
			errorCode: "EXECUTION_FAILED",
			reportJson: null,
		});
	});
	it("does not pass an incomplete goal", async () => {
		m.snapshot.mockResolvedValue({
			kind: "AGENT",
			scope: { configHash: "example-config-hash" },
		});
		m.row.mockResolvedValue({
			...row,
			workflowExecutionId: null,
			agentExecutionId: "example-agent-execution",
			policy: { workflowId: null, instanceId: "example-agent" },
			sourceScopeJson: {
				kind: "AGENT",
				scope: { configHash: "example-config-hash" },
			},
		});
		m.nativeDescribe.mockResolvedValue({
			...nativeDescription,
			type: "nativeGoalOrientedAgentWorkflow",
		});
		m.result.mockResolvedValue({
			status: "COMPLETED",
			goalAchieved: false,
		});
		await assessRecordedRunQuality(input);
		expect(stored().errorCode).toBe("EXECUTION_FAILED");
	});
	it("rejects substituted observer admission", async () => {
		m.observerDescribe.mockResolvedValue({
			type: "recordedRunQualityWorkflow",
			runId: "example-check-run",
			memo: {},
		});
		await expect(assessRecordedRunQuality(input)).rejects.toMatchObject({
			type: "NATIVE_IDENTITY_INVALID",
		});
		expect(m.result).not.toHaveBeenCalled();
	});
	it("rejects a substituted native run", async () => {
		m.nativeDescribe.mockResolvedValue({
			...nativeDescription,
			runId: "example-other-run",
		});
		await assessRecordedRunQuality(input);
		expect(stored()).toMatchObject({
			verdict: "UNAVAILABLE",
			reportJson: null,
			errorCode: "NATIVE_IDENTITY_INVALID",
		});
		expect(m.result).not.toHaveBeenCalled();
	});
	it("rechecks source permissions after native completion", async () => {
		m.source
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(
				new RunQualityError("NOT_FOUND", "Source access revoked"),
			);
		await assessRecordedRunQuality(input);
		expect(stored()).toMatchObject({
			verdict: "UNAVAILABLE",
			reportJson: null,
			errorCode: "SOURCE_ACCESS_REVOKED",
		});
	});
	it("does not read native evidence for an unavailable captured scope", async () => {
		m.row.mockResolvedValue({
			...row,
			sourceScopeJson: { kind: "UNAVAILABLE" },
		});
		await assessRecordedRunQuality(input);
		expect(stored().errorCode).toBe("SOURCE_ACCESS_REVOKED");
		expect(m.result).not.toHaveBeenCalled();
	});
	it("does not leave expired work in CHECKING", async () => {
		m.row.mockResolvedValue({ ...row, deadlineAt: new Date(0) });
		await assessRecordedRunQuality(input);
		expect(stored()).toMatchObject({
			status: "COMPLETED",
			verdict: "UNAVAILABLE",
			errorCode: "CHECK_BUDGET_EXCEEDED",
			reportJson: null,
		});
		expect(m.audit.mock.calls.at(-1)?.[1].metadata.verdict).toBe(
			"UNAVAILABLE",
		);
	});
	it("honors a durable cancel fence after result delivery", async () => {
		m.row
			.mockResolvedValueOnce(row)
			.mockResolvedValue({ ...row, status: "CANCELLED" });
		await assessRecordedRunQuality(input);
		expect(stored()).toBeUndefined();
	});
	it("does not fetch a second result for already settled work", async () => {
		m.row.mockResolvedValue({ ...row, status: "COMPLETED" });
		await assessRecordedRunQuality(input);
		expect(m.result).not.toHaveBeenCalled();
	});
	it("uses the exact executed graph selectors at admission", async () => {
		m.info.workflowType = "workflowBuilderExecutionWorkflow";
		m.info.workflowExecution = {
			workflowId: row.nativeWorkflowId,
			runId: row.nativeRunId,
		};
		m.execution.mockResolvedValue({
			id: row.workflowExecutionId,
			version: 3,
			temporalRunId: row.nativeWorkflowId,
		});
		m.policy.mockResolvedValue({ id: row.policyId, enabled: true });
		m.row.mockResolvedValue(null);
		m.snapshot.mockResolvedValue(row.sourceScopeJson);
		m.admit.mockResolvedValue(row);
		const graph = {
			nodes: [{ data: { workspaceId: "example-original-workspace" } }],
			projectId: null,
		};
		await admitRecordedRunQuality({
			...actor,
			targetType: "WORKFLOW",
			targetId: "example-workflow",
			executionId: row.workflowExecutionId,
			executedGraph: graph,
		});
		expect(m.snapshot).toHaveBeenCalledWith(
			actor,
			expect.any(Object),
			graph,
		);
		expect(m.admit.mock.calls[0][0].nativeRunId).toBe(row.nativeRunId);
	});
	it.each([
		"nativeDeploymentExecutionWorkflow",
		"nativeGoalOrientedAgentWorkflow",
	])(
		"assesses %s only with the exact admission and completed receipt",
		async (type) => {
			const agentRow = {
				...row,
				workflowExecutionId: null,
				agentExecutionId: "example-agent-execution",
				policy: { workflowId: null, instanceId: "example-agent" },
				sourceScopeJson: {
					kind: "AGENT",
					scope: { configHash: "example-config-hash" },
				},
				rulesJson: [{ ...rules[0], nodeId: undefined }],
			};
			m.row.mockResolvedValue(agentRow);
			m.snapshot.mockResolvedValue({
				kind: "AGENT",
				scope: { configHash: "example-config-hash" },
			});
			m.execution.mockResolvedValue({
				id: "example-agent-execution",
				executionId: "example-native-execution",
				status: "COMPLETED",
			});
			m.admission.mockReturnValue({
				requestHash: "example-request-hash",
				dispatch: { workflowType: type },
			});
			m.nativeDescribe.mockResolvedValue({
				...nativeDescription,
				type,
				memo: {
					fabricAgentAdmission: {
						version: 1,
						...actor,
						executionId: "example-agent-execution",
						requestHash: "example-request-hash",
					},
				},
			});
			m.result.mockResolvedValue({
				status: "COMPLETED",
				executionId: "example-native-execution",
				goalAchieved: true,
				qualityConfiguration: {
					version: 1,
					assessmentId: row.id,
					configHash: "example-config-hash",
				},
				output: {
					response: "Ready for review",
					markdown: "No response generated",
				},
			});
			await assessRecordedRunQuality(input);
			expect(stored().verdict).toBe("PASSED");
		},
	);
	it("refuses an unconfirmed effect even when the native workflow completed", async () => {
		const type = "nativeDeploymentExecutionWorkflow";
		m.row.mockResolvedValue({
			...row,
			workflowExecutionId: null,
			agentExecutionId: "example-agent-execution",
			policy: { workflowId: null, instanceId: "example-agent" },
			sourceScopeJson: {
				kind: "AGENT",
				scope: { configHash: "example-config-hash" },
			},
		});
		m.snapshot.mockResolvedValue({
			kind: "AGENT",
			scope: { configHash: "example-config-hash" },
		});
		m.execution.mockResolvedValue({
			id: "example-agent-execution",
			executionId: "example-native-execution",
			status: "COMPLETED",
		});
		m.admission.mockReturnValue({
			requestHash: "example-request-hash",
			dispatch: { workflowType: type },
		});
		m.nativeDescribe.mockResolvedValue({
			...nativeDescription,
			type,
			memo: {
				fabricAgentAdmission: {
					version: 1,
					...actor,
					executionId: "example-agent-execution",
					requestHash: "example-request-hash",
				},
			},
		});
		m.result.mockResolvedValue({
			status: "COMPLETED",
			executionId: "example-native-execution",
			response: "Ready",
			inspectionRequired: true,
		});
		await assessRecordedRunQuality(input);
		expect(stored()).toMatchObject({
			verdict: "UNAVAILABLE",
			errorCode: "EVIDENCE_UNAVAILABLE",
			reportJson: null,
		});
	});
	it.each([
		{
			markdown: "Ready",
			toolCallSummary: [{ status: "error" }],
			inspectionRequired: false,
		},
		{
			markdown: "Ready",
			inspectionRequired: true,
			toolCallSummary: [{ status: "completed" }],
		},
		{ markdown: "Ready", toolCallSummary: [{ status: "pending" }] },
	])(
		"cannot pass workflow agent-task output with uncertain effects",
		async (answer) => {
			m.result.mockResolvedValue({
				status: "COMPLETED",
				executionId: row.workflowExecutionId,
				outputs: { answer },
			});
			await assessRecordedRunQuality(input);
			expect(stored()).toMatchObject({
				verdict: "UNAVAILABLE",
				reportJson: null,
				errorCode: "EVIDENCE_UNAVAILABLE",
			});
		},
	);

	it("records cooperative cancellation distinctly from failure", async () => {
		m.result.mockResolvedValue({ status: "CANCELLED" });
		await assessRecordedRunQuality(input);
		expect(stored().errorCode).toBe("EXECUTION_CANCELLED");
	});
	it.each([
		["x".repeat(16_385), undefined, "OUTPUT_TOO_LARGE"],
		[{ text: "Ready" }, "/missing", "OUTPUT_SELECTION_INVALID"],
		["", undefined, "NO_OUTPUT"],
	])(
		"explains unavailable selection without copying output",
		async (answer, pointer, reason) => {
			m.row.mockResolvedValue({
				...row,
				rulesJson: [{ ...rules[0], pointer }],
			});
			m.result.mockResolvedValue({
				status: "COMPLETED",
				executionId: row.workflowExecutionId,
				outputs: { answer },
			});
			await assessRecordedRunQuality(input);
			expect(stored().reportJson.rules[0].reason).toBe(reason);
		},
	);

	it.each([
		undefined,
		{ version: 1, assessmentId: row.id, configHash: "example-loaded-y" },
	])(
		"cannot pass with missing or different actual loaded configuration provenance",
		async (qualityConfiguration) => {
			const type = "nativeDeploymentExecutionWorkflow";
			m.row.mockResolvedValue({
				...row,
				workflowExecutionId: null,
				agentExecutionId: "example-agent-execution",
				policy: { workflowId: null, instanceId: "example-agent" },
				sourceScopeJson: {
					kind: "AGENT",
					scope: { configHash: "example-config-hash" },
				},
			});
			m.snapshot.mockResolvedValue({
				kind: "AGENT",
				scope: { configHash: "example-config-hash" },
			});
			m.execution.mockResolvedValue({
				id: "example-agent-execution",
				executionId: "example-native-execution",
				status: "COMPLETED",
			});
			m.admission.mockReturnValue({
				requestHash: "example-request-hash",
				dispatch: { workflowType: type },
			});
			m.nativeDescribe.mockResolvedValue({
				...nativeDescription,
				type,
				memo: {
					fabricAgentAdmission: {
						version: 1,
						...actor,
						executionId: "example-agent-execution",
						requestHash: "example-request-hash",
					},
				},
			});
			m.result.mockResolvedValue({
				status: "COMPLETED",
				executionId: "example-native-execution",
				response: "Ready",
				qualityConfiguration,
			});
			await assessRecordedRunQuality(input);
			expect(stored()).toMatchObject({
				verdict: "UNAVAILABLE",
				reportJson: null,
				errorCode: qualityConfiguration
					? "POLICY_CHANGED"
					: "EVIDENCE_UNAVAILABLE",
			});
		},
	);
	it("recovers only a committed pinned admission after a lost acknowledgement", async () => {
		const reference = {
			...actor,
			targetType: "WORKFLOW" as const,
			targetId: "example-workflow",
			executionId: row.workflowExecutionId,
			nativeWorkflowId: row.nativeWorkflowId,
			nativeRunId: row.nativeRunId,
		};
		m.info.workflowType = "recordedRunQualityAdmissionRecoveryWorkflow";
		m.info.workflowExecution = {
			workflowId: `run-quality-recovery-${row.nativeRunId}`,
			runId: "example-recovery-run",
		};
		m.client.mockResolvedValue({
			workflow: {
				getHandle: () => ({
					describe: async () => ({
						type: m.info.workflowType,
						runId: "example-recovery-run",
						memo: {
							fabricRunQualityAdmissionRecovery: {
								version: 1,
								...reference,
							},
						},
					}),
				}),
			},
		});
		await settleUnconfirmedRunQualityAdmission(reference);
		expect(stored()).toMatchObject({
			status: "COMPLETED",
			verdict: "UNAVAILABLE",
			reportJson: null,
			errorCode: "ASSESSMENT_UNAVAILABLE",
		});
		expect(m.admit).not.toHaveBeenCalled();
	});
	it("refuses a forged recovery memo before reading or changing evidence", async () => {
		const reference = {
			...actor,
			targetType: "WORKFLOW" as const,
			targetId: "example-workflow",
			executionId: row.workflowExecutionId,
			nativeWorkflowId: row.nativeWorkflowId,
			nativeRunId: row.nativeRunId,
		};
		m.info.workflowType = "recordedRunQualityAdmissionRecoveryWorkflow";
		m.info.workflowExecution = {
			workflowId: `run-quality-recovery-${row.nativeRunId}`,
			runId: "example-recovery-run",
		};
		m.client.mockResolvedValue({
			workflow: {
				getHandle: () => ({
					describe: async () => ({
						type: m.info.workflowType,
						runId: "example-recovery-run",
						memo: {
							fabricRunQualityAdmissionRecovery: {
								version: 1,
								...reference,
								userId: "example-other-member",
							},
						},
					}),
				}),
			},
		});
		await expect(
			settleUnconfirmedRunQualityAdmission(reference),
		).rejects.toMatchObject({ type: "NATIVE_IDENTITY_INVALID" });
		expect(m.row).not.toHaveBeenCalled();
		expect(m.update).not.toHaveBeenCalled();
	});
});
