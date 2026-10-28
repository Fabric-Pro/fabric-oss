import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	limit: vi.fn(),
	describe: vi.fn(),
	cancel: vi.fn(),
	query: vi.fn(),
	update: vi.fn(),
	signal: vi.fn(),
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
	getConversationTurnOwnerForExecution: async () => null,
	getConversationTurnForExecution: async () => null,
	requestConversationTurnCancel: vi.fn(),
	db: { member: { findFirst: mocks.member } },
	hasProjectAccess: mocks.project,
	hasOrganizationTie: async () => true,
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: { getHandle: mocks.handle } }),
}));

import { getAuthorizedChatRun } from "@saas/agents/lib/server/chat-run-control";
import { POST as approve } from "../../../orchestrator-temporal/approve/route";
import { POST as cancelOrchestrator } from "../../../orchestrator-temporal/cancel/route";

import { POST as clarify } from "../../../orchestrator-temporal/clarify/route";
import { POST as followUp } from "../../../orchestrator-temporal/follow-up/route";
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
	approvalProtocol: 2,
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
		session: { id: "session-1", activeOrganizationId: "example-org" },
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
		signal: mocks.signal,
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
			memo: {
				userId: memo.userId,
				organizationId: memo.organizationId,
				approvalProtocol: 2,
			},
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
			memo: {
				userId: memo.userId,
				organizationId: memo.organizationId,
				approvalProtocol: 2,
			},
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
	it("requires organization membership as staging did", async () => {
		mocks.describe.mockResolvedValue({
			memo: { ...memo, projectId: "project-1" },
			runId: "run-1",
			type: "orchestratorExecutionWorkflow",
			status: { name: "RUNNING" },
		});
		mocks.member.mockResolvedValue(null);
		expect((await run()).status).toBe(403);
		expect(mocks.update).not.toHaveBeenCalled();
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
	it("rejects missing bound metadata for protocol-2 workflows", async () => {
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
	it("permits viewer approvals as staging did", async () => {
		mocks.member.mockResolvedValue({ id: "member-1", role: "viewer" });
		expect((await run()).status).toBe(200);
		expect(mocks.update).toHaveBeenCalledOnce();
	});
	it("allows a project viewer with live access", async () => {
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
		expect((await run()).status).toBe(200);
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

it.each([undefined, "true"])(
	"legacy approvals ignore switch %s and bound query metadata",
	async (flag) => {
		vi.stubEnv("ORCHESTRATOR_APPROVAL_UPDATES_ENABLED", flag);
		mocks.describe.mockResolvedValue({
			memo: { userId: memo.userId, organizationId: memo.organizationId },
			type: "orchestratorExecutionWorkflow",
			runId: "run-1",
			status: { name: "RUNNING" },
		});
		mocks.query.mockImplementation(async (name) => {
			if (name === "chatRunContext") {
				throw new Error("must not query new handler");
			}
			return pending;
		});
		const response = await approve(
			request({
				executionId: `orch-${uuid}`,
				approvalId: pending.approvalId,
				approved: true,
			}),
		);
		expect(response.status).toBe(200);
		expect(mocks.signal).toHaveBeenCalledWith(
			"approval",
			expect.objectContaining({
				approvalId: pending.approvalId,
				approved: true,
			}),
		);
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.query).not.toHaveBeenCalledWith("chatRunContext");
		vi.unstubAllEnvs();
	},
);
it.each(["direct", "orchestrator"] as const)(
	"cancels legacy %s without querying new handlers",
	async (engine) => {
		mocks.describe.mockResolvedValue({
			memo: { userId: memo.userId, organizationId: memo.organizationId },
			type:
				engine === "direct"
					? "directChatWorkflow"
					: "orchestratorExecutionWorkflow",
			runId: "run-1",
			status: { name: "RUNNING" },
		});
		mocks.query.mockRejectedValue(new Error("must not query"));
		const response = await (engine === "direct"
			? cancelDirect
			: cancelOrchestrator)(
			request({
				executionId: `${engine === "direct" ? "direct-chat" : "orch"}-${uuid}`,
			}),
		);
		expect(response.status).toBe(200);
		expect(mocks.query).not.toHaveBeenCalled();
		expect(mocks.cancel).toHaveBeenCalledOnce();
	},
);
it("does not fall back when a protocol-2 Update fails", async () => {
	mocks.describe.mockResolvedValue({
		memo,
		type: "orchestratorExecutionWorkflow",
		runId: "run-1",
		status: { name: "RUNNING" },
	});
	mocks.update.mockRejectedValue(
		new Error("No registered handler for update: decideApproval"),
	);
	expect(
		(
			await approve(
				request({
					executionId: `orch-${uuid}`,
					approvalId: pending.approvalId,
					approved: true,
				}),
			)
		).status,
	).toBe(503);
	expect(mocks.signal).not.toHaveBeenCalled();
});

it.each([
	["clarify", clarify, { answer: "Example" }],
	["follow-up", followUp, { message: "Example" }],
] as const)(
	"legacy %s uses only staging handlers",
	async (_name, post, body) => {
		mocks.describe.mockResolvedValue({
			memo: { userId: memo.userId, organizationId: memo.organizationId },
			type: "orchestratorExecutionWorkflow",
			runId: "run-1",
			status: { name: "RUNNING" },
		});
		const response = await post(
			request({ executionId: `orch-${uuid}`, ...body }),
		);
		expect(response.status).toBe(200);
		expect(mocks.query).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	},
);
it("legacy status reads use the organization tie without querying new handlers", async () => {
	mocks.describe.mockResolvedValue({
		memo: { userId: memo.userId, organizationId: memo.organizationId },
		type: "orchestratorExecutionWorkflow",
		runId: "run-1",
		status: { name: "RUNNING" },
	});
	mocks.member.mockResolvedValue(null);
	mocks.query.mockResolvedValue(null);
	await getAuthorizedChatRun({
		executionId: `orch-${uuid}`,
		userId: memo.userId,
		engine: "orchestrator",
		action: "observe",
	});
	expect(mocks.query).not.toHaveBeenCalledWith("chatRunContext");
});
it.each(["observe", "reattach", "approve", "cancel"] as const)(
	"legacy authorization for %s does not query workflow context",
	async (action) => {
		mocks.describe.mockResolvedValue({
			memo: { userId: memo.userId, organizationId: memo.organizationId },
			type: "orchestratorExecutionWorkflow",
			runId: "run-1",
			status: { name: "RUNNING" },
		});
		await getAuthorizedChatRun({
			executionId: `orch-${uuid}`,
			userId: memo.userId,
			engine: "orchestrator",
			action,
		});
		expect(mocks.query).not.toHaveBeenCalled();
	},
);
