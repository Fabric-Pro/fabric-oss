// @vitest-environment node
// These exercise server route handlers, and `jose` rejects the Uint8Array
// jsdom's TextEncoder returns (different realm), so run them in node.

/**
 * `POST /api/orchestrator/verify` — the endpoint the PartyKit worker
 * (party-cf/src/orchestrator.ts) and the self-hosted legacy party server call
 * to authorize a live subscriber, issue #624.
 *
 * The 2xx `{ valid, userId }` response shape is a contract with those callers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	bearerPost,
	type SignLiveTokenOptions,
	signLiveToken,
} from "./helpers/live-jwt";

const SECRET = "test-collab-jwt-secret-for-orchestrator-verify";
const EXECUTION_ID = "orch-11111111-2222-3333-4444-555555555555";
const VERIFY_URL = "https://example.test/api/orchestrator/verify";

const {
	mockDescribe,
	mockGetOrganizationMembership,
	mockGetTemporalClient,
	mockCheckRateLimit,
} = vi.hoisted(() => ({
	mockDescribe: vi.fn(),
	mockGetOrganizationMembership: vi.fn(),
	mockGetTemporalClient: vi.fn(),
	mockCheckRateLimit: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getOrganizationMembership: mockGetOrganizationMembership,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mockGetTemporalClient,
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
		audience: "orchestrator-live",
		secret: SECRET,
		...options,
	});
}

async function callRoute(
	token: string | null,
	body: unknown = { executionId: EXECUTION_ID },
) {
	const { POST } = await import("../../app/api/orchestrator/verify/route");
	return POST(bearerPost(VERIFY_URL, token, body));
}

describe("POST /api/orchestrator/verify", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.COLLAB_JWT_SECRET = SECRET;
		mockDescribe.mockResolvedValue({ memo: { userId: "user-1" } });
		mockGetOrganizationMembership.mockResolvedValue({ id: "member-1" });
		mockGetTemporalClient.mockResolvedValue({
			workflow: { getHandle: () => ({ describe: mockDescribe }) },
		});
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

	it("401s on a token signed with a different secret", async () => {
		const token = await signToken(
			{ userId: "user-1", executionId: EXECUTION_ID },
			{ secret: "some-other-secret" },
		);

		const response = await callRoute(token);

		expect(response.status).toBe(401);
	});

	it("401s on an expired token", async () => {
		const token = await signToken(
			{ userId: "user-1", executionId: EXECUTION_ID },
			{ expirationTime: Math.floor(Date.now() / 1000) - 60 },
		);

		const response = await callRoute(token);

		expect(response.status).toBe(401);
	});

	it("401s on a task-agent token replayed here", async () => {
		const token = await signToken(
			{ userId: "user-1", executionId: EXECUTION_ID },
			{ audience: "task-agent-live" },
		);

		const response = await callRoute(token);

		expect(response.status).toBe(401);
	});

	it("401s when the executionId claim is missing", async () => {
		const token = await signToken({ userId: "user-1" });

		const response = await callRoute(token);

		expect(response.status).toBe(401);
	});

	it("403s when the token is for a different room", async () => {
		const token = await signToken({
			userId: "user-1",
			executionId: "orch-99999999-2222-3333-4444-555555555555",
		});

		const response = await callRoute(token);

		expect(response.status).toBe(403);
		expect(mockDescribe).not.toHaveBeenCalled();
	});

	it("403s when the workflow memo no longer names the token's user", async () => {
		mockDescribe.mockResolvedValue({ memo: { userId: "someone-else" } });
		const token = await signToken({
			userId: "user-1",
			executionId: EXECUTION_ID,
		});

		const response = await callRoute(token);

		expect(response.status).toBe(403);
	});

	it("403s when org membership was revoked after the token was minted", async () => {
		mockDescribe.mockResolvedValue({
			memo: { userId: "user-1", organizationId: "org-1" },
		});
		mockGetOrganizationMembership.mockResolvedValue(null);
		const token = await signToken({
			userId: "user-1",
			executionId: EXECUTION_ID,
			organizationId: "org-1",
		});

		const response = await callRoute(token);

		expect(response.status).toBe(403);
	});

	it("404s when the workflow is gone", async () => {
		mockDescribe.mockRejectedValue(new Error("workflow not found"));
		const token = await signToken({
			userId: "user-1",
			executionId: EXECUTION_ID,
		});

		const response = await callRoute(token);

		expect(response.status).toBe(404);
	});

	it("returns { valid: true, userId } for a good token", async () => {
		const token = await signToken({
			userId: "user-1",
			executionId: EXECUTION_ID,
		});

		const response = await callRoute(token);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			valid: true,
			userId: "user-1",
		});
	});

	it("rejects a bad token before reading the request body", async () => {
		// An unparseable body would throw if it were read first; a 401 proves
		// the JWT is checked before the body is touched.
		const response = await callRoute("not.a.jwt", "{ this is not json");

		expect(response.status).toBe(401);
		expect(mockCheckRateLimit).not.toHaveBeenCalled();
	});

	it("429s when the per-execution verify limit is exhausted", async () => {
		mockCheckRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 17,
		});
		const token = await signToken({
			userId: "user-1",
			executionId: EXECUTION_ID,
		});

		const response = await callRoute(token);

		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("17");
		expect(mockCheckRateLimit).toHaveBeenCalledWith(
			`orchestrator:verify:${EXECUTION_ID}`,
			60,
			60_000,
		);
		expect(mockDescribe).not.toHaveBeenCalled();
	});

	it("500s with a generic body that does not leak the internal error", async () => {
		mockGetTemporalClient.mockRejectedValue(
			new Error("temporal connection string leaked here"),
		);
		const token = await signToken({
			userId: "user-1",
			executionId: EXECUTION_ID,
		});

		const response = await callRoute(token);

		expect(response.status).toBe(500);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe("Internal server error");
		expect(JSON.stringify(body)).not.toContain(
			"temporal connection string",
		);
	});
});
