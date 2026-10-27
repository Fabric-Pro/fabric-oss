import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	limit: vi.fn(),
	describe: vi.fn(),
	cancel: vi.fn(),
	query: vi.fn(),
	update: vi.fn(),
	handle: vi.fn(),
	member: vi.fn(),
	project: vi.fn(),
	permission: vi.fn(),
	audit: vi.fn(),
}));
vi.mock("@saas/auth/lib/server", () => ({ getSession: mocks.session }));
vi.mock("@repo/api/lib/rate-limit", () => ({ checkRateLimit: mocks.limit }));
vi.mock("@repo/api/lib/audit", () => ({ recordAuditFromRequest: mocks.audit }));
vi.mock("@repo/api/lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: mocks.permission,
}));
vi.mock("@repo/database", () => ({
	db: { member: { findFirst: mocks.member } },
	hasProjectAccess: mocks.project,
	hasOrganizationTie: async () => false,
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: { getHandle: mocks.handle } }),
}));

import { POST as approve } from "../../../orchestrator-temporal/approve/route";
import { POST as cancelOrchestrator } from "../../../orchestrator-temporal/cancel/route";
import { POST as cancelDirect } from "../route";

const uuid = "550e8400-e29b-41d4-a716-446655440000";
function request(body: unknown) {
	return new Request("https://example.com/api/control", {
		method: "POST",
		body: JSON.stringify(body),
	});
}
const memo = {
	userId: "example-user",
	organizationId: "example-org",
	projectId: null,
};
const pending = {
	approvalId: "approval-1",
	requestId: "request-1",
	runId: "run-1",
	expiresAt: 9999999999999,
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.session.mockResolvedValue({
		user: { id: memo.userId, email: "dev@example.com" },
		session: { id: "session-1" },
	});
	mocks.limit.mockResolvedValue({ allowed: true, resetInSeconds: 42 });
	mocks.member.mockResolvedValue({ id: "member-1", role: "owner" });
	mocks.project.mockResolvedValue(true);
	mocks.permission.mockResolvedValue({
		organizationId: memo.organizationId,
		permissions: ["agent:execute"],
	});
	mocks.handle.mockReturnValue({
		describe: mocks.describe,
		cancel: mocks.cancel,
		query: mocks.query,
		executeUpdate: mocks.update,
	});
	mocks.query.mockResolvedValue(pending);
	mocks.update.mockResolvedValue({
		accepted: true,
		approvalId: pending.approvalId,
		approved: true,
	});
});

for (const control of [
	{
		name: "direct cancel",
		post: cancelDirect,
		executionId: `direct-chat-${uuid}`,
		type: "directChatWorkflow",
		body: {},
	},
	{
		name: "orchestrator cancel",
		post: cancelOrchestrator,
		executionId: `orch-${uuid}`,
		type: "orchestratorExecutionWorkflow",
		body: {},
	},
	{
		name: "orchestrator approval",
		post: approve,
		executionId: `orch-${uuid}`,
		type: "orchestratorExecutionWorkflow",
		body: { approvalId: pending.approvalId, approved: true },
	},
]) {
	describe(control.name, () => {
		const description = {
			memo,
			runId: "run-1",
			type: control.type,
			status: { name: "RUNNING" },
		};
		const run = (extra = {}) =>
			control.post(
				request({
					executionId: control.executionId,
					...control.body,
					...extra,
				}),
			);
		beforeEach(() => {
			mocks.describe.mockResolvedValue(description);
		});
		it("requires authentication", async () => {
			mocks.session.mockResolvedValue(null);
			expect((await run()).status).toBe(401);
			expect(mocks.handle).not.toHaveBeenCalled();
		});
		it("rate limits mutations", async () => {
			mocks.limit.mockResolvedValue({
				allowed: false,
				resetInSeconds: 42,
			});
			const response = await run();
			expect(response.status).toBe(429);
			expect(response.headers.get("Retry-After")).toBe("42");
			expect(mocks.handle).not.toHaveBeenCalled();
		});
		it.each([
			null,
			{},
			{ userId: memo.userId },
			{ ...memo, userId: "another-user" },
			{ ...memo, organizationId: "" },
		])("fails closed for ownership metadata %j", async (value) => {
			mocks.describe.mockResolvedValue({ ...description, memo: value });
			expect((await run()).status).toBe(403);
			expect(mocks.cancel).not.toHaveBeenCalled();
			expect(mocks.update).not.toHaveBeenCalled();
		});
		it("rejects removed membership", async () => {
			mocks.member.mockResolvedValue(null);
			expect((await run()).status).toBe(403);
		});
		it("rejects removed project access", async () => {
			mocks.describe.mockResolvedValue({
				...description,
				memo: { ...memo, projectId: "project-1" },
			});
			mocks.project.mockResolvedValue(false);
			expect((await run()).status).toBe(403);
			expect(mocks.project).toHaveBeenCalledWith(
				"project-1",
				memo.userId,
				memo.organizationId,
			);
		});
		it("rejects the wrong workflow type", async () => {
			mocks.describe.mockResolvedValue({
				...description,
				type: "anotherWorkflow",
			});
			expect((await run()).status).toBe(403);
		});
		it.each([123, "orch-bad", `orch-${"-".repeat(36)}`])(
			"rejects invalid execution id %s",
			async (executionId) => {
				expect((await run({ executionId })).status).toBe(400);
				expect(mocks.handle).not.toHaveBeenCalled();
			},
		);
		it("does not mistake service failures for a completed command", async () => {
			mocks.describe.mockRejectedValue(
				new Error("private-provider-detail"),
			);
			const response = await run();
			expect(response.status).toBe(503);
			expect(await response.text()).not.toContain(
				"private-provider-detail",
			);
			expect(mocks.audit).not.toHaveBeenCalled();
		});
		it("pins the authorized run and emits a content-free audit event", async () => {
			expect((await run()).status).toBe(200);
			expect(mocks.handle).toHaveBeenLastCalledWith(
				control.executionId,
				"run-1",
			);
			expect(mocks.audit).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					organizationId: memo.organizationId,
					resource: { type: "chat_run", id: control.executionId },
				}),
			);
		});
	});
}

describe("approval acknowledgements", () => {
	beforeEach(() => {
		mocks.describe.mockResolvedValue({
			memo,
			runId: "run-1",
			type: "orchestratorExecutionWorkflow",
			status: { name: "RUNNING" },
		});
	});
	const run = (extra = {}) =>
		approve(
			request({
				executionId: `orch-${uuid}`,
				approvalId: pending.approvalId,
				approved: true,
				...extra,
			}),
		);
	it("recovers legacy project provenance and rejects revoked access", async () => {
		mocks.describe.mockResolvedValue({
			memo: { userId: memo.userId, organizationId: memo.organizationId },
			runId: "run-1",
			type: "orchestratorExecutionWorkflow",
			status: { name: "RUNNING" },
		});
		mocks.query.mockImplementation(async (name) =>
			name === "chatRunContext"
				? { ...memo, projectId: "project-1" }
				: pending,
		);
		mocks.project.mockResolvedValue(false);
		expect((await run()).status).toBe(403);
		expect(mocks.project).toHaveBeenCalledWith(
			"project-1",
			memo.userId,
			memo.organizationId,
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it("rejects legacy context that cannot prove project provenance", async () => {
		mocks.describe.mockResolvedValue({
			memo: { userId: memo.userId, organizationId: memo.organizationId },
			runId: "run-1",
			type: "orchestratorExecutionWorkflow",
			status: { name: "RUNNING" },
		});
		mocks.query.mockResolvedValue({
			userId: memo.userId,
			organizationId: memo.organizationId,
		});
		expect((await run()).status).toBe(403);
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it("honors an invited project's execution permission without organization membership", async () => {
		mocks.describe.mockResolvedValue({
			memo: { ...memo, projectId: "project-1" },
			runId: "run-1",
			type: "orchestratorExecutionWorkflow",
			status: { name: "RUNNING" },
		});
		mocks.member.mockResolvedValue(null);
		expect((await run()).status).toBe(200);
		expect(mocks.update).toHaveBeenCalledOnce();
	});
	it("denies a project that belongs to a different tenant", async () => {
		mocks.describe.mockResolvedValue({
			memo: { ...memo, projectId: "project-1" },
			runId: "run-1",
			type: "orchestratorExecutionWorkflow",
			status: { name: "RUNNING" },
		});
		mocks.permission.mockResolvedValue({
			organizationId: "other-org",
			permissions: ["agent:execute"],
		});
		expect((await run()).status).toBe(403);
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it("requires the displayed checkpoint id", async () => {
		expect((await run({ approvalId: undefined })).status).toBe(400);
	});
	it("rejects stale cards before mutation", async () => {
		expect((await run({ approvalId: "previous-approval" })).status).toBe(
			409,
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it("fails closed for legacy workflows without bound approvals", async () => {
		mocks.query.mockResolvedValue({ approvalId: pending.approvalId });
		expect((await run()).status).toBe(409);
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it.each([false, 0, null, "x".repeat(10001)])(
		"validates feedback %j",
		async (feedback) => {
			expect((await run({ feedback })).status).toBe(400);
		},
	);
	it.each(["expired", "stale", "decided"])(
		"rejects %s decisions atomically",
		async (reason) => {
			mocks.update.mockResolvedValue({ accepted: false, reason });
			expect((await run()).status).toBe(409);
			expect(mocks.audit).not.toHaveBeenCalled();
		},
	);
	it("does not report an ambiguous update as accepted", async () => {
		mocks.update.mockRejectedValue(new Error("timeout"));
		expect((await run()).status).toBe(503);
	});
	it("checks current execution permission", async () => {
		mocks.member.mockResolvedValue({ id: "member-1", role: "viewer" });
		expect((await run()).status).toBe(403);
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it("checks project execution permission independently of read access", async () => {
		mocks.describe.mockResolvedValue({
			memo: { ...memo, projectId: "project-1" },
			runId: "run-1",
			type: "orchestratorExecutionWorkflow",
			status: { name: "RUNNING" },
		});
		mocks.permission.mockResolvedValue({
			organizationId: memo.organizationId,
			permissions: [],
		});
		expect((await run()).status).toBe(403);
	});
	it("sends server-resolved identity and exact pending request", async () => {
		await run({
			decidedBy: "attacker",
			organizationId: "other-org",
			requestId: "other-request",
		});
		expect(mocks.update).toHaveBeenCalledWith("decideApproval", {
			args: [
				{
					...pending,
					expiresAt: undefined,
					organizationId: memo.organizationId,
					decidedBy: memo.userId,
					approved: true,
					feedback: undefined,
				},
			],
		});
	});
});
