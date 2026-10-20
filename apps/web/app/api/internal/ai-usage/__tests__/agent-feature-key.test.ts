/**
 * Out-of-process agents report usage with an agent id but no feature key.
 * The route tags the agents whose every call serves one feature, so their
 * rows stop landing in the untagged bucket; an explicit key always wins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	logAiUsage: vi.fn(),
}));

vi.mock("@repo/ai-token", () => ({
	AI_TOKEN_HEADER: "X-AI-Token",
	verifyAIToken: async () => ({
		valid: true,
		claims: { sub: "user-1", org: "org-1" },
	}),
}));

vi.mock("@repo/database", () => ({
	getProjectAccessContext: vi.fn(async () => ({
		organizationId: "org-1",
	})),
	logAiUsage: mocks.logAiUsage,
	getChatGptPlanOrgAccount: vi.fn(),
}));

const { POST } = await import("../route");

const usage = (extra: Record<string, unknown>) =>
	POST(
		new Request("http://localhost/api/internal/ai-usage", {
			method: "POST",
			headers: {
				"X-AI-Token": "jwt",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				provider: "VERCEL_GATEWAY",
				model: "anthropic/claude-example",
				taskType: "COMPLEX",
				inputTokens: 10,
				outputTokens: 2,
				totalTokens: 12,
				...extra,
			}),
		}),
	);

function loggedFeatureKey(): unknown {
	return mocks.logAiUsage.mock.calls[0][0].featureKey;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("POST /api/internal/ai-usage — agent feature keys", () => {
	it.each([
		["project_document_generator", "document-generation"],
		["project_document_generator:budget_gate", "document-generation"],
		["project_document_generator:truncation_retry", "document-generation"],
		["backlog_updater", "backlog-update"],
	])("tags %s as %s", async (agentId, featureKey) => {
		expect((await usage({ agentId })).status).toBe(200);
		expect(loggedFeatureKey()).toBe(featureKey);
	});

	it("leaves an agent outside the mapping untagged", async () => {
		await usage({ agentId: "data_analyst" });
		expect(loggedFeatureKey()).toBeUndefined();
	});

	it("does not resolve an inherited property name as a feature", async () => {
		await usage({ agentId: "constructor" });
		expect(loggedFeatureKey()).toBeUndefined();
	});

	it("keeps the feature key the agent sent", async () => {
		await usage({
			agentId: "project_document_generator",
			featureKey: "clean-spec",
		});
		expect(loggedFeatureKey()).toBe("clean-spec");
	});
});
