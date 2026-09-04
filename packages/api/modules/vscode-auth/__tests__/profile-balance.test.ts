/**
 * `GET /api/profile/balance` — the VS Code extension's account-balance call.
 *
 * WHAT IS PINNED HERE (Fizzy #1875)
 *
 * Fabric no longer grants or sells AI credits, so there is no balance to read
 * and no credit machinery left to read it with. The route survives that removal
 * anyway: released extension builds call it, this repository cannot upgrade
 * them, and its documented contract already covered the case ("returns 0 for
 * plans without credits"). It answers a well-defined zero rather than a 404.
 *
 * The second assertion is the one that would catch a regression: the handler
 * must not reach for the access helper again. That helper no longer returns a
 * balance, so a reintroduced call would silently reinstate `undefined ?? 0` —
 * the same zero, arrived at by an accident that a later change could turn into
 * a crash.
 *
 * Mocks sit at boundaries only: the module's heavy imports (`@repo/database`,
 * `@repo/ai/model-selector`, the `ai` SDK) are stubbed so importing the route
 * file costs nothing, and API-key verification is stubbed so a bearer token can
 * be presented without a database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyUserApiKeyMock, creditAccessMock } = vi.hoisted(() => ({
	verifyUserApiKeyMock: vi.fn(),
	creditAccessMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {},
	createUserApiKey: vi.fn(),
}));

vi.mock("@repo/ai/model-selector", () => ({
	getAIModelWithMetadata: vi.fn(),
}));

vi.mock("ai", () => ({
	streamText: vi.fn(),
}));

// Deliberately mocked even though the route should never touch it: if the
// handler starts importing and calling the access helper again, this spy
// records it instead of the change passing unnoticed.
vi.mock("@repo/payments", () => ({
	getTenantAiCreditAccess: creditAccessMock,
}));

vi.mock("../../users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: verifyUserApiKeyMock,
}));

import { createVscodeAuthRoutes } from "../routes";

// The `fab_` prefix is load-bearing: `authFromBearer` rejects anything without
// it before the mocked verifier is ever consulted, so a token that does not
// start with it gets a 401 instead of reaching the code under test.
//
// Everything after the prefix is not. Keep it dull — a realistic-looking
// secret trips the publication gate, which runs gitleaks under default rules
// and deliberately ignores this repository's allowlist.
const API_KEY = "fab_test_key";
const USER_ID = "user-1";

async function getBalance(headers: Record<string, string>) {
	return await createVscodeAuthRoutes().request("/profile/balance", {
		headers,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	verifyUserApiKeyMock.mockResolvedValue({ valid: true, userId: USER_ID });
	creditAccessMock.mockRejectedValue(
		new Error("the balance route must not consult the access helper"),
	);
});

describe("GET /profile/balance", () => {
	it("answers zero for an authenticated caller, with no credit machinery involved", async () => {
		const res = await getBalance({ Authorization: `Bearer ${API_KEY}` });

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ balance: 0 });
		expect(creditAccessMock).not.toHaveBeenCalled();
	});

	it("still authenticates: no bearer token is 401, not a zero balance", async () => {
		// The zero is not a way around the API key. An unauthenticated caller is
		// refused exactly as before.
		const res = await getBalance({});

		expect(res.status).toBe(401);
		await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
	});

	it("refuses a token the key verifier rejects", async () => {
		verifyUserApiKeyMock.mockResolvedValue({ valid: false });

		const res = await getBalance({ Authorization: `Bearer ${API_KEY}` });

		expect(res.status).toBe(401);
	});
});
