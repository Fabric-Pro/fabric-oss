/**
 * Tests for Direct Chat Cancel Route
 *
 * Mirrors the orchestrator-temporal cancel route's surface (auth, rate-limit,
 * format validation, ownership-via-memo, already-terminated handling, happy
 * path). Spec section 9.3, Task 1.3.
 */

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist the mocks so the route module sees them at import time.
const {
	getSessionMock,
	checkRateLimitMock,
	getTemporalClientMock,
	memberFindFirstMock,
	workflowDescribeMock,
	workflowCancelMock,
	workflowGetHandleMock,
} = vi.hoisted(() => ({
	getSessionMock: vi.fn(),
	checkRateLimitMock: vi.fn(),
	getTemporalClientMock: vi.fn(),
	memberFindFirstMock: vi.fn(),
	workflowDescribeMock: vi.fn(),
	workflowCancelMock: vi.fn(),
	workflowGetHandleMock: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: getSessionMock,
}));

vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: checkRateLimitMock,
}));

vi.mock("@repo/database", () => ({
	db: {
		member: {
			findFirst: memberFindFirstMock,
		},
	},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: getTemporalClientMock,
}));

// Import the route AFTER the mocks are registered.
import { POST } from "../route";

const VALID_EXECUTION_ID = "direct-chat-550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "user_123";
const OTHER_USER_ID = "user_456";
const ORG_ID = "org_abc";

function makeRequest(body: unknown): NextRequest {
	// Only `request.json()` is called by the route, so a minimal stub is fine.
	return {
		json: async () => body,
	} as unknown as NextRequest;
}

function allowRateLimit() {
	checkRateLimitMock.mockResolvedValue({
		allowed: true,
		remaining: 9,
		resetInSeconds: 60,
	});
}

function defaultSession() {
	return {
		user: { id: USER_ID },
		session: { activeOrganizationId: null },
	};
}

function setupTemporalHandle(opts: {
	describe?: () => unknown;
	cancel?: () => unknown;
}) {
	workflowDescribeMock.mockImplementation(async () => {
		if (!opts.describe) {
			return { memo: { userId: USER_ID }, status: { name: "RUNNING" } };
		}
		return opts.describe();
	});
	workflowCancelMock.mockImplementation(async () => {
		if (opts.cancel) {
			return opts.cancel();
		}
		return undefined;
	});
	workflowGetHandleMock.mockReturnValue({
		describe: workflowDescribeMock,
		cancel: workflowCancelMock,
	});
	getTemporalClientMock.mockResolvedValue({
		workflow: {
			getHandle: workflowGetHandleMock,
		},
	});
}

describe("POST /api/agents/fabric-ai/stream/cancel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns 401 when there is no session", async () => {
		getSessionMock.mockResolvedValue(null);

		const response = await POST(
			makeRequest({ executionId: VALID_EXECUTION_ID }),
		);

		expect(response.status).toBe(401);
		const body = await response.json();
		expect(body).toEqual({ error: "Unauthorized" });
		expect(checkRateLimitMock).not.toHaveBeenCalled();
	});

	it("returns 429 with Retry-After when the rate limit is exceeded", async () => {
		getSessionMock.mockResolvedValue(defaultSession());
		checkRateLimitMock.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 42,
		});

		const response = await POST(
			makeRequest({ executionId: VALID_EXECUTION_ID }),
		);

		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("42");
		const body = await response.json();
		expect(body).toMatchObject({
			error: "Rate limit exceeded",
			retryAfter: 42,
		});
		// 11th call within a minute is rejected without ever touching Temporal.
		expect(getTemporalClientMock).not.toHaveBeenCalled();
	});

	it("uses the per-user rate-limit key", async () => {
		getSessionMock.mockResolvedValue(defaultSession());
		allowRateLimit();
		setupTemporalHandle({});

		await POST(makeRequest({ executionId: VALID_EXECUTION_ID }));

		expect(checkRateLimitMock).toHaveBeenCalledWith(
			`direct-chat:cancel:${USER_ID}`,
			10,
			60_000,
		);
	});

	it("returns 400 when executionId is missing", async () => {
		getSessionMock.mockResolvedValue(defaultSession());
		allowRateLimit();

		const response = await POST(makeRequest({}));

		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body).toEqual({ error: "executionId is required" });
		expect(getTemporalClientMock).not.toHaveBeenCalled();
	});

	it("returns 400 when executionId is malformed", async () => {
		getSessionMock.mockResolvedValue(defaultSession());
		allowRateLimit();

		const response = await POST(
			makeRequest({ executionId: "orch-not-a-direct-chat-id" }),
		);

		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body).toEqual({ error: "Invalid executionId format" });
		expect(getTemporalClientMock).not.toHaveBeenCalled();
	});

	it("returns 403 when the workflow memo is missing entirely (fail-closed)", async () => {
		getSessionMock.mockResolvedValue(defaultSession());
		allowRateLimit();
		setupTemporalHandle({
			describe: () => ({
				memo: undefined,
				status: { name: "RUNNING" },
			}),
		});

		const response = await POST(
			makeRequest({ executionId: VALID_EXECUTION_ID }),
		);

		expect(response.status).toBe(403);
		const body = await response.json();
		expect(body).toMatchObject({
			error: "Forbidden",
		});
		expect(body.message).toMatch(/missing tenant context/);
		expect(workflowCancelMock).not.toHaveBeenCalled();
	});

	it("returns 403 when memo.userId is missing (fail-closed)", async () => {
		getSessionMock.mockResolvedValue(defaultSession());
		allowRateLimit();
		setupTemporalHandle({
			describe: () => ({
				memo: { organizationId: ORG_ID },
				status: { name: "RUNNING" },
			}),
		});

		const response = await POST(
			makeRequest({ executionId: VALID_EXECUTION_ID }),
		);

		expect(response.status).toBe(403);
		expect(workflowCancelMock).not.toHaveBeenCalled();
	});

	it("returns 403 when memo.userId does not match the session user", async () => {
		getSessionMock.mockResolvedValue(defaultSession());
		allowRateLimit();
		setupTemporalHandle({
			describe: () => ({
				memo: { userId: OTHER_USER_ID },
				status: { name: "RUNNING" },
			}),
		});

		const response = await POST(
			makeRequest({ executionId: VALID_EXECUTION_ID }),
		);

		expect(response.status).toBe(403);
		const body = await response.json();
		expect(body).toMatchObject({
			error: "Forbidden",
			message: "You are not authorized to cancel this workflow",
		});
		expect(workflowCancelMock).not.toHaveBeenCalled();
	});

	it("returns 403 when memo.organizationId is set but the user is not a member", async () => {
		getSessionMock.mockResolvedValue(defaultSession());
		allowRateLimit();
		setupTemporalHandle({
			describe: () => ({
				memo: { userId: USER_ID, organizationId: ORG_ID },
				status: { name: "RUNNING" },
			}),
		});
		memberFindFirstMock.mockResolvedValue(null);

		const response = await POST(
			makeRequest({ executionId: VALID_EXECUTION_ID }),
		);

		expect(response.status).toBe(403);
		const body = await response.json();
		expect(body).toMatchObject({
			error: "Forbidden",
			message: "You are not a member of this organization",
		});
		expect(memberFindFirstMock).toHaveBeenCalledWith({
			where: { userId: USER_ID, organizationId: ORG_ID },
		});
		expect(workflowCancelMock).not.toHaveBeenCalled();
	});

	it("returns 200 with alreadyTerminated when the workflow is not RUNNING", async () => {
		getSessionMock.mockResolvedValue(defaultSession());
		allowRateLimit();
		setupTemporalHandle({
			describe: () => ({
				memo: { userId: USER_ID },
				status: { name: "COMPLETED" },
			}),
		});

		const response = await POST(
			makeRequest({ executionId: VALID_EXECUTION_ID }),
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			success: true,
			executionId: VALID_EXECUTION_ID,
			alreadyTerminated: true,
		});
		expect(body.message).toMatch(/completed/);
		expect(workflowCancelMock).not.toHaveBeenCalled();
	});

	it("returns 200 with alreadyTerminated when describe throws (not found)", async () => {
		getSessionMock.mockResolvedValue(defaultSession());
		allowRateLimit();
		setupTemporalHandle({
			describe: () => {
				throw new Error("workflow not found");
			},
		});

		const response = await POST(
			makeRequest({ executionId: VALID_EXECUTION_ID }),
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			success: true,
			executionId: VALID_EXECUTION_ID,
			alreadyTerminated: true,
			message: "Workflow not found or already terminated",
		});
		expect(workflowCancelMock).not.toHaveBeenCalled();
	});

	it("cancels the workflow and emits the audit log on the happy path", async () => {
		getSessionMock.mockResolvedValue(defaultSession());
		allowRateLimit();
		setupTemporalHandle({
			describe: () => ({
				memo: { userId: USER_ID },
				status: { name: "RUNNING" },
			}),
		});

		const consoleLogSpy = vi
			.spyOn(console, "log")
			.mockImplementation(() => {});

		const response = await POST(
			makeRequest({
				executionId: VALID_EXECUTION_ID,
				reason: "user_clicked_stop",
			}),
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({
			success: true,
			executionId: VALID_EXECUTION_ID,
			message: "Workflow cancelled",
		});
		expect(workflowCancelMock).toHaveBeenCalledTimes(1);

		const auditLogCall = consoleLogSpy.mock.calls.find((call) =>
			String(call[0]).startsWith("[DirectChat:Audit]"),
		);
		expect(auditLogCall).toBeDefined();
		// The request-derived fields travel as a structured argument, never
		// interpolated into the message string (CodeQL js/log-injection).
		expect(auditLogCall?.[0]).not.toContain(VALID_EXECUTION_ID);
		expect(auditLogCall?.[1]).toMatchObject({
			executionId: VALID_EXECUTION_ID,
			cancelledBy: USER_ID,
			reason: "user_clicked_stop",
		});

		consoleLogSpy.mockRestore();
	});

	it("allows org-scoped cancellation when the user is a member", async () => {
		getSessionMock.mockResolvedValue(defaultSession());
		allowRateLimit();
		setupTemporalHandle({
			describe: () => ({
				memo: { userId: USER_ID, organizationId: ORG_ID },
				status: { name: "RUNNING" },
			}),
		});
		memberFindFirstMock.mockResolvedValue({ id: "member_1" });

		const response = await POST(
			makeRequest({ executionId: VALID_EXECUTION_ID }),
		);

		expect(response.status).toBe(200);
		expect(memberFindFirstMock).toHaveBeenCalledWith({
			where: { userId: USER_ID, organizationId: ORG_ID },
		});
		expect(workflowCancelMock).toHaveBeenCalledTimes(1);
	});
});
