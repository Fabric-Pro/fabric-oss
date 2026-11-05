import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	row: vi.fn(),
	update: vi.fn(),
	source: vi.fn(),
	loadScope: vi.fn(),
	observerDescribe: vi.fn(),
	admission: vi.fn(),
	getClient: vi.fn(),
	describe: vi.fn(),
	result: vi.fn(),
	getHandle: vi.fn(),
	heartbeat: vi.fn(),
	info: {
		workflowType: "agentTestAssessmentWorkflow",
		workflowExecution: {
			workflowId: "example-assessment",
			runId: "example-assessment-run",
		},
	},
	signal: new AbortController().signal,
}));
vi.mock("@repo/database", async () => ({
	db: { agentTestRun: { findFirst: m.row, updateMany: m.update } },
	readAgentExecutionAdmission: m.admission,
	Prisma: {
		DbNull: null,
		Decimal: (await import("@repo/database/prisma/generated/browser.js"))
			.Prisma.Decimal,
	},
}));
vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({ info: m.info, cancellationSignal: m.signal }),
	},
	heartbeat: m.heartbeat,
}));
vi.mock("../../client", () => ({ getTemporalClient: m.getClient }));
vi.mock("../../lib/agent-test-access", () => ({
	assertAgentTestSourceScope: m.source,
	loadAgentTestScope: m.loadScope,
}));

import {
	assessAgentTestRun,
	failAgentTestAssessment,
} from "../agent-test-assessment";

const actor = { userId: "example-user", organizationId: "example-org" };
const input = { ...actor, testRunId: "example-test-run" };
const checks = { requiredPhrases: ["Ready"], forbiddenPhrases: ["secret"] };
const admission = {
	requestHash: "example-hash",
	dispatch: {
		instanceId: "example-agent",
		projectId: "example-project",
		workflowType: "nativeDeploymentExecutionWorkflow",
	},
};
const execution = {
	id: "example-execution",
	executionId: "example-execution-key",
	...actor,
	workflowId: "example-native",
	runId: "example-native-run",
	totalCost: null,
};
const row = {
	id: input.testRunId,
	...actor,
	status: "RUNNING",
	instanceId: "example-agent",
	agentSId: "example-logical-agent",
	executionId: execution.id,
	agentVersion: 2,
	caseRevision: 3,
	requestHash: "example-request-hash",
	evaluationWorkflowId: "example-assessment",
	evaluationRunId: "example-assessment-run",
	nativeWorkflowId: "example-native",
	nativeRunId: "example-native-run",
	sourceScopeJson: {
		origin: { instanceId: "example-origin" },
		execution: {
			instanceId: "example-agent",
			projectId: "example-project",
		},
	},
	checksJson: checks,
	execution,
};
const description = {
	runId: row.nativeRunId,
	type: admission.dispatch.workflowType,
	memo: {
		fabricAgentAdmission: {
			executionId: execution.id,
			...actor,
			version: 1,
			requestHash: admission.requestHash,
		},
	},
	status: { name: "COMPLETED" },
	startTime: new Date("2026-01-01T00:00:00Z"),
	closeTime: new Date("2026-01-01T00:00:02Z"),
};
beforeEach(() => {
	vi.resetAllMocks();
	m.info.workflowType = "agentTestAssessmentWorkflow";
	m.info.workflowExecution = {
		workflowId: row.evaluationWorkflowId,
		runId: row.evaluationRunId,
	};
	m.row.mockResolvedValue(row);
	m.update.mockResolvedValue({ count: 1 });
	m.source.mockImplementation(async (_actor, scope) => scope);
	m.loadScope.mockResolvedValue({
		instance: {
			id: row.instanceId,
			version: row.agentVersion,
			sId: row.agentSId,
		},
		scope: { ...row.sourceScopeJson.execution, configHash: "a".repeat(64) },
	});
	m.admission.mockReturnValue(admission);
	m.describe.mockResolvedValue(description);
	m.result.mockResolvedValue({
		status: "COMPLETED",
		output: { response: "Ready for review." },
		tokenUsage: { inputTokens: 10, outputTokens: 4 },
		durationMs: 1234,
	});
	m.observerDescribe.mockResolvedValue({
		runId: row.evaluationRunId,
		type: "agentTestAssessmentWorkflow",
		memo: {
			fabricAgentTest: {
				version: 1,
				...actor,
				testRunId: row.id,
				requestHash: row.requestHash,
			},
		},
	});
	m.getHandle.mockImplementation((workflowId: string) =>
		workflowId === row.evaluationWorkflowId
			? { describe: m.observerDescribe }
			: { describe: m.describe, result: m.result },
	);
	m.getClient.mockResolvedValue({
		workflow: {
			getHandle: m.getHandle,
			withAbortSignal: async (_signal: unknown, fn: () => unknown) =>
				fn(),
		},
	});
});
describe("native saved-agent exact text assessment", () => {
	it("awaits the recorded native run once and stores only minimized checks, hash and native usage", async () => {
		await assessAgentTestRun(input);
		expect(m.getHandle).toHaveBeenCalledWith(
			row.nativeWorkflowId,
			row.nativeRunId,
			{ followRuns: false },
		);
		expect(m.result).toHaveBeenCalledExactlyOnceWith();
		const data = m.update.mock.calls.at(-1)?.[0].data;
		expect(data).toMatchObject({
			status: "COMPLETED",
			verdict: "PASSED",
			reportJson: {
				method: "exact-text",
				passed: 2,
				total: 2,
				outputHash: createHash("sha256")
					.update("Ready for review.")
					.digest("hex"),
				inputTokens: 10,
				outputTokens: 4,
				totalCost: null,
			},
		});
		expect(JSON.stringify(data)).not.toContain("Ready for review.");
		expect(m.source.mock.calls.length).toBeGreaterThanOrEqual(6);
	});
	it("uses case-sensitive exact checks and never includes phrase values in the report", async () => {
		m.result.mockResolvedValue({
			status: "COMPLETED",
			output: { response: "ready with secret" },
		});
		await assessAgentTestRun(input);
		const data = m.update.mock.calls.at(-1)?.[0].data;
		expect(data).toMatchObject({
			verdict: "FAILED",
			reportJson: {
				passed: 0,
				total: 2,
				inputTokens: null,
				outputTokens: null,
			},
		});
		expect(JSON.stringify(data)).not.toContain("secret");
	});
	it.each([
		{ status: "FAILED", success: true },
		{ status: "MAX_ITERATIONS_REACHED", success: true },
		{ success: true },
	])(
		"never treats native business failure as success: %j",
		async (output) => {
			m.result.mockResolvedValue({
				...output,
				response: "Ready",
				output: { response: "Ready" },
			});
			await expect(assessAgentTestRun(input)).rejects.toThrow();
			expect(m.update).not.toHaveBeenCalled();
		},
	);
	it("does not turn uncertain tool effects into a passing quality test", async () => {
		m.result.mockResolvedValue({
			status: "COMPLETED",
			response: "Ready",
			output: {
				response: "Ready",
				toolCalls: [{ status: "pending", inspectionRequired: true }],
			},
		});
		await expect(assessAgentTestRun(input)).rejects.toThrow();
		expect(m.update).not.toHaveBeenCalled();
	});
	it("records native cancellation without a verdict or report", async () => {
		m.result.mockResolvedValue({ status: "CANCELLED" });
		await assessAgentTestRun(input);
		expect(m.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "CANCELLED" }),
			}),
		);
		expect(JSON.stringify(m.update.mock.calls)).not.toContain('"PASSED"');
	});
	it("refuses a stale native run receipt before awaiting output", async () => {
		m.row.mockResolvedValue({
			...row,
			execution: { ...execution, runId: "example-other-native-run" },
		});
		await expect(assessAgentTestRun(input)).rejects.toThrow();
		expect(m.result).not.toHaveBeenCalled();
	});
	it("checks native admission memo and never follows a different native workflow", async () => {
		m.describe.mockResolvedValue({
			...description,
			memo: {
				fabricAgentAdmission: {
					...description.memo.fabricAgentAdmission,
					requestHash: "example-other-hash",
				},
			},
		});
		await expect(assessAgentTestRun(input)).rejects.toThrow();
		expect(m.result).not.toHaveBeenCalled();
	});
	it("refuses another assessment run even when workflow ID is the same", async () => {
		m.info.workflowExecution = {
			workflowId: row.evaluationWorkflowId,
			runId: "example-other-assessment-run",
		};
		await expect(assessAgentTestRun(input)).rejects.toThrow();
		expect(m.result).not.toHaveBeenCalled();
	});
	it("withholds results after original source access is removed while native execution finishes", async () => {
		m.result.mockImplementation(async () => {
			m.source.mockRejectedValue(new Error("Example access removed"));
			return { status: "COMPLETED", output: { response: "Ready" } };
		});
		await expect(assessAgentTestRun(input)).rejects.toThrow();
		expect(m.update).not.toHaveBeenCalled();
	});
	it("does not await or redispatch a terminal assessment on activity retry", async () => {
		m.row.mockResolvedValue({ ...row, status: "COMPLETED" });
		await assessAgentTestRun(input);
		expect(m.result).not.toHaveBeenCalled();
	});
	it("marks observer failure without persisting exception text or native output", async () => {
		await failAgentTestAssessment(input);
		expect(m.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: row.id, ...actor }),
				data: expect.objectContaining({
					status: "ERROR",
					verdict: null,
					reportJson: null,
					errorCode: "ASSESSMENT_UNAVAILABLE",
				}),
			}),
		);
	});
});

it("uses a native goal response rather than serializing variables or tool payloads", async () => {
	m.result.mockResolvedValue({
		status: "COMPLETED",
		response: "Ready for review.",
		output: { variables: { private: "Never retain" }, trajectorySteps: [] },
	});
	await assessAgentTestRun(input);
	expect(m.update.mock.calls.at(-1)?.[0].data).toMatchObject({
		verdict: "PASSED",
	});
	expect(JSON.stringify(m.update.mock.calls)).not.toContain("Never retain");
});
it("retains a verified native cost when its database usage projection is unavailable", async () => {
	m.result.mockResolvedValue({
		status: "COMPLETED",
		response: "Ready",
		tokenUsage: { inputTokens: 10, outputTokens: 4, totalCost: 0.0003 },
	});
	await assessAgentTestRun(input);
	expect(m.update.mock.calls.at(-1)?.[0].data.reportJson.totalCost).toBe(
		"0.0003",
	);
});

describe("assessment frozen configuration and acknowledgement races", () => {
	it("accepts a missing observer run receipt only after verifying its exact current memo", async () => {
		m.row.mockResolvedValue({ ...row, evaluationRunId: null });
		await assessAgentTestRun(input);
		expect(m.observerDescribe).toHaveBeenCalled();
		expect(m.update.mock.calls.at(-1)?.[0].data.status).toBe("COMPLETED");
	});
	it("refuses a forged observer admission memo even before its API receipt is saved", async () => {
		m.row.mockResolvedValue({ ...row, evaluationRunId: null });
		m.observerDescribe.mockResolvedValue({
			runId: row.evaluationRunId,
			type: "agentTestAssessmentWorkflow",
			memo: {
				fabricAgentTest: {
					version: 1,
					...actor,
					testRunId: row.id,
					requestHash: "example-foreign-hash",
				},
			},
		});
		await expect(assessAgentTestRun(input)).rejects.toMatchObject({
			type: "AGENT_TEST_FORBIDDEN",
		});
		expect(m.result).not.toHaveBeenCalled();
	});
	it("refuses native admission from a different project than the frozen execution source", async () => {
		m.admission.mockReturnValue({
			...admission,
			dispatch: {
				...admission.dispatch,
				projectId: "example-other-project",
			},
		});
		await expect(assessAgentTestRun(input)).rejects.toMatchObject({
			type: "AGENT_TEST_IDENTITY_INVALID",
		});
		expect(m.result).not.toHaveBeenCalled();
	});
	it("verifies the semantic configuration before awaiting the native run", async () => {
		m.row.mockResolvedValue({
			...row,
			sourceScopeJson: {
				...row.sourceScopeJson,
				execution: {
					...row.sourceScopeJson.execution,
					configHash: "b".repeat(64),
				},
			},
		});
		await expect(assessAgentTestRun(input)).rejects.toMatchObject({
			type: "AGENT_TEST_CONFIG_CHANGED",
		});
		expect(m.result).not.toHaveBeenCalled();
	});
	it("withholds a report if semantic configuration changes while the native run completes", async () => {
		m.row.mockResolvedValue({
			...row,
			sourceScopeJson: {
				...row.sourceScopeJson,
				execution: {
					...row.sourceScopeJson.execution,
					configHash: "a".repeat(64),
				},
			},
		});
		m.result.mockImplementation(async () => {
			m.loadScope.mockResolvedValue({
				instance: {
					id: row.instanceId,
					version: row.agentVersion,
					sId: row.agentSId,
				},
				scope: {
					...row.sourceScopeJson.execution,
					configHash: "b".repeat(64),
				},
			});
			return { status: "COMPLETED", response: "Ready" };
		});
		await expect(assessAgentTestRun(input)).rejects.toMatchObject({
			type: "AGENT_TEST_CONFIG_CHANGED",
		});
		expect(m.update).not.toHaveBeenCalled();
	});
	it("does not invalidate a completed historical assessment merely because current configuration differs", async () => {
		m.row.mockResolvedValue({
			...row,
			status: "COMPLETED",
			sourceScopeJson: {
				...row.sourceScopeJson,
				execution: {
					...row.sourceScopeJson.execution,
					configHash: "b".repeat(64),
				},
			},
		});
		await assessAgentTestRun(input);
		expect(m.loadScope).not.toHaveBeenCalled();
		expect(m.result).not.toHaveBeenCalled();
	});
	it("formats tiny verified native costs without exponent notation", async () => {
		m.result.mockResolvedValue({
			status: "COMPLETED",
			response: "Ready",
			tokenUsage: { totalCost: 1e-7 },
		});
		await assessAgentTestRun(input);
		expect(m.update.mock.calls.at(-1)?.[0].data.reportJson.totalCost).toBe(
			"0.0000001",
		);
	});
	it("does not infer a successful business result from a failed native engine execution", async () => {
		m.describe.mockResolvedValue({
			...description,
			status: { name: "FAILED" },
		});
		await expect(assessAgentTestRun(input)).rejects.toMatchObject({
			type: "AGENT_TEST_EXECUTION_FAILED",
		});
		expect(m.update).not.toHaveBeenCalled();
	});
});

it("retains a safe failure classification while rejecting arbitrary failure strings", async () => {
	await failAgentTestAssessment({
		...input,
		errorCode: "AGENT_TEST_CONFIG_CHANGED",
	});
	expect(m.update.mock.calls.at(-1)?.[0].data.errorCode).toBe(
		"AGENT_TEST_CONFIG_CHANGED",
	);
	await failAgentTestAssessment({
		...input,
		errorCode: "Example private provider exception",
	});
	expect(m.update.mock.calls.at(-1)?.[0].data.errorCode).toBe(
		"ASSESSMENT_UNAVAILABLE",
	);
});

it("does not grade a goal's display placeholder as a real deliverable for forbidden-only checks", async () => {
	m.row.mockResolvedValue({
		...row,
		checksJson: { requiredPhrases: [], forbiddenPhrases: ["secret"] },
	});
	m.result.mockResolvedValue({
		status: "COMPLETED",
		response: "No response generated",
		output: { response: "", variables: {}, trajectorySteps: [] },
	});
	await expect(assessAgentTestRun(input)).rejects.toMatchObject({
		type: "AGENT_TEST_NO_TEXT",
	});
	expect(m.update).not.toHaveBeenCalled();
});
