import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyUserApiKeyMock, logErrorMock } = vi.hoisted(() => ({
	verifyUserApiKeyMock: vi.fn(),
	logErrorMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {},
	createUserApiKey: vi.fn(),
	hasOrganizationTie: vi.fn(),
}));
vi.mock("@repo/logs", () => ({ logger: { error: logErrorMock } }));
vi.mock("@repo/ai/model-selector", () => {
	throw new Error("cannot load /srv/internal/path/model-selector");
});
vi.mock("../../users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: verifyUserApiKeyMock,
}));

import { createVscodeAuthRoutes } from "../routes";

beforeEach(() => {
	vi.clearAllMocks();
	verifyUserApiKeyMock.mockResolvedValue({
		valid: true,
		userId: "user-1",
		scopes: ["mcp:read", "mcp:write"],
	});
});

describe("POST /openrouter/chat/completions — model selector fails to load", () => {
	it("answers 500 with a generic message and logs the cause", async () => {
		// Arrange
		const routes = createVscodeAuthRoutes();

		// Act
		const res = await routes.request("/openrouter/chat/completions", {
			method: "POST",
			headers: {
				Authorization: "Bearer fab_test_key",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "fabric/auto",
				stream: false,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		// Assert
		expect(res.status).toBe(500);
		expect(JSON.stringify(await res.json())).not.toContain("/srv/internal");
		expect(logErrorMock).toHaveBeenCalledOnce();
	});
});
