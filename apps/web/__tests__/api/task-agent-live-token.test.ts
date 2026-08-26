// @vitest-environment node
// These exercise server route handlers, and `jose` rejects the Uint8Array
// jsdom's TextEncoder returns (different realm), so run them in node.

/**
 * `POST /api/task-agent/token` — scoped JWT issuance for the task-agent live
 * (PartyKit) room, issue #624.
 *
 * Authorization is project-scoped, matching `get-agent-status`: teammates with
 * project access may watch a run they did not start.
 */

import { jwtVerify } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-collab-jwt-secret-for-task-agent-token";
const PLAN_ID = "plan_abc123";

const {
	mockGetSession,
	mockCheckRateLimit,
	mockPlanFindUnique,
	mockHasAccess,
	mockGetOrganizationMembership,
	mockDescribe,
} = vi.hoisted(() => ({
	mockGetSession: vi.fn(),
	mockCheckRateLimit: vi.fn(),
	mockPlanFindUnique: vi.fn(),
	mockHasAccess: vi.fn(),
	mockGetOrganizationMembership: vi.fn(),
	mockDescribe: vi.fn(),
}));

// The route reads the session through the `getSession()` helper (which pins
// `disableCookieCache`), so the helper is what gets stubbed — importing it for
// real would pull in `server-only`, which throws outside a Server Component.
vi.mock("@saas/auth/lib/server", () => ({
	getSession: mockGetSession,
}));

vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: mockCheckRateLimit,
}));

vi.mock("@repo/database", () => ({
	db: {
		taskWorkflowPlan: { findUnique: mockPlanFindUnique },
	},
	hasProjectAccess: mockHasAccess,
	// Needed because the cross-audience case below drives the real orchestrator
	// verify handler.
	getOrganizationMembership: mockGetOrganizationMembership,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { getHandle: () => ({ describe: mockDescribe }) },
	})),
}));

async function callRoute(body: unknown) {
	const { POST } = await import("../../app/api/task-agent/token/route");
	return POST(
		new Request("https://example.test/api/task-agent/token", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

describe("POST /api/task-agent/token", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.COLLAB_JWT_SECRET = SECRET;
		mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
		mockCheckRateLimit.mockResolvedValue({
			allowed: true,
			remaining: 59,
			resetInSeconds: 60,
		});
		mockPlanFindUnique.mockResolvedValue({
			id: PLAN_ID,
			projectId: "project-1",
			organizationId: "org-1",
		});
		mockHasAccess.mockResolvedValue(true);
	});

	it("401s without a session", async () => {
		mockGetSession.mockResolvedValue(null);

		const response = await callRoute({ planId: PLAN_ID });

		expect(response.status).toBe(401);
		expect(mockPlanFindUnique).not.toHaveBeenCalled();
	});

	it("429s when the per-user rate limit is exhausted", async () => {
		mockCheckRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 30,
		});

		const response = await callRoute({ planId: PLAN_ID });

		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("30");
	});

	it("400s when planId is missing", async () => {
		const response = await callRoute({});

		expect(response.status).toBe(400);
	});

	it("404s when the plan row does not exist yet", async () => {
		mockPlanFindUnique.mockResolvedValue(null);

		const response = await callRoute({ planId: PLAN_ID });

		expect(response.status).toBe(404);
		expect(mockHasAccess).not.toHaveBeenCalled();
	});

	it("403s when the user has no access to the plan's project", async () => {
		mockHasAccess.mockResolvedValue(false);

		const response = await callRoute({ planId: PLAN_ID });

		expect(response.status).toBe(403);
		expect(mockHasAccess).toHaveBeenCalledWith("project-1", "user-1");
	});

	it("500s when COLLAB_JWT_SECRET is not configured", async () => {
		process.env.COLLAB_JWT_SECRET = "";

		const response = await callRoute({ planId: PLAN_ID });

		expect(response.status).toBe(500);
	});

	it("issues a 10-minute HS256 token scoped to the plan", async () => {
		const response = await callRoute({ planId: PLAN_ID });
		expect(response.status).toBe(200);

		const data = (await response.json()) as {
			token: string;
			expiresIn: number;
		};
		expect(data.expiresIn).toBe(600);

		const { payload, protectedHeader } = await jwtVerify(
			data.token,
			new TextEncoder().encode(SECRET),
			{ algorithms: ["HS256"], audience: "task-agent-live" },
		);

		expect(protectedHeader.alg).toBe("HS256");
		expect(payload.userId).toBe("user-1");
		expect(payload.planId).toBe(PLAN_ID);
		expect(payload.projectId).toBe("project-1");
		expect(payload.organizationId).toBe("org-1");
		expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(600);
	});

	it("mints a token the real orchestrator verify route refuses", async () => {
		const response = await callRoute({ planId: PLAN_ID });
		const data = (await response.json()) as { token: string };

		const { POST: orchestratorVerify } = await import(
			"../../app/api/orchestrator/verify/route"
		);
		const verifyResponse = await orchestratorVerify(
			new Request("https://example.test/api/orchestrator/verify", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${data.token}`,
				},
				body: JSON.stringify({
					executionId: "orch-11111111-2222-3333-4444-555555555555",
				}),
			}),
		);

		// Wrong audience — refused before any workflow lookup happens.
		expect(verifyResponse.status).toBe(401);
		expect(mockDescribe).not.toHaveBeenCalled();
	});
});
