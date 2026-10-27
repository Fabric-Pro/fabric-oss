import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	logAiUsage: vi.fn(),
	recordAiOutputProvenance: vi.fn(),
	getProjectAccessContext: vi.fn(),
	claims: { sub: "example-user", org: "example-org" as string | undefined },
}));
vi.mock("@repo/ai-token", () => ({
	AI_TOKEN_HEADER: "X-AI-Token",
	verifyAIToken: async () => ({ valid: true, claims: mocks.claims }),
}));
vi.mock("@repo/database", () => ({
	logAiUsage: mocks.logAiUsage,
	recordAiOutputProvenance: mocks.recordAiOutputProvenance,
	getProjectAccessContext: mocks.getProjectAccessContext,
	getCanonicalNameForProviderModelId: async () => "example-canonical-model",
	getModelByCanonicalName: vi.fn(),
	getChatGptPlanOrgAccount: vi.fn(),
}));
const { POST } = await import("../route");
const replyId = "msg_1793000000000_0123456789abcdef0123456789abcdef";
const usage = (extra: Record<string, unknown> = {}) =>
	POST(
		new Request("http://localhost/api/internal/ai-usage", {
			method: "POST",
			headers: {
				"X-AI-Token": "example-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				provider: "VERCEL_GATEWAY",
				model: "example-vendor/example-model",
				taskType: "TOOL_CALLING",
				inputTokens: 10,
				outputTokens: 2,
				totalTokens: 12,
				agentId: "project_document_generator",
				projectId: "example-project",
				outputMessageId: replyId,
				...extra,
			}),
		}),
	);
beforeEach(() => {
	vi.clearAllMocks();
	mocks.claims.org = "example-org";
	mocks.logAiUsage.mockResolvedValue(undefined);
	mocks.recordAiOutputProvenance.mockResolvedValue(undefined);
	mocks.getProjectAccessContext.mockResolvedValue({
		organizationId: "example-org",
	});
});
describe("Copilot output provenance", () => {
	it("uses token identity and the route's canonical model, without binding a prompt", async () => {
		expect(
			(
				await usage({
					userId: "example-forged-user",
					organizationId: "example-forged-org",
					modelCanonicalName: "forged",
					promptVersionId: "example-bound-prompt",
				})
			).status,
		).toBe(200);
		expect(mocks.recordAiOutputProvenance).toHaveBeenCalledWith({
			organizationId: "example-org",
			userId: "example-user",
			projectId: "example-project",
			subjectType: "copilot-message",
			subjectId: replyId,
			agentId: "project_document_generator",
			modelCanonicalName: "example-canonical-model",
		});
	});
	it.each([null, { organizationId: "example-other-org" }])(
		"drops an unverified project (%j), following usage logging",
		async (access) => {
			mocks.getProjectAccessContext.mockResolvedValue(access);
			expect((await usage()).status).toBe(200);
			expect(mocks.recordAiOutputProvenance).toHaveBeenCalledWith(
				expect.objectContaining({ projectId: undefined }),
			);
			expect(mocks.logAiUsage).toHaveBeenCalledWith(
				expect.objectContaining({ projectId: undefined }),
			);
		},
	);
	it.each([
		"msg_1793000000000",
		"msg_1_bad",
		"msg_1793000000000_0123456789abcdef0123456789abcdef\n",
		42,
		null,
		{},
		"x".repeat(1000),
	])("ignores malformed reply id %j without losing usage", async (id) => {
		expect((await usage({ outputMessageId: id })).status).toBe(200);
		expect(mocks.recordAiOutputProvenance).not.toHaveBeenCalled();
		expect(mocks.logAiUsage).toHaveBeenCalledOnce();
	});
	it("keeps usage successful when provenance fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.recordAiOutputProvenance.mockRejectedValueOnce(
			new Error("example-write-failure"),
		);
		expect((await usage()).status).toBe(200);
		expect(mocks.logAiUsage).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("provenance"),
			expect.anything(),
		);
		warn.mockRestore();
	});
	it("does not create an organizationless provenance row", async () => {
		mocks.claims.org = undefined;
		expect((await usage({ projectId: undefined })).status).toBe(200);
		expect(mocks.recordAiOutputProvenance).not.toHaveBeenCalled();
	});
	it("accepts unknown fields for mixed-version rollout compatibility", async () => {
		expect((await usage({ futureUsageField: "example" })).status).toBe(200);
	});
});
