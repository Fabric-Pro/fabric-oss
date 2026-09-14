/**
 * The Fabric Code routes require a scope (Fizzy #2380, QA round 2).
 *
 * `authFromBearer` called `verifyUserApiKey` with one argument. That
 * function's scope parameter is optional and its check is guarded by it, so
 * passing nothing skipped the check entirely — every route in this module
 * accepted any valid `fab_` key, whatever it had been issued to do. The audit
 * reached `/profile`, `/profile/balance`, `/defaults` and
 * `/openrouter/models` with a key holding unrelated scopes.
 *
 * Low impact on its own — three of those are static and `/profile` returns
 * only the caller's own identity — but it was the last surface in the product
 * that read no scopes at all, and the shape is the bug, not the blast radius.
 *
 * The scopes chosen are the two the key minted by `/vscode-auth/approve`
 * already carries, so the extension is unaffected. What is refused is a key
 * issued for something else.
 *
 * The verifier is mocked, so what is pinned is the ARGUMENT each route demands
 * plus the route's behaviour when the verifier refuses. The wildcard rule
 * itself belongs to `verifyUserApiKey` and is asserted there.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyUserApiKeyMock } = vi.hoisted(() => ({
	verifyUserApiKeyMock: vi.fn(),
}));

// `/profile` is the only route here that reads anything; the rest answer from
// constants. Enough of `db` to let it succeed, so a 200 means the scope gate
// passed rather than that the handler fell over on a stub.
vi.mock("@repo/database", () => ({
	db: {
		user: {
			findUnique: vi.fn().mockResolvedValue({
				id: "user-1",
				email: "dev@example.com",
				name: "Dev",
			}),
		},
		member: { findMany: vi.fn().mockResolvedValue([]) },
	},
	createUserApiKey: vi.fn(),
}));
vi.mock("@repo/ai/model-selector", () => ({
	getAIModelWithMetadata: vi.fn(),
}));
vi.mock("ai", () => ({ streamText: vi.fn() }));
vi.mock("@repo/payments", () => ({ getTenantAiCreditAccess: vi.fn() }));
vi.mock("../../users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: verifyUserApiKeyMock,
}));

import { createVscodeAuthRoutes } from "../routes";

const API_KEY = "fab_test_key";
const USER_ID = "user-1";

/** Mirrors the real verifier, wildcard rule included. */
function keyHolding(scopes: string[]) {
	return async (_token: string, requiredScope?: string) => {
		if (
			requiredScope &&
			!scopes.includes(requiredScope) &&
			!scopes.includes("*")
		) {
			return {
				valid: false,
				error: `Missing required scope: ${requiredScope}`,
			};
		}
		return { valid: true, userId: USER_ID, scopes };
	};
}

function get(path: string) {
	return createVscodeAuthRoutes().request(path, {
		headers: { Authorization: `Bearer ${API_KEY}` },
	});
}

const READ_ROUTES = [
	"/profile",
	"/profile/balance",
	"/defaults",
	"/organizations/org-1/defaults",
	"/openrouter/models",
];

beforeEach(() => {
	vi.clearAllMocks();
});

describe("the read routes", () => {
	it.each(READ_ROUTES)("%s demands mcp:read", async (path) => {
		verifyUserApiKeyMock.mockImplementation(keyHolding(["mcp:read"]));

		const res = await get(path);

		expect(res.status).toBe(200);
		expect(verifyUserApiKeyMock).toHaveBeenCalledWith(API_KEY, "mcp:read");
	});

	it.each(READ_ROUTES)("%s refuses a key without it", async (path) => {
		// A real key, valid and unexpired — issued to read projects, not to
		// drive the editor extension.
		verifyUserApiKeyMock.mockImplementation(keyHolding(["projects:read"]));

		const res = await get(path);

		expect(res.status).toBe(401);
	});

	it.each(READ_ROUTES)(
		"%s still accepts a legacy wildcard key",
		async (path) => {
			// Keys minted before the VS Code key was narrowed carry `["*"]` and
			// nothing else. They must keep working until they are migrated.
			verifyUserApiKeyMock.mockImplementation(keyHolding(["*"]));

			const res = await get(path);

			expect(res.status).toBe(200);
		},
	);
});

describe("the completion route", () => {
	function postCompletion() {
		return createVscodeAuthRoutes().request(
			"/openrouter/chat/completions",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${API_KEY}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ messages: [] }),
			},
		);
	}

	it("demands mcp:write, not mcp:read", async () => {
		// It runs a completion. A read-only key reaching it was the part worth
		// separating from the rest of the module.
		verifyUserApiKeyMock.mockImplementation(keyHolding(["mcp:read"]));

		const res = await postCompletion();

		expect(res.status).toBe(401);
		expect(verifyUserApiKeyMock).toHaveBeenCalledWith(API_KEY, "mcp:write");
	});

	it("refuses an unrelated key too", async () => {
		verifyUserApiKeyMock.mockImplementation(keyHolding(["projects:write"]));

		expect((await postCompletion()).status).toBe(401);
	});
});
