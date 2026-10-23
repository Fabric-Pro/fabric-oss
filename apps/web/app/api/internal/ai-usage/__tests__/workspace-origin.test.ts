import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	verifyAIToken: vi.fn(),
	getProjectAccessContext: vi.fn(),
	getAccessibleFrameById: vi.fn(),
	logAiUsage: vi.fn(),
}));

vi.mock("@repo/ai-token", () => ({
	AI_TOKEN_HEADER: "X-AI-Token",
	verifyAIToken: mocks.verifyAIToken,
}));
vi.mock("@repo/database", () => ({
	getModelByCanonicalName: vi.fn(async () => null),
	getCanonicalNameForProviderModelId: vi.fn(async () => null),
	getProjectAccessContext: mocks.getProjectAccessContext,
	getAccessibleFrameById: mocks.getAccessibleFrameById,
	logAiUsage: mocks.logAiUsage,
	getChatGptPlanOrgAccount: vi.fn(),
}));

import { POST } from "../route";

function usage(extra: Record<string, unknown> = {}) {
	return POST(
		new Request("http://localhost/api/internal/ai-usage", {
			method: "POST",
			headers: {
				"X-AI-Token": "token-example",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				provider: "VERCEL_GATEWAY",
				model: "example-model",
				taskType: "COMPLEX",
				inputTokens: 10,
				outputTokens: 2,
				totalTokens: 12,
				...extra,
			}),
		}),
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.verifyAIToken.mockResolvedValue({
		valid: true,
		claims: { sub: "user-example", org: "org-example" },
	});
	mocks.getProjectAccessContext.mockResolvedValue({
		organizationId: "org-example",
	});
	mocks.getAccessibleFrameById.mockResolvedValue({
		id: "frame-example",
		projectId: "project-example",
	});
});

describe("delegated workspace usage origin", () => {
	it("logs a frame only after token-user, tenant and project access validation", async () => {
		expect(
			(
				await usage({
					frameId: "frame-example",
					projectId: "project-example",
					conversationId: "conversation-example",
					featureKey: "chat-agent",
				})
			).status,
		).toBe(200);
		expect(mocks.getProjectAccessContext).toHaveBeenCalledWith(
			"project-example",
			"user-example",
		);
		expect(mocks.getAccessibleFrameById).toHaveBeenCalledWith({
			id: "frame-example",
			userId: "user-example",
			organizationId: "org-example",
		});
		expect(mocks.logAiUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-example",
				organizationId: "org-example",
				projectId: "project-example",
				frameId: "frame-example",
				conversationId: "conversation-example",
				featureKey: "chat-agent",
			}),
		);
	});

	it.each(["unknown-frame", "foreign-tenant-frame", "inaccessible-frame"])(
		"rejects %s before logging",
		async (frameId) => {
			mocks.getAccessibleFrameById.mockResolvedValue(null);
			expect(
				(await usage({ frameId, projectId: "project-example" })).status,
			).toBe(403);
			expect(mocks.logAiUsage).not.toHaveBeenCalled();
		},
	);

	it.each(["project-other", undefined])(
		"rejects an accessible frame attached to another project (%s)",
		async (projectId) => {
			expect(
				(await usage({ frameId: "frame-example", projectId })).status,
			).toBe(403);
			expect(mocks.logAiUsage).not.toHaveBeenCalled();
		},
	);

	it("rejects a frame when its claimed project is inaccessible", async () => {
		mocks.getProjectAccessContext.mockResolvedValue(null);
		expect(
			(
				await usage({
					frameId: "frame-example",
					projectId: "project-example",
				})
			).status,
		).toBe(403);
		expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
		expect(mocks.logAiUsage).not.toHaveBeenCalled();
	});

	it("rejects a frame without a token organization", async () => {
		mocks.verifyAIToken.mockResolvedValue({
			valid: true,
			claims: { sub: "user-example" },
		});
		expect((await usage({ frameId: "frame-example" })).status).toBe(403);
		expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
		expect(mocks.logAiUsage).not.toHaveBeenCalled();
	});

	it("accepts an accessible unattached frame with an authorized project", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue({
			id: "frame-example",
			projectId: null,
		});
		expect(
			(
				await usage({
					frameId: "frame-example",
					projectId: "project-example",
				})
			).status,
		).toBe(200);
	});

	it("rejects an accessible foreign-tenant project beside an unattached frame", async () => {
		mocks.getProjectAccessContext.mockResolvedValue({
			organizationId: "org-other",
		});
		mocks.getAccessibleFrameById.mockResolvedValue({
			id: "frame-example",
			projectId: null,
		});
		const response = await usage({
			frameId: "frame-example",
			projectId: "project-other",
		});
		expect(response.status).toBe(403);
		expect(mocks.getProjectAccessContext).toHaveBeenCalledWith(
			"project-other",
			"user-example",
		);
		expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
		expect(mocks.logAiUsage).not.toHaveBeenCalled();
	});

	it("drops a foreign-tenant project from a legacy request without a frame", async () => {
		mocks.getProjectAccessContext.mockResolvedValue({
			organizationId: "org-other",
		});
		expect((await usage({ projectId: "project-other" })).status).toBe(200);
		expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
		expect(mocks.logAiUsage).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: undefined }),
		);
	});

	it.each([undefined, null])(
		"drops an organization project when the token organization is missing (%s)",
		async (organizationId) => {
			mocks.verifyAIToken.mockResolvedValue({
				valid: true,
				claims: { sub: "user-example", org: organizationId },
			});
			const response = await usage({ projectId: "project-example" });
			expect(response.status).toBe(200);
			expect(mocks.logAiUsage).toHaveBeenCalledWith(
				expect.objectContaining({ projectId: undefined }),
			);
		},
	);

	it("drops an organizationless project from an organization token", async () => {
		mocks.getProjectAccessContext.mockResolvedValue({
			organizationId: null,
		});
		const response = await usage({ projectId: "project-example" });
		expect(response.status).toBe(200);
		expect(mocks.logAiUsage).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: undefined }),
		);
	});

	it.each([
		{ frameId: "" },
		{ frameId: "x".repeat(201) },
		{ featureKey: "invented-feature" },
	])("rejects malformed attribution %j", async (extra) => {
		expect((await usage(extra)).status).toBe(400);
		expect(mocks.logAiUsage).not.toHaveBeenCalled();
	});

	it("preserves legacy project access behavior and skips frame lookup when absent", async () => {
		mocks.getProjectAccessContext.mockResolvedValue(null);
		expect((await usage({ projectId: "project-other" })).status).toBe(200);
		expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
		expect(mocks.logAiUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: undefined,
				frameId: undefined,
			}),
		);
	});
});
