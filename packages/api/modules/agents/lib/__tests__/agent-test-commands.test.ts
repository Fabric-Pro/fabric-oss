import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	permission: vi.fn(),
	lock: vi.fn(),
	previewSource: vi.fn(),
	load: vi.fn(),
	source: vi.fn(),
	bound: vi.fn(),
	caseFind: vi.fn(),
	caseList: vi.fn(),
	caseCount: vi.fn(),
	caseCreate: vi.fn(),
	caseUpdate: vi.fn(),
	runFind: vi.fn(),
	runList: vi.fn(),
	runUpsert: vi.fn(),
	runUpdate: vi.fn(),
	runUpdateMany: vi.fn(),
	execute: vi.fn(),
	cancel: vi.fn(),
	audit: vi.fn(),
	start: vi.fn(),
	describe: vi.fn(),
	getClient: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		$transaction: (run: (tx: unknown) => unknown) =>
			run({
				$queryRaw: m.lock,
				agentTestCase: { findFirst: m.caseFind },
				agentTestRun: { findFirst: m.runFind, upsert: m.runUpsert },
			}),
		agentTestCase: {
			findFirst: m.caseFind,
			findMany: m.caseList,
			count: m.caseCount,
			create: m.caseCreate,
			updateMany: m.caseUpdate,
		},
		agentTestRun: {
			findFirst: m.runFind,
			findMany: m.runList,
			upsert: m.runUpsert,
			update: m.runUpdate,
			updateMany: m.runUpdateMany,
		},
	},
	canExecuteOrganizationAgents: m.permission,
	Prisma: {
		Decimal: class {
			constructor(readonly value: string) {}
			minus(other: string) {
				return {
					toString: () => String(Number(this.value) - Number(other)),
				};
			}
		},
	},
}));
vi.mock("@repo/temporal/client", () => ({ getTemporalClient: m.getClient }));
vi.mock("@repo/temporal/agent-test-access", () => ({
	loadAgentTestScope: m.load,
	assertAgentTestSourceScope: m.source,
	boundAgentTest: m.bound,
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (value: unknown) => value,
}));
vi.mock("../../../external-api/procedures/execute-agent", () => ({
	executeAgentForActor: m.execute,
}));
vi.mock("../../../agent-deployments/lib/run-commands", () => ({
	cancelAgentRunCommand: m.cancel,
}));

vi.mock("../agent-preview-commands", () => ({
	getCompletedAgentPreviewTestSource: m.previewSource,
}));

import { AgentTestError } from "@repo/temporal/agent-test-contracts";
import {
	archiveAgentTestCaseCommand,
	cancelAgentTestRunCommand,
	compareAgentTestRunsCommand,
	createAgentTestCaseCommand,
	getAgentTestRunCommand,
	listAgentTestCasesCommand,
	listAgentTestRunsCommand,
	startAgentTestRunCommand,
	updateAgentTestCaseCommand,
} from "../agent-test-commands";

const actor = { userId: "example-user", organizationId: "example-org" };
const now = new Date("2026-01-01T00:00:00Z");
const checks = { requiredPhrases: ["Ready"], forbiddenPhrases: [] };
const scope = {
	instanceId: "example-agent-v1",
	configHash: "a".repeat(64),
	projectId: "example-project",
	workspaceIds: ["example-workspace"],
	workspaceDocumentFilters: [
		{ workspaceId: "example-workspace", documentIds: ["example-document"] },
	],
	skillIds: [],
};
const test = {
	id: "example-case",
	...actor,
	agentSId: "example-logical-agent",
	originInstanceId: scope.instanceId,
	name: "Example test",
	input: "Return Ready",
	checksJson: checks,
	revision: 7,
	sourceScopeJson: scope,
	archivedAt: null,
	createdAt: now,
	updatedAt: now,
};
const target = {
	instance: { id: scope.instanceId, sId: test.agentSId, version: 1 },
	scope,
};
const request = {
	caseId: test.id,
	caseRevision: 7,
	instanceId: scope.instanceId,
	idempotencyKey: "ca49e4ed-8ef5-40aa-9f09-a1db648b7211",
};
const report = {
	version: 1,
	method: "exact-text",
	outputHash: "0".repeat(64),
	passed: 1,
	total: 1,
	results: [{ kind: "required", index: 0, passed: true }],
	durationMs: 10,
	inputTokens: 2,
	outputTokens: 1,
	totalCost: "0.001",
};
const run = {
	id: "example-run",
	...actor,
	caseId: test.id,
	instanceId: scope.instanceId,
	agentSId: test.agentSId,
	agentVersion: 1,
	caseRevision: 7,
	caseInput: test.input,
	checksJson: checks,
	sourceScopeJson: { origin: scope, execution: scope },
	requestKey: request.idempotencyKey,
	requestHash: "example-request-hash",
	status: "COMPLETED",
	verdict: "PASSED",
	executionId: "example-execution",
	nativeWorkflowId: "example-native",
	nativeRunId: "example-native-run",
	evaluationWorkflowId: "example-assessment",
	evaluationRunId: "example-assessment-run",
	reportJson: report,
	errorCode: null,
	createdAt: now,
	completedAt: now,
};
let storedRuns: Map<string, any>;
beforeEach(() => {
	vi.resetAllMocks();
	storedRuns = new Map();
	m.permission.mockResolvedValue(true);
	m.load.mockResolvedValue(target);
	m.source.mockImplementation(async (_actor, raw) => raw);
	m.caseFind.mockResolvedValue(test);
	m.caseList.mockResolvedValue([test]);
	m.caseCount.mockResolvedValue(0);
	m.caseCreate.mockImplementation(async ({ data }) => ({ ...test, ...data }));
	m.caseUpdate.mockResolvedValue({ count: 1 });
	m.runFind.mockImplementation(async ({ where }) =>
		where.id
			? (storedRuns.get(where.id) ?? null)
			: where.requestKey
				? ([...storedRuns.values()].find(
						(x) => x.requestKey === where.requestKey,
					) ?? null)
				: null,
	);
	m.runList.mockImplementation(async () => [...storedRuns.values()]);
	m.runUpsert.mockImplementation(async ({ where, create }) => {
		let value = storedRuns.get(where.id);
		if (!value) {
			value = {
				...run,
				...create,
				status: "ADMITTING",
				verdict: null,
				executionId: null,
				nativeWorkflowId: null,
				nativeRunId: null,
				evaluationRunId: null,
				reportJson: null,
				completedAt: null,
			};
			storedRuns.set(where.id, value);
		}
		return value;
	});
	m.runUpdate.mockImplementation(async ({ where, data }) => {
		const value = { ...storedRuns.get(where.id), ...data };
		storedRuns.set(where.id, value);
		return value;
	});
	m.runUpdateMany.mockImplementation(async ({ where, data }) => {
		const existing = storedRuns.get(where.id);
		const matches =
			existing &&
			Object.entries(where).every(
				([key, value]) => existing[key] === value,
			);
		if (matches) {
			storedRuns.set(where.id, { ...existing, ...data });
		}
		return { count: matches ? 1 : 0 };
	});
	m.execute.mockResolvedValue({
		status: 202,
		data: {
			executionId: "example-execution",
			workflowId: "example-native",
			runId: "example-native-run",
		},
	});
	m.cancel.mockResolvedValue({ requested: true });
	m.start.mockResolvedValue({
		firstExecutionRunId: "example-assessment-run",
	});
	m.describe.mockImplementation(async () => {
		const value = [...storedRuns.values()][0] ?? run;
		return {
			runId: "example-assessment-run",
			type: "agentTestAssessmentWorkflow",
			memo: {
				fabricAgentTest: {
					version: 1,
					...actor,
					testRunId: value.id,
					requestHash: value.requestHash,
				},
			},
		};
	});
	m.getClient.mockResolvedValue({
		workflow: {
			start: m.start,
			getHandle: () => ({ describe: m.describe }),
		},
	});
});
describe("agent test shared case/run commands", () => {
	it.each(["create", "start", "update", "archive", "cancel"])(
		"checks current actor permission before %s mutation",
		async (operation) => {
			m.permission.mockResolvedValue(false);
			const actions = {
				create: () =>
					createAgentTestCaseCommand(
						actor,
						{
							instanceId: scope.instanceId,
							name: test.name,
							input: test.input,
							checks,
						},
						m.audit,
					),
				start: () => startAgentTestRunCommand(actor, request, m.audit),
				update: () =>
					updateAgentTestCaseCommand(
						actor,
						{
							caseId: test.id,
							revision: 7,
							name: test.name,
							input: test.input,
							checks,
						},
						m.audit,
					),
				archive: () =>
					archiveAgentTestCaseCommand(
						actor,
						{ caseId: test.id, revision: 7 },
						m.audit,
					),
				cancel: () =>
					cancelAgentTestRunCommand(
						actor,
						{ testRunId: run.id },
						m.audit,
					),
			};
			await expect(
				actions[operation as keyof typeof actions](),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(m.execute).not.toHaveBeenCalled();
			expect(m.caseCreate).not.toHaveBeenCalled();
		},
	);
	it("creates a bounded original source snapshot and audits identifiers without task/check text", async () => {
		await createAgentTestCaseCommand(
			actor,
			{
				instanceId: scope.instanceId,
				name: test.name,
				input: test.input,
				checks,
			},
			m.audit,
		);
		expect(m.caseCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				...actor,
				agentSId: test.agentSId,
				originInstanceId: scope.instanceId,
				sourceScopeJson: scope,
				checksJson: checks,
			}),
		});
		expect(JSON.stringify(m.audit.mock.calls)).not.toContain(test.input);
		expect(m.audit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "org.agent_test_case.created" }),
		);
	});
	it("enforces external key selection ceilings even for an otherwise authorized owner", async () => {
		const policy = vi.fn(() => {
			throw new AgentTestError(
				"FORBIDDEN",
				"Example key lacks source scope",
			);
		});
		await expect(
			createAgentTestCaseCommand(
				{ ...actor, external: true },
				{
					instanceId: scope.instanceId,
					name: test.name,
					input: test.input,
					checks,
				},
				m.audit,
				policy,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.caseCreate).not.toHaveBeenCalled();
	});
	it("rejects stale case updates and archives without auditing success", async () => {
		m.caseUpdate.mockResolvedValue({ count: 0 });
		await expect(
			updateAgentTestCaseCommand(
				actor,
				{
					caseId: test.id,
					revision: 6,
					name: test.name,
					input: test.input,
					checks,
				},
				m.audit,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			archiveAgentTestCaseCommand(
				actor,
				{ caseId: test.id, revision: 6 },
				m.audit,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.audit).not.toHaveBeenCalled();
	});
	it("dispatches through normal external policy once and reconnects retry to the same native run", async () => {
		const external = { ...actor, external: true };
		const first = await startAgentTestRunCommand(
			external,
			request,
			m.audit,
		);
		const again = await startAgentTestRunCommand(
			external,
			request,
			m.audit,
		);
		expect(first.id).toBe(again.id);
		expect(m.execute).toHaveBeenCalledTimes(1);
		expect(m.execute).toHaveBeenCalledWith(
			scope.instanceId,
			expect.objectContaining({
				input: { message: test.input },
				idempotencyKey: `agent-test-${first.id}`,
			}),
			external,
			expect.objectContaining({ requireApiExposure: true }),
		);
		expect(m.runUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: {},
				create: expect.objectContaining({
					caseRevision: 7,
					caseInput: test.input,
					checksJson: checks,
					agentVersion: 1,
				}),
			}),
		);
	});
	it("rejects reuse of one request key for different test input", async () => {
		await startAgentTestRunCommand(actor, request, m.audit);
		await expect(
			startAgentTestRunCommand(
				actor,
				{ ...request, caseRevision: 8 },
				m.audit,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.execute).toHaveBeenCalledTimes(1);
	});
	it("rejects a changed or archived case before any native execution", async () => {
		m.caseFind.mockResolvedValue({ ...test, revision: 8, archivedAt: now });
		await expect(
			startAgentTestRunCommand(actor, request, m.audit),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.execute).not.toHaveBeenCalled();
	});
	it("keeps original case contents across missing native admission acknowledgement and a case edit", async () => {
		m.execute.mockResolvedValueOnce({
			status: 503,
			error: "Example temporarily unavailable",
		});
		await expect(
			startAgentTestRunCommand(actor, request, m.audit),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		m.caseFind.mockResolvedValue({
			...test,
			revision: 8,
			input: "Changed task",
			checksJson: { requiredPhrases: ["Changed"], forbiddenPhrases: [] },
		});
		await startAgentTestRunCommand(actor, request, m.audit);
		expect(m.execute.mock.calls.at(-1)?.[1].input).toEqual({
			message: test.input,
		});
		expect(
			new Set(m.execute.mock.calls.map((call) => call[1].idempotencyKey))
				.size,
		).toBe(1);
		expect([...storedRuns.values()][0]).toMatchObject({
			caseInput: test.input,
			caseRevision: 7,
			checksJson: checks,
		});
	});
	it("never retargets a pending original request to a newer agent version", async () => {
		m.execute.mockResolvedValueOnce({
			status: 503,
			error: "Example temporarily unavailable",
		});
		await expect(
			startAgentTestRunCommand(actor, request, m.audit),
		).rejects.toThrow();
		m.load.mockResolvedValue({
			instance: {
				...target.instance,
				id: "example-agent-v2",
				version: 2,
			},
			scope: { ...scope, instanceId: "example-agent-v2" },
		});
		await startAgentTestRunCommand(actor, request, m.audit);
		expect(m.execute.mock.calls.at(-1)?.[0]).toBe(scope.instanceId);
		expect([...storedRuns.values()][0].agentVersion).toBe(1);
	});
	it("does not expose a retained report after original source permissions are removed", async () => {
		storedRuns.set(run.id, run);
		m.source.mockRejectedValue(
			new AgentTestError("NOT_FOUND", "Example source removed"),
		);
		await expect(
			getAgentTestRunCommand(actor, { testRunId: run.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.runFind).toHaveBeenCalledWith({
			where: { id: run.id, ...actor },
		});
	});
	it("does not expose another actor's or tenant's test row", async () => {
		m.runFind.mockResolvedValue(null);
		await expect(
			getAgentTestRunCommand(actor, { testRunId: run.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.runFind).toHaveBeenCalledWith({
			where: { id: run.id, ...actor },
		});
	});
	it("uses owner/organization/stable-agent and case-bounded pagination", async () => {
		await listAgentTestCasesCommand(actor, {
			instanceId: scope.instanceId,
		});
		expect(m.caseList).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { ...actor, agentSId: test.agentSId, archivedAt: null },
				take: 21,
			}),
		);
		await listAgentTestRunsCommand(actor, { caseId: test.id });
		expect(m.runList).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { ...actor, caseId: test.id },
				take: 21,
			}),
		);
	});
	it("compares only matching immutable case revisions and expectations", async () => {
		storedRuns.set(run.id, run);
		storedRuns.set("example-candidate", {
			...run,
			id: "example-candidate",
			agentVersion: 2,
			caseRevision: 8,
		});
		await expect(
			compareAgentTestRunsCommand(actor, {
				baselineRunId: run.id,
				candidateRunId: "example-candidate",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
	it("compares finalized version results with meaningful latency and cost differences", async () => {
		storedRuns.set(run.id, run);
		storedRuns.set("example-candidate", {
			...run,
			id: "example-candidate",
			agentVersion: 2,
			reportJson: { ...report, durationMs: 15, totalCost: "0.002" },
		});
		const result = await compareAgentTestRunsCommand(actor, {
			baselineRunId: run.id,
			candidateRunId: "example-candidate",
		});
		expect(result.changes).toMatchObject({
			passed: 0,
			total: 1,
			verdictChanged: false,
			durationMsDelta: 5,
			costDelta: "0.001",
		});
	});
	it("cancels native execution through the existing owner-authorized command", async () => {
		storedRuns.set(run.id, {
			...run,
			status: "RUNNING",
			verdict: null,
			reportJson: null,
		});
		await cancelAgentTestRunCommand(actor, { testRunId: run.id }, m.audit);
		expect(m.cancel).toHaveBeenCalledWith(
			actor,
			{ executionId: run.executionId },
			expect.any(Function),
		);
		expect(m.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "org.agent_test.cancel_requested",
			}),
		);
	});
});

it("never returns an unvalidated stored report carrying arbitrary source output", async () => {
	storedRuns.set(run.id, {
		...run,
		reportJson: { ...report, output: "Example private source output" },
	});
	await expect(
		getAgentTestRunCommand(actor, { testRunId: run.id }),
	).rejects.toThrow();
});
it("retains the saved source boundary when saving a completed preview as a test", async () => {
	m.previewSource.mockResolvedValue({
		...scope,
		instanceId: scope.instanceId,
	});
	await createAgentTestCaseCommand(
		actor,
		{
			instanceId: scope.instanceId,
			name: "Example check",
			input: "Return Ready",
			checks,
			sourcePreview: { workflowId: "example-preview" },
		},
		m.audit,
	);
	expect(m.previewSource).toHaveBeenCalledWith(
		actor,
		{ workflowId: "example-preview" },
		undefined,
	);
	expect(m.caseCreate.mock.calls.at(-1)?.[0].data.sourceScopeJson).toEqual(
		scope,
	);
});
it.each(["projectId", "workspaceIds", "skillIds", "workspaceDocumentFilters"])(
	"refuses to copy preview expectations after unsaved %s source changes",
	async (field) => {
		const changed = {
			...scope,
			instanceId: scope.instanceId,
			[field]:
				field === "projectId"
					? "example-different-project"
					: field === "workspaceDocumentFilters"
						? [
								{
									workspaceId: "example-workspace",
									documentIds: ["example-other-document"],
								},
							]
						: ["example-other-source"],
		};
		m.previewSource.mockResolvedValue(changed);
		await expect(
			createAgentTestCaseCommand(
				actor,
				{
					instanceId: scope.instanceId,
					name: "Example check",
					input: "Return Ready",
					checks,
					sourcePreview: { workflowId: "example-preview" },
				},
				m.audit,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.caseCreate).not.toHaveBeenCalled();
	},
);
it("withholds retained reports after the native execution receipt is deleted", async () => {
	storedRuns.set(run.id, { ...run, executionId: null });
	const result = await getAgentTestRunCommand(actor, { testRunId: run.id });
	expect(result.report).toBeNull();
	expect(result.verdict).toBeNull();
});
it("shows an error rather than running forever after the native assessment times out", async () => {
	storedRuns.set(run.id, { ...run, status: "RUNNING", reportJson: null });
	const prior = m.describe.getMockImplementation();
	if (!prior) {
		throw new Error("Expected observer description fixture");
	}
	m.describe.mockImplementation(async () => ({
		...(await prior()),
		status: { name: "TIMED_OUT" },
	}));
	const result = await getAgentTestRunCommand(actor, { testRunId: run.id });
	expect(result).toMatchObject({
		status: "ERROR",
		errorCode: "ASSESSMENT_UNAVAILABLE",
		report: null,
	});
});
it("refuses mismatched observer receipts on active status reads", async () => {
	storedRuns.set(run.id, { ...run, status: "RUNNING", reportJson: null });
	const prior = m.describe.getMockImplementation();
	if (!prior) {
		throw new Error("Expected observer description fixture");
	}
	m.describe.mockImplementation(async () => ({
		...(await prior()),
		runId: "example-other-run",
	}));
	const result = await getAgentTestRunCommand(actor, { testRunId: run.id });
	expect(result).toMatchObject({
		status: "ADMITTING",
		errorCode: "ASSESSMENT_UNCONFIRMED",
		requestKey: request.idempotencyKey,
		report: null,
		verdict: null,
	});
});

it("keeps opaque reconnect identity available after observer start fails before admission", async () => {
	m.start.mockRejectedValue(new Error("Example transport unavailable"));
	m.describe.mockRejectedValue(
		Object.assign(new Error("Missing"), { name: "WorkflowNotFoundError" }),
	);
	await expect(
		startAgentTestRunCommand(actor, request, m.audit),
	).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
	const stored = [...storedRuns.values()][0];
	expect(stored.executionId).toBe("example-execution");
	expect(stored.evaluationRunId).toBeNull();
	const result = await getAgentTestRunCommand(actor, {
		testRunId: stored.id,
	});
	expect(result).toMatchObject({
		status: "ADMITTING",
		requestKey: request.idempotencyKey,
		instanceId: scope.instanceId,
		report: null,
		verdict: null,
	});
	const history = await listAgentTestRunsCommand(actor, { caseId: test.id });
	expect(history.runs[0].requestKey).toBe(request.idempotencyKey);
});
it("recovers the exact completed observer after a lost start acknowledgement", async () => {
	m.start.mockImplementation(async () => {
		const row = [...storedRuns.values()][0];
		storedRuns.set(row.id, {
			...row,
			status: "COMPLETED",
			verdict: "PASSED",
			reportJson: report,
		});
		throw new Error("Example acknowledgement lost");
	});
	const result = await startAgentTestRunCommand(actor, request, m.audit);
	expect(result).toMatchObject({ status: "COMPLETED", verdict: "PASSED" });
	expect(result.report).toEqual(report);
});
it("never lets a delayed identical admission overwrite a completed assessment", async () => {
	const pending: Array<(v: any) => void> = [];
	m.execute.mockImplementation(
		() => new Promise((resolve) => pending.push(resolve)),
	);
	const first = startAgentTestRunCommand(actor, request, m.audit);
	const second = startAgentTestRunCommand(actor, request, m.audit);
	await vi.waitFor(() => expect(pending).toHaveLength(2));
	const receipt = {
		status: 202,
		data: {
			executionId: "example-execution",
			workflowId: "example-native",
			runId: "example-native-run",
		},
	};
	pending[0](receipt);
	const started = await first;
	const row = storedRuns.get(started.id);
	storedRuns.set(started.id, {
		...row,
		status: "COMPLETED",
		verdict: "PASSED",
		reportJson: report,
	});
	pending[1](receipt);
	const recovered = await second;
	expect(recovered).toMatchObject({ status: "COMPLETED", verdict: "PASSED" });
	expect(storedRuns.get(started.id).status).toBe("COMPLETED");
	expect(recovered.report).toEqual(report);
});
it("admits frozen source authority only through server policy, never user task JSON", async () => {
	const result = await startAgentTestRunCommand(actor, request, m.audit);
	expect(m.execute.mock.calls[0][1].input).toEqual({ message: test.input });
	expect(m.execute.mock.calls[0][3].testAuthority).toEqual({
		testRunId: result.id,
		origin: scope,
		execution: scope,
	});
});

it("marks only a locked, proven unreserved stale revision as safe to abandon", async () => {
	m.caseFind.mockResolvedValue({ ...test, revision: 8 });
	await expect(
		startAgentTestRunCommand(actor, request, m.audit),
	).rejects.toMatchObject({
		code: "CONFLICT",
		data: { admission: "NOT_STARTED" },
	});
	expect(m.lock).toHaveBeenCalledTimes(1);
	expect(m.runUpsert).not.toHaveBeenCalled();
	expect(m.execute).not.toHaveBeenCalled();
});

it("refuses score comparisons across legacy and deterministic scorer formats", async () => {
	storedRuns.set(run.id, run);
	storedRuns.set("example-candidate", {
		...run,
		id: "example-candidate",
		agentVersion: 2,
		reportJson: {
			...report,
			version: 2,
			method: "deterministic",
			scorerVersion: "fabric-deterministic-v1",
			status: "PASSED",
			unavailable: 0,
			results: [
				{ kind: "required", index: 0, passed: true, available: true },
			],
		},
	});
	await expect(
		compareAgentTestRunsCommand(actor, {
			baselineRunId: run.id,
			candidateRunId: "example-candidate",
		}),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(m.execute).not.toHaveBeenCalled();
});
