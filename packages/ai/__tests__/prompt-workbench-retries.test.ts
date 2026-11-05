import { APICallError, generateObject, generateText, zodSchema } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ member: vi.fn(), model: vi.fn() }));
vi.mock("@repo/database", () => ({ db: { member: { findFirst: m.member } } }));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: m.model,
	generateObject,
	generateText,
	zodSchema,
}));
vi.mock("../../api/lib/chatgpt-plan-errors", () => ({
	rethrowChatGptPlanRefusal: vi.fn(),
}));

import {
	assistPrompt,
	tryPrompt,
} from "../../api/modules/prompts/lib/workbench";

beforeEach(() => {
	vi.clearAllMocks();
	m.member.mockResolvedValue({ role: "admin" });
});
it.each(["assist", "preview"])(
	"makes one underlying provider attempt for retryable %s failures",
	async (mode) => {
		const attempt = vi.fn(async () => {
			throw new APICallError({
				message: "Example provider overloaded",
				url: "https://provider.example.com",
				requestBodyValues: {},
				statusCode: 503,
				isRetryable: true,
			});
		});
		m.model.mockResolvedValue({
			model: new MockLanguageModelV4({ doGenerate: attempt }),
			trackUsage: vi.fn(),
		});
		const actor = { userId: "example-user", organizationId: "example-org" };
		const draft = {
			name: "Example",
			format: "MARKDOWN",
			content: "Summarize supplied notes.",
		};
		await expect(
			mode === "assist"
				? assistPrompt(actor, { draft, message: "Improve clarity" })
				: tryPrompt(actor, { draft }),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(attempt).toHaveBeenCalledTimes(1);
	},
);
