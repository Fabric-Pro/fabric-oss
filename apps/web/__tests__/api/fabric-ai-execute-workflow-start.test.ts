/**
 * The chat-confirmed workflow start (`/api/agents/fabric-ai/execute-workflow`)
 * is a thin adapter over `startWorkflowExecutionCommand`: it authenticates the
 * caller (a browser session, or an agent service acting for a user in a
 * confirmed project), resolves the organization, and maps the command's answer
 * to a response. Who may start what, the status rule, the graph check, the
 * in-flight cap and what each outcome of the engine start means are the
 * command's, pinned by its own tests; what is pinned here is what the route
 * hands the command and how it answers.
 *
 * A start that did not reach the engine is a failure, never a "queued" success,
 * and an unconfirmed start is answered with 202 rather than a retryable 5xx.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	checkRateLimit: vi.fn(),
	hasOrganizationTie: vi.fn(),
	startWorkflowExecutionCommand: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: mocks.getSession,
}));
vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: mocks.checkRateLimit,
	RATE_LIMIT_PRESETS: { workflow: { limit: 30, windowMs: 60_000 } },
}));
vi.mock("@repo/database", () => ({
	// The organization resolver checks the caller's tie before the command
	// asks the permission question; this suite is about starting, so the
	// caller is always tied.
	hasOrganizationTie: mocks.hasOrganizationTie,
}));
vi.mock("@repo/api/modules/workflows/lib/workflow-execution-commands", () => ({
	startWorkflowExecutionCommand: mocks.startWorkflowExecutionCommand,
}));
vi.mock("@repo/api/modules/workflows/lib/workflow-command-context", () => {
	class WorkflowCommandError extends Error {
		constructor(
			readonly code: string,
			message: string,
		) {
			super(message);
		}
	}
	return { WorkflowCommandError };
});

import { WorkflowCommandError } from "@repo/api/modules/workflows/lib/workflow-command-context";
import { POST } from "@/app/api/agents/fabric-ai/execute-workflow/route";

function request(body: unknown, serviceToken?: string) {
	return new NextRequest(
		"http://localhost/api/agents/fabric-ai/execute-workflow",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(serviceToken
					? { "X-Agent-Service-Token": serviceToken }
					: {}),
			},
			body: JSON.stringify(body),
		},
	);
}

const SERVICE_BODY = {
	workflowId: "wf-1",
	serviceUserId: "user-1",
	organizationId: "org-1",
	projectId: "project",
};

const started = {
	status: "started",
	execution: { id: "exec-1" },
	temporalWorkflowId: "workflow-execution-exec-1",
	workflowName: "Nightly digest",
} as const;

describe("POST /api/agents/fabric-ai/execute-workflow", () => {
	afterEach(() => vi.unstubAllEnvs());
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("AGENT_SERVICE_SECRET", "synthetic-service-token");
		mocks.getSession.mockResolvedValue({
			user: { id: "user-1" },
			session: { activeOrganizationId: "org-1" },
		});
		mocks.checkRateLimit.mockResolvedValue({ allowed: true });
		mocks.hasOrganizationTie.mockResolvedValue(true);
		mocks.startWorkflowExecutionCommand.mockResolvedValue(started);
	});

	describe("who is asking", () => {
		it("rejects an untrusted service actor before resolving any user or workflow", async () => {
			const res = await POST(
				request(
					{ workflowId: "wf-1", serviceUserId: "other" },
					"wrong",
				),
			);

			expect(res.status).toBe(401);
			expect(mocks.getSession).not.toHaveBeenCalled();
			expect(mocks.startWorkflowExecutionCommand).not.toHaveBeenCalled();
		});

		it("rejects a browser request with no session", async () => {
			mocks.getSession.mockResolvedValue(null);

			const res = await POST(request({ workflowId: "wf-1" }));

			expect(res.status).toBe(401);
			expect(mocks.startWorkflowExecutionCommand).not.toHaveBeenCalled();
		});

		it("keeps browser requests bound to their session even if they supply a service actor", async () => {
			await POST(request({ workflowId: "wf-1", serviceUserId: "other" }));

			expect(mocks.startWorkflowExecutionCommand).toHaveBeenCalledWith(
				{ userId: "user-1", organizationId: "org-1" },
				expect.objectContaining({
					workflowId: "wf-1",
					confirmedProjectId: undefined,
				}),
			);
		});

		it("refuses a service request that names no project or actor", async () => {
			const res = await POST(
				request({ workflowId: "wf-1" }, "synthetic-service-token"),
			);

			expect(res.status).toBe(400);
			expect(mocks.startWorkflowExecutionCommand).not.toHaveBeenCalled();
		});

		it("is rate limited per user before any work", async () => {
			mocks.checkRateLimit.mockResolvedValue({
				allowed: false,
				resetInSeconds: 30,
			});

			const res = await POST(request({ workflowId: "wf-1" }));

			expect(res.status).toBe(429);
			expect(mocks.startWorkflowExecutionCommand).not.toHaveBeenCalled();
		});
	});

	describe("what the command is asked", () => {
		it("starts a published workflow on the actor's behalf, recorded as the chat's confirmation", async () => {
			await POST(request({ workflowId: "wf-1" }));

			expect(
				mocks.startWorkflowExecutionCommand,
			).toHaveBeenCalledExactlyOnceWith(
				{ userId: "user-1", organizationId: "org-1" },
				{
					workflowId: "wf-1",
					requirePublished: true,
					source: "fabric-ai-chat-confirmed",
					confirmedProjectId: undefined,
				},
			);
		});

		it("confirms an agent service's start in the project it is working in", async () => {
			const res = await POST(
				request(SERVICE_BODY, "synthetic-service-token"),
			);

			expect(res.status).toBe(200);
			expect(mocks.getSession).not.toHaveBeenCalled();
			expect(mocks.startWorkflowExecutionCommand).toHaveBeenCalledWith(
				{ userId: "user-1", organizationId: "org-1" },
				expect.objectContaining({
					workflowId: "wf-1",
					confirmedProjectId: "project",
				}),
			);
		});
	});

	describe("a refusal from the command", () => {
		it.each([
			["FORBIDDEN", 403],
			["NOT_FOUND", 404],
			["BAD_REQUEST", 400],
			["CONFLICT", 409],
			["INTERNAL_SERVER_ERROR", 500],
		])(
			"answers %s with %i and the command's message",
			async (code, status) => {
				mocks.startWorkflowExecutionCommand.mockRejectedValue(
					new WorkflowCommandError(code, "Refused for a reason"),
				);

				const res = await POST(request({ workflowId: "wf-1" }));

				expect(res.status).toBe(status);
				expect(await res.json()).toEqual({
					error: "Refused for a reason",
				});
			},
		);

		it("answers a full tenant with 429 and the limit code", async () => {
			mocks.startWorkflowExecutionCommand.mockRejectedValue(
				new WorkflowCommandError("TOO_MANY_REQUESTS", "At the limit"),
			);

			const res = await POST(request({ workflowId: "wf-1" }));

			expect(res.status).toBe(429);
			expect(await res.json()).toEqual({
				error: "At the limit",
				code: "EXECUTION_LIMIT_REACHED",
			});
		});

		it("does not turn an unexpected error into a refusal", async () => {
			mocks.startWorkflowExecutionCommand.mockRejectedValue(
				new Error("connection reset"),
			);

			const res = await POST(request({ workflowId: "wf-1" }));

			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({ error: "connection reset" });
		});
	});

	describe("the outcome of the start", () => {
		it("reports a started run with the execution and the workflow id the cancel path uses", async () => {
			const res = await POST(request({ workflowId: "wf-1" }));

			expect(res.status).toBe(200);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body).toMatchObject({
				success: true,
				executionId: "exec-1",
				workflowName: "Nightly digest",
				temporalWorkflowId: "workflow-execution-exec-1",
			});
			expect(body.message).toContain("exec-1");
			expect(body.message).not.toContain("queued");
		});

		it("answers 202 unconfirmed with the execution id, not a retryable 5xx", async () => {
			mocks.startWorkflowExecutionCommand.mockResolvedValue({
				status: "unconfirmed",
				execution: { id: "exec-1" },
				temporalWorkflowId: "workflow-execution-exec-1",
				workflowName: "Nightly digest",
				message: "The engine did not confirm execution exec-1.",
			});

			const res = await POST(request({ workflowId: "wf-1" }));

			expect(res.status).toBe(202);
			expect(await res.json()).toMatchObject({
				success: true,
				status: "unconfirmed",
				executionId: "exec-1",
				message: "The engine did not confirm execution exec-1.",
			});
		});

		it("reports 503, not a queued success, when the engine was never reached", async () => {
			mocks.startWorkflowExecutionCommand.mockResolvedValue({
				status: "failed",
				failure: "engine-unavailable",
				execution: { id: "exec-1" },
				temporalWorkflowId: null,
				workflowName: "Nightly digest",
				message:
					"Workflow engine unavailable — the run was not started.",
			});

			const res = await POST(request({ workflowId: "wf-1" }));

			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({
				error: "Workflow engine unavailable — the run was not started.",
				code: "EXECUTION_NOT_STARTED",
				executionId: "exec-1",
			});
		});

		it("reports 502 when the engine refused the start", async () => {
			mocks.startWorkflowExecutionCommand.mockResolvedValue({
				status: "failed",
				failure: "start-rejected",
				execution: { id: "exec-1" },
				temporalWorkflowId: null,
				workflowName: "Nightly digest",
				message:
					"The workflow engine rejected the start: task queue closed",
			});

			const res = await POST(request({ workflowId: "wf-1" }));

			expect(res.status).toBe(502);
			expect(await res.json()).toMatchObject({
				code: "EXECUTION_NOT_STARTED",
				executionId: "exec-1",
			});
		});
	});
});
