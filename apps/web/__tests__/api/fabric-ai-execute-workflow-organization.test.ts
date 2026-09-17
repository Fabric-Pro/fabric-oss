/**
 * The chat-confirmed workflow start receives the tab's organization in its
 * body. It must be honoured only when the caller has a tie to that
 * organization (membership or an accepted project-guest invitation), refused
 * with 403 otherwise, and never silently swapped for the session's active
 * organization: a user with two organizations open in two tabs confirms a
 * workflow in the tab's own tenant. A body that names no organization runs in
 * the session's active organization, which gets the SAME tie check (a stale
 * active organization the caller has left is refused), and a session with
 * none is refused outright: there is no personal/null tenant (ADR-018).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	checkRateLimit: vi.fn(),
	getWorkflowById: vi.fn(),
	hasOrganizationTie: vi.fn(),
	createWorkflowExecution: vi.fn(),
	updateWorkflowExecution: vi.fn(),
	isTemporalAvailable: vi.fn(),
	getTemporalClient: vi.fn(),
	startWorkflowBuilderExecution: vi.fn(),
	checkExecutionConcurrency: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({ getSession: mocks.getSession }));
vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: mocks.checkRateLimit,
	RATE_LIMIT_PRESETS: { workflow: { limit: 30, windowMs: 60_000 } },
}));
vi.mock("@repo/database", () => ({
	getWorkflowById: mocks.getWorkflowById,
	hasOrganizationTie: mocks.hasOrganizationTie,
	createWorkflowExecution: mocks.createWorkflowExecution,
	updateWorkflowExecution: mocks.updateWorkflowExecution,
}));
vi.mock("@repo/temporal", () => ({
	isTemporalAvailable: mocks.isTemporalAvailable,
	getTemporalClient: mocks.getTemporalClient,
}));
vi.mock("@repo/api/modules/workflows/lib/start-builder-execution", () => ({
	startWorkflowBuilderExecution: mocks.startWorkflowBuilderExecution,
}));
vi.mock("@repo/api/modules/workflows/lib/execution-concurrency", () => ({
	checkExecutionConcurrency: mocks.checkExecutionConcurrency,
}));

import { POST } from "@/app/api/agents/fabric-ai/execute-workflow/route";

function request(body: unknown) {
	return new NextRequest(
		"http://localhost/api/agents/fabric-ai/execute-workflow",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
}

describe("POST /api/agents/fabric-ai/execute-workflow — organization binding", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSession.mockResolvedValue({
			user: { id: "user-1" },
			session: { activeOrganizationId: "org-active" },
		});
		mocks.checkRateLimit.mockResolvedValue({ allowed: true });
		// Whatever organization the lookup receives, report "not found" so
		// the test stops before any start logic; we only care which tenant
		// was consulted.
		mocks.getWorkflowById.mockResolvedValue(null);
		mocks.hasOrganizationTie.mockResolvedValue(false);
	});

	it("refuses an organization the caller has no tie to, without consulting the session's", async () => {
		const res = await POST(
			request({ workflowId: "wf-1", organizationId: "org-victim" }),
		);
		expect(res.status).toBe(403);
		expect(mocks.hasOrganizationTie).toHaveBeenCalledWith(
			"user-1",
			"org-victim",
		);
		expect(mocks.getWorkflowById).not.toHaveBeenCalled();
	});

	it("looks the workflow up in the tab's organization when the caller is tied to it", async () => {
		mocks.hasOrganizationTie.mockResolvedValue(true);
		await POST(request({ workflowId: "wf-1", organizationId: "org-tab" }));
		expect(mocks.getWorkflowById).toHaveBeenCalledWith(
			"wf-1",
			"user-1",
			"org-tab",
		);
	});

	it("uses the session's active organization when the body names none, once the caller's tie to it is verified", async () => {
		mocks.hasOrganizationTie.mockResolvedValue(true);
		await POST(request({ workflowId: "wf-1" }));
		expect(mocks.hasOrganizationTie).toHaveBeenCalledWith(
			"user-1",
			"org-active",
		);
		expect(mocks.getWorkflowById).toHaveBeenCalledWith(
			"wf-1",
			"user-1",
			"org-active",
		);
	});

	it("refuses a stale active organization the caller has since left, instead of executing in it", async () => {
		mocks.hasOrganizationTie.mockResolvedValue(false);
		const res = await POST(request({ workflowId: "wf-1" }));
		expect(res.status).toBe(403);
		expect(mocks.hasOrganizationTie).toHaveBeenCalledWith(
			"user-1",
			"org-active",
		);
		expect(mocks.getWorkflowById).not.toHaveBeenCalled();
		expect(mocks.createWorkflowExecution).not.toHaveBeenCalled();
	});

	it("refuses a session with no active organization rather than falling through to a null tenant", async () => {
		mocks.getSession.mockResolvedValue({
			user: { id: "user-1" },
			session: { activeOrganizationId: null },
		});
		const res = await POST(request({ workflowId: "wf-1" }));
		expect(res.status).toBe(403);
		expect(mocks.hasOrganizationTie).not.toHaveBeenCalled();
		expect(mocks.getWorkflowById).not.toHaveBeenCalled();
		expect(mocks.createWorkflowExecution).not.toHaveBeenCalled();
	});
});
