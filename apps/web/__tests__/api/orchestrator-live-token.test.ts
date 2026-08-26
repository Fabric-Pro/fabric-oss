// @vitest-environment node
// These exercise server route handlers, and `jose` rejects the Uint8Array
// jsdom's TextEncoder returns (different realm), so run them in node.

/**
 * `POST /api/orchestrator/token` — scoped JWT issuance for the orchestrator
 * live (PartyKit) room, issue #624.
 *
 * An orchestrator run has no Prisma row, so ownership is the Temporal workflow
 * memo. The route is deliberately stricter than
 * `/api/agents/fabric-ai/orchestrator-temporal/cancel`, which skips the check
 * when `memo.userId` is absent: here an unattributable run gets no token.
 */

import { jwtVerify } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-collab-jwt-secret-for-orchestrator-token";
const EXECUTION_ID = "orch-11111111-2222-3333-4444-555555555555";

const {
	mockGetSession,
	mockCheckRateLimit,
	mockDescribe,
	mockGetOrganizationMembership,
} = vi.hoisted(() => ({
	mockGetSession: vi.fn(),
	mockCheckRateLimit: vi.fn(),
	mockDescribe: vi.fn(),
	mockGetOrganizationMembership: vi.fn(),
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
	getOrganizationMembership: mockGetOrganizationMembership,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { getHandle: () => ({ describe: mockDescribe }) },
	})),
}));

function post(body: unknown): Request {
	return new Request("https://example.test/api/orchestrator/token", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function callRoute(body: unknown) {
	const { POST } = await import("../../app/api/orchestrator/token/route");
	return POST(post(body));
}

describe("POST /api/orchestrator/token", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.COLLAB_JWT_SECRET = SECRET;
		mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
		mockCheckRateLimit.mockResolvedValue({
			allowed: true,
			remaining: 59,
			resetInSeconds: 60,
		});
		mockDescribe.mockResolvedValue({
			memo: { userId: "user-1" },
			status: { name: "RUNNING" },
		});
		mockGetOrganizationMembership.mockResolvedValue({ id: "member-1" });
	});

	it("401s without a session", async () => {
		mockGetSession.mockResolvedValue(null);

		const response = await callRoute({ executionId: EXECUTION_ID });

		expect(response.status).toBe(401);
		expect(mockDescribe).not.toHaveBeenCalled();
	});

	it("429s when the per-user rate limit is exhausted", async () => {
		mockCheckRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 42,
		});

		const response = await callRoute({ executionId: EXECUTION_ID });

		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("42");
		expect(mockDescribe).not.toHaveBeenCalled();
	});

	it("400s on a malformed executionId", async () => {
		const response = await callRoute({ executionId: "not-an-orch-id" });

		expect(response.status).toBe(400);
		// The format rule is part of the request schema, so the reason arrives
		// in `details` rather than as a bare `error` string.
		const body = (await response.json()) as {
			details: { message: string }[];
		};
		expect(body.details.map((issue) => issue.message)).toContain(
			"Invalid executionId format",
		);
		expect(mockDescribe).not.toHaveBeenCalled();
	});

	it("403s when the workflow memo names a different owner", async () => {
		mockDescribe.mockResolvedValue({ memo: { userId: "someone-else" } });

		const response = await callRoute({ executionId: EXECUTION_ID });

		expect(response.status).toBe(403);
	});

	it("403s when the workflow memo carries no owner at all", async () => {
		mockDescribe.mockResolvedValue({ memo: {} });

		const response = await callRoute({ executionId: EXECUTION_ID });

		expect(response.status).toBe(403);
	});

	it("403s when the run is org-scoped and the user is not a member", async () => {
		mockDescribe.mockResolvedValue({
			memo: { userId: "user-1", organizationId: "org-1" },
		});
		mockGetOrganizationMembership.mockResolvedValue(null);

		const response = await callRoute({ executionId: EXECUTION_ID });

		expect(response.status).toBe(403);
		expect(mockGetOrganizationMembership).toHaveBeenCalledWith(
			"org-1",
			"user-1",
		);
	});

	it("404s when the workflow cannot be described", async () => {
		mockDescribe.mockRejectedValue(new Error("workflow not found"));

		const response = await callRoute({ executionId: EXECUTION_ID });

		expect(response.status).toBe(404);
	});

	it("500s when COLLAB_JWT_SECRET is not configured", async () => {
		process.env.COLLAB_JWT_SECRET = "";

		const response = await callRoute({ executionId: EXECUTION_ID });

		expect(response.status).toBe(500);
	});

	it("issues a 10-minute HS256 token scoped to the execution", async () => {
		mockDescribe.mockResolvedValue({
			memo: { userId: "user-1", organizationId: "org-1" },
		});

		const response = await callRoute({ executionId: EXECUTION_ID });
		expect(response.status).toBe(200);

		const data = (await response.json()) as {
			token: string;
			expiresIn: number;
		};
		expect(data.expiresIn).toBe(600);

		const { payload, protectedHeader } = await jwtVerify(
			data.token,
			new TextEncoder().encode(SECRET),
			{ algorithms: ["HS256"], audience: "orchestrator-live" },
		);

		expect(protectedHeader.alg).toBe("HS256");
		expect(payload.userId).toBe("user-1");
		expect(payload.executionId).toBe(EXECUTION_ID);
		expect(payload.organizationId).toBe("org-1");
		expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(600);
	});

	it("records a null organization for personal runs", async () => {
		const response = await callRoute({ executionId: EXECUTION_ID });
		const data = (await response.json()) as { token: string };

		const { payload } = await jwtVerify(
			data.token,
			new TextEncoder().encode(SECRET),
			{ algorithms: ["HS256"], audience: "orchestrator-live" },
		);

		expect(payload.organizationId).toBeNull();
		expect(mockGetOrganizationMembership).not.toHaveBeenCalled();
	});
});
