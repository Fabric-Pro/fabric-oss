import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	handler: null as any,
	schema: null as any,
	rows: new Map<string, any>(),
	workflows: new Map<string, any>(),
	start: vi.fn(),
	create: vi.fn(),
	upsert: vi.fn(),
	client: vi.fn(),
	stamp: vi.fn(),
	session: vi.fn(),
	finalizeSession: vi.fn(),
	sessions: new Map<string, any>(),
	lockTail: Promise.resolve(),
}));
vi.mock("@repo/database", () => ({
	db: {
		$transaction: async (run: (tx: any) => Promise<unknown>) => {
			let release: (() => void) | undefined;
			const tx = {
				$queryRaw: async () => {
					const previous = h.lockTail;
					h.lockTail = new Promise<void>((resolve) => {
						release = resolve;
					});
					await previous;
					return [{ id: "example-proposal" }];
				},
				backlogUpdateSession: {
					findFirst: async ({ where }: any) =>
						h.sessions.get(where.pendingProposalId) ?? null,
				},
			};
			try {
				return await run(tx);
			} finally {
				release?.();
			}
		},
		project: {
			findUnique: async ({ where }: any) => ({
				id: where.id,
				organizationId: "example-org",
			}),
		},
		pendingBacklogProposal: {
			findUnique: async ({ where }: any) => h.rows.get(where.id) ?? null,
			upsert: (...args: any[]) => h.upsert(...args),
			update: async ({ where, data }: any) =>
				Object.assign(h.rows.get(where.id), data),
		},
	},
	createPendingBacklogProposal: (...args: any[]) => h.create(...args),
	createBacklogUpdateSession: (...args: any[]) => h.session(...args),
	finalizeBacklogUpdateSession: (...args: any[]) =>
		h.finalizeSession(...args),
	markProposalApplyDispatched: (...args: any[]) => h.stamp(...args),
	claimPendingProposalForApply: vi.fn(),
	finalizeClaimedProposal: vi.fn(),
	getAppliedChangeIndexes: vi.fn(),
	getBoundPromptForAgent: vi.fn(),
	getPendingBacklogProposal: vi.fn(),
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: () => h.client(),
	runDecisionPrecheck: async () => ({ status: "ok", findings: [] }),
}));
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (v: any) => v,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const builder: any = {
		use: () => builder,
		route: () => builder,
		input: (schema: any) => {
			h.schema = schema;
			return builder;
		},
		output: () => builder,
		handler: (fn: any) => {
			h.handler = fn;
			return builder;
		},
	};
	return {
		tenantProtectedProcedure: builder,
		Permissions: { PROJECT_UPDATE: "project:update" },
		requireProjectPermission: () => (c: any) => c,
		resolveOrganizationId: () => "example-org",
	};
});
await import("../apply-changes");
const input = {
	projectId: "example-project",
	operationKey: "example-approval",
	approvedChanges: [
		{
			type: "feature",
			action: "create",
			title: { to: "Example feature" },
			reasoning: "Requested",
			sourceContext: "teams_messages",
		},
	],
	syncToPM: false,
};
const call = (overrides = {}, userId = "example-user") =>
	h.handler({
		input: h.schema.parse({ ...input, ...overrides }),
		context: { user: { id: userId }, session: {} },
	});
beforeEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	h.rows.clear();
	h.workflows.clear();
	h.sessions.clear();
	h.lockTail = Promise.resolve();
	h.session.mockImplementation(async (data: any) => {
		const row = {
			...data,
			id: `example-session-${h.session.mock.calls.length}`,
		};
		h.sessions.set(data.pendingProposalId, row);
		return row;
	});
	let now = 1000;
	vi.spyOn(Date, "now").mockImplementation(() => ++now);
	h.create.mockImplementation(async (data: any) => {
		const row = { ...data, id: `legacy-${h.rows.size}`, status: "PENDING" };
		h.rows.set(row.id, row);
		return row;
	});
	h.upsert.mockImplementation(async ({ where, create }: any) => {
		if (!h.rows.has(where.id)) {
			h.rows.set(where.id, { ...create, status: "PENDING" });
		}
		return h.rows.get(where.id);
	});
	h.start.mockImplementation(async (_type: any, options: any) => {
		if (h.workflows.has(options.workflowId)) {
			throw Object.assign(new Error("duplicate"), {
				name: "WorkflowExecutionAlreadyStartedError",
			});
		}
		const row = {
			workflowId: options.workflowId,
			runId: `run-${h.workflows.size}`,
			memo: options.memo,
		};
		h.workflows.set(row.workflowId, row);
		return { workflowId: row.workflowId, firstExecutionRunId: row.runId };
	});
	h.stamp.mockImplementation(async ({ proposalId, applyWorkflowId }: any) => {
		const row = h.rows.get(proposalId);
		if (row.status !== "PENDING" || row.applyWorkflowId) {
			return 0;
		}
		Object.assign(row, { applyWorkflowId, applyStartedAt: new Date() });
		return 1;
	});
	h.client.mockResolvedValue({
		workflow: {
			start: h.start,
			getHandle: (id: string) => ({
				describe: async () => {
					if (!h.workflows.has(id)) {
						throw Object.assign(new Error("missing"), {
							name: "WorkflowNotFoundError",
						});
					}
					return h.workflows.get(id);
				},
			}),
		},
	});
});
describe("apply operation identity", () => {
	it("returns one durable row and workflow on duplicate delivery", async () => {
		const first = await call();
		const second = await call();
		expect(second).toMatchObject({
			proposalId: first.proposalId,
			workflowId: first.workflowId,
			runId: first.runId,
		});
		expect(h.rows.size).toBe(1);
		expect(h.start).toHaveBeenCalledTimes(1);
	});
	it("recovers a lost workflow-start response without another row or workflow", async () => {
		const start = h.start.getMockImplementation();
		if (!start) {
			throw new Error("Missing workflow start fixture");
		}
		h.start.mockImplementationOnce(async (...args) => {
			await start(...args);
			throw new Error("Response lost");
		});
		// The API may reconcile immediately or return an ambiguous error; the next delivery must converge.
		await call().catch(() => {});
		const result = await call();
		expect(h.rows.size).toBe(1);
		expect(h.workflows.size).toBe(1);
		expect(result.proposalId).toBe([...h.rows.keys()][0]);
		expect(h.start).toHaveBeenCalledTimes(1);
		expect(h.rows.get(result.proposalId).applyWorkflowId).toBe(
			result.workflowId,
		);
	});
	it("resumes the written row when the process dies before workflow start", async () => {
		h.client.mockRejectedValueOnce(new Error("Process died before start"));
		await expect(call()).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
		});
		const id = [...h.rows.keys()][0];
		const result = await call();
		expect(result.proposalId).toBe(id);
		expect(h.rows.size).toBe(1);
		expect(h.workflows.size).toBe(1);
	});
	it("creates one history row when a failed dispatch is retried", async () => {
		h.start.mockRejectedValueOnce(new Error("Start unavailable"));
		await expect(call()).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
		});
		await call();
		expect(h.session).toHaveBeenCalledTimes(1);
		expect(h.session.mock.calls[0][0].pendingProposalId).toBe(
			[...h.rows.keys()][0],
		);
	});
	it("creates one history row for concurrent deliveries and keeps keyless history separate", async () => {
		await Promise.all([call(), call()]);
		expect(h.session).toHaveBeenCalledTimes(1);
		await call({ operationKey: undefined });
		await call({ operationKey: undefined });
		expect(h.session).toHaveBeenCalledTimes(3);
	});

	it.each([
		{
			approvedChanges: [
				{ ...input.approvedChanges[0], title: { to: "Other feature" } },
			],
		},
		{ approvedChanges: [] },
		{ syncToPM: true },
		{
			pmConfig: {
				mcpConfigId: "example-pm",
				containerId: "example-container",
			},
		},
		{ pmSyncOverrides: { "0": { pushAnyway: true } } },
		{ conversationId: "example-other-conversation" },
	])("rejects key reuse with changed inputs %j", async (changed) => {
		await call();
		await expect(call(changed)).rejects.toMatchObject({ code: "CONFLICT" });
		expect(h.rows.size).toBe(1);
		expect(h.workflows.size).toBe(1);
	});
	it.each(["project", "user"])(
		"scopes the operation to its authorized %s",
		async (scope) => {
			const first = await call();
			const other = await call(
				scope === "project"
					? { projectId: "example-other-project" }
					: {},
				scope === "user" ? "example-other-user" : "example-user",
			);
			expect(other.proposalId).not.toBe(first.proposalId);
			expect(other.workflowId).not.toBe(first.workflowId);
			expect(await call()).toMatchObject({
				proposalId: first.proposalId,
				workflowId: first.workflowId,
			});
			expect(h.rows.size).toBe(2);
			expect(h.workflows.size).toBe(2);
		},
	);
	it("does not restart a dispatched operation after workflow history expires", async () => {
		const first = await call();
		h.workflows.clear();
		const second = await call();
		expect(second).toMatchObject({
			proposalId: first.proposalId,
			workflowId: first.workflowId,
		});
		expect(h.start).toHaveBeenCalledTimes(1);
		expect(h.rows.size).toBe(1);
	});
	it("collapses concurrent deliveries at the database primary key and Temporal id", async () => {
		const results = await Promise.all([call(), call()]);
		expect(results[0]).toMatchObject({
			proposalId: results[1].proposalId,
			workflowId: results[1].workflowId,
		});
		expect(h.rows.size).toBe(1);
		expect(h.workflows.size).toBe(1);
		expect(h.start.mock.calls[0][1].workflowIdReusePolicy).toBe(
			"REJECT_DUPLICATE",
		);
	});
	it("reconciles a unique-key race from an emulated database upsert", async () => {
		const upsert = h.upsert.getMockImplementation();
		if (!upsert) {
			throw new Error("Missing row fixture");
		}
		h.upsert.mockImplementation(async (options) => {
			if (h.rows.has(options.where.id)) {
				throw Object.assign(new Error("Unique id"), { code: "P2002" });
			}
			return upsert(options);
		});
		const results = await Promise.all([call(), call()]);
		expect(results[0]).toMatchObject({
			proposalId: results[1].proposalId,
			workflowId: results[1].workflowId,
		});
		expect(h.rows.size).toBe(1);
		expect(h.workflows.size).toBe(1);
	});

	it("rejects concurrent conflicting approvals before a second workflow", async () => {
		const results = await Promise.allSettled([
			call(),
			call({ syncToPM: true }),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(results.find((r) => r.status === "rejected")).toMatchObject({
			reason: { code: "CONFLICT" },
		});
		expect(h.rows.size).toBe(1);
		expect(h.workflows.size).toBe(1);
	});
	it("keeps keyless writes separate while keyed redelivery remains one operation", async () => {
		vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(101);
		const first = await call({ operationKey: undefined });
		const second = await call({ operationKey: undefined });
		expect(second.proposalId).not.toBe(first.proposalId);
		expect(second.workflowId).not.toBe(first.workflowId);
		expect(h.upsert).not.toHaveBeenCalled();
		const keyed = await call();
		expect(await call()).toMatchObject({ proposalId: keyed.proposalId });
		expect(h.rows.size).toBe(3);
		vi.restoreAllMocks();
	});
});
