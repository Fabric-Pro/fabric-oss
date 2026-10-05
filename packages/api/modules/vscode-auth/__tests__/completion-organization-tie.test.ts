/**
 * The Fabric Code completion route only runs in an organization the key's
 * user has a tie to.
 *
 * `POST /openrouter/chat/completions` authenticates with a `fab_` user API
 * key, which identifies a user and nothing else. The organization comes from
 * the `x-fabriccode-organizationid` header, and it selects whose AI provider
 * (and provider key) runs the completion. A header naming an organization the
 * user has no tie to is refused with 403 before any model is resolved. A
 * request without the header keeps its existing behaviour: this API-key path
 * has no session and so no active organization to fall back to.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyUserApiKeyMock, hasOrganizationTieMock, getAIModelMock } =
	vi.hoisted(() => ({
		verifyUserApiKeyMock: vi.fn(),
		hasOrganizationTieMock: vi.fn(),
		getAIModelMock: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	db: {},
	createUserApiKey: vi.fn(),
	hasOrganizationTie: hasOrganizationTieMock,
}));
vi.mock("@repo/ai/model-selector", () => ({
	getAIModelWithMetadata: getAIModelMock,
}));
const generateTextMock = vi.fn();
vi.mock("ai", () => ({
	streamText: vi.fn(),
	generateText: (...args: unknown[]) => generateTextMock(...args),
}));
vi.mock("../../users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: verifyUserApiKeyMock,
}));

import { createVscodeAuthRoutes } from "../routes";

const API_KEY = "fab_test_key";
const USER_ID = "user-1";
const TIED_ORG = "org-tied";
const FOREIGN_ORG = "org-foreign";

function postCompletion(organizationHeader?: string) {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${API_KEY}`,
		"content-type": "application/json",
	};
	if (organizationHeader !== undefined) {
		headers["x-fabriccode-organizationid"] = organizationHeader;
	}
	return createVscodeAuthRoutes().request("/openrouter/chat/completions", {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: "fabric/auto",
			stream: false,
			messages: [{ role: "user", content: "hello" }],
		}),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	verifyUserApiKeyMock.mockResolvedValue({
		valid: true,
		userId: USER_ID,
		scopes: ["mcp:read", "mcp:write"],
	});
	hasOrganizationTieMock.mockImplementation(
		async (_userId: string, organizationId: string) =>
			organizationId === TIED_ORG,
	);
	getAIModelMock.mockResolvedValue({
		model: { id: "stub-model" },
		metadata: { modelString: "stub-model" },
		trackUsage: vi.fn(),
	});
	generateTextMock.mockResolvedValue({ text: "hi" });
});

describe("POST /openrouter/chat/completions — organization header", () => {
	it("refuses an organization the key's user has no tie to, before resolving a model", async () => {
		const res = await postCompletion(FOREIGN_ORG);

		expect(res.status).toBe(403);
		expect(hasOrganizationTieMock).toHaveBeenCalledWith(
			USER_ID,
			FOREIGN_ORG,
		);
		expect(getAIModelMock).not.toHaveBeenCalled();
	});

	it("runs in an organization the user has a tie to", async () => {
		const res = await postCompletion(TIED_ORG);

		expect(res.status).toBe(200);
		expect(getAIModelMock).toHaveBeenCalledWith(
			{ taskType: "CHAT", complexity: "medium" },
			{ userId: USER_ID, organizationId: TIED_ORG },
		);
	});

	it("keeps the no-header behaviour: no tie check, no organization", async () => {
		const res = await postCompletion();

		expect(res.status).toBe(200);
		expect(hasOrganizationTieMock).not.toHaveBeenCalled();
		expect(getAIModelMock).toHaveBeenCalledWith(
			{ taskType: "CHAT", complexity: "medium" },
			{ userId: USER_ID, organizationId: undefined },
		);
	});
});
