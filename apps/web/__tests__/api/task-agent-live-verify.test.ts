// @vitest-environment node
// These exercise server route handlers, and `jose` rejects the Uint8Array
// jsdom's TextEncoder returns (different realm), so run them in node.

/**
 * `POST /api/task-agent/verify` — the endpoint the PartyKit worker
 * (party-cf/src/taskAgent.ts) and the self-hosted legacy party server call to
 * authorize a live subscriber, issue #624.
 *
 * The 2xx `{ valid, userId }` response shape is a contract with those callers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	bearerPost,
	type SignLiveTokenOptions,
	signLiveToken,
} from "./helpers/live-jwt";

const SECRET = "test-collab-jwt-secret-for-task-agent-verify";
const PLAN_ID = "plan_abc123";
const VERIFY_URL = "https://example.test/api/task-agent/verify";

const { mockPlanFindUnique, mockHasAccess, mockCheckRateLimit } = vi.hoisted(
	() => ({
		mockPlanFindUnique: vi.fn(),
		mockHasAccess: vi.fn(),
		mockCheckRateLimit: vi.fn(),
	}),
);

vi.mock("@repo/database", () => ({
	db: { taskWorkflowPlan: { findUnique: mockPlanFindUnique } },
	hasProjectAccess: mockHasAccess,
}));

vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: mockCheckRateLimit,
}));

/** Defaults to a token this route should accept; options drive the negatives. */
function signToken(
	claims: Record<string, unknown>,
	options: Partial<SignLiveTokenOptions> = {},
): Promise<string> {
	return signLiveToken(claims, {
		audience: "task-agent-live",
		secret: SECRET,
		...options,
	});
}

async function callRoute(
	token: string | null,
	body: unknown = { planId: PLAN_ID },
) {
	const { POST } = await import("../../app/api/task-agent/verify/route");
	return POST(bearerPost(VERIFY_URL, token, body));
}

describe("POST /api/task-agent/verify", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.COLLAB_JWT_SECRET = SECRET;
		mockPlanFindUnique.mockResolvedValue({
			id: PLAN_ID,
			projectId: "project-1",
		});
		mockHasAccess.mockResolvedValue(true);
		mockCheckRateLimit.mockResolvedValue({
			allowed: true,
			remaining: 59,
			resetInSeconds: 60,
		});
	});

	it("401s without a bearer token", async () => {
		const response = await callRoute(null);

		expect(response.status).toBe(401);
	});

	it("401s on a garbage token", async () => {
		const response = await callRoute("not.a.jwt");

		expect(response.status).toBe(401);
	});

	it("401s on a collab-shaped token, which carries no audience", async () => {
		const token = await signToken(
			{ userId: "user-1", documentId: "doc-1", planId: PLAN_ID },
			{ audience: null },
		);

		const response = await callRoute(token);

		expect(response.status).toBe(401);
		expect(mockPlanFindUnique).not.toHaveBeenCalled();
	});

	it("401s when the planId claim is missing", async () => {
		const token = await signToken({ userId: "user-1" });

		const response = await callRoute(token);

		expect(response.status).toBe(401);
	});

	it("403s when the token is for a different room", async () => {
		const token = await signToken({
			userId: "user-1",
			planId: "plan_someone_else",
		});

		const response = await callRoute(token);

		expect(response.status).toBe(403);
		expect(mockPlanFindUnique).not.toHaveBeenCalled();
	});

	it("403s when project access was revoked after the token was minted", async () => {
		mockHasAccess.mockResolvedValue(false);
		const token = await signToken({ userId: "user-1", planId: PLAN_ID });

		const response = await callRoute(token);

		expect(response.status).toBe(403);
		expect(mockHasAccess).toHaveBeenCalledWith("project-1", "user-1");
	});

	it("404s when the plan is gone", async () => {
		mockPlanFindUnique.mockResolvedValue(null);
		const token = await signToken({ userId: "user-1", planId: PLAN_ID });

		const response = await callRoute(token);

		expect(response.status).toBe(404);
	});

	it("returns { valid: true, userId } for a good token", async () => {
		const token = await signToken({ userId: "user-1", planId: PLAN_ID });

		const response = await callRoute(token);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			valid: true,
			userId: "user-1",
		});
	});

	it("401s on an orchestrator token replayed here", async () => {
		const token = await signToken(
			{ userId: "user-1", planId: PLAN_ID },
			{ audience: "orchestrator-live" },
		);

		const response = await callRoute(token);

		expect(response.status).toBe(401);
		expect(mockPlanFindUnique).not.toHaveBeenCalled();
	});

	it("rejects a bad token before reading the request body", async () => {
		// An unparseable body would throw if it were read first; a 401 proves
		// the JWT is checked before the body is touched.
		const response = await callRoute("not.a.jwt", "{ this is not json");

		expect(response.status).toBe(401);
		expect(mockCheckRateLimit).not.toHaveBeenCalled();
	});

	it("429s when the per-plan verify limit is exhausted", async () => {
		mockCheckRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 23,
		});
		const token = await signToken({ userId: "user-1", planId: PLAN_ID });

		const response = await callRoute(token);

		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("23");
		expect(mockCheckRateLimit).toHaveBeenCalledWith(
			`task-agent:verify:${PLAN_ID}`,
			60,
			60_000,
		);
		expect(mockPlanFindUnique).not.toHaveBeenCalled();
	});

	it("500s with a generic body that does not leak the internal error", async () => {
		mockPlanFindUnique.mockRejectedValue(
			new Error("prisma connection string leaked here"),
		);
		const token = await signToken({ userId: "user-1", planId: PLAN_ID });

		const response = await callRoute(token);

		expect(response.status).toBe(500);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe("Internal server error");
		expect(JSON.stringify(body)).not.toContain("prisma connection string");
	});
});
