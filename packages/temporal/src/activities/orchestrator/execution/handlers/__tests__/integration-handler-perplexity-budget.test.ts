import { estimateLanguageRequestInputTokens } from "@repo/ai/lib/turn-budget-estimate";
import { runWithDispatchGuard } from "@repo/utils/dispatch-guard";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContext, buildInput } from "./integration-handler-fixtures";

vi.mock("@repo/database", () => ({
	fetchCredentialsByIdAndProviderInTenant: vi.fn(async () => ({
		PERPLEXITY_API_KEY: "example-key",
	})),
	fetchCredentialsByProvider: vi.fn(),
}));
vi.mock("../../../../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: vi.fn(async () => null),
}));
vi.mock("../../authority-gate", () => ({
	checkIntegrationAuthority: vi.fn(async () => ({ authorized: true })),
}));
vi.mock("../../../../shared/oauth-tool-executors", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));
vi.mock("@repo/integrations/executor-registry", () => ({
	isRegisteredIntegrationProvider: () => false,
	listRegisteredIntegrationProviders: () => [],
	getIntegrationOperationKeywords: () => [],
	listIntegrationOperationNames: () => [],
	resolveIntegrationOperation: () => undefined,
	executeRegisteredIntegrationOperation: vi.fn(),
}));
vi.mock("@repo/integrations/gitlab", () => ({
	getGitLabApiCredential: vi.fn(),
	gitlabOutboundFetch: vi.fn(),
}));

import { IntegrationHandler } from "../integration-handler";

afterEach(() => vi.unstubAllGlobals());
describe("Perplexity turn reservations", () => {
	it("leaves max_tokens absent without a ledger", async () => {
		let body: Record<string, unknown> = {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				body = JSON.parse(init.body as string);
				return Response.json({
					choices: [{ message: { content: "answer" } }],
				});
			}),
		);
		const result = await new IntegrationHandler().execute(
			buildContext(
				buildInput("PERPLEXITY", { inputs: { query: "test query" } }),
			),
		);
		expect(result.handled).toBe(true);
		expect(body.model).toBe("llama-3.1-sonar-small-128k-online");
		expect(body).not.toHaveProperty("max_tokens");
	});
	it.each([true, false])(
		"reserves before fetch, applies the cap, complete usage=%s",
		async (complete) => {
			const reserve = vi.fn(async () => ({
				attemptId: "search-attempt",
				outputCap: 512,
			}));
			const budget = {
				reserve,
				settle: vi.fn(async () => {}),
				markUnknown: vi.fn(async () => {}),
				release: vi.fn(async () => {}),
			};
			let atSend = 0;
			let body: Record<string, unknown> = {};
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_url: unknown, init: RequestInit) => {
					atSend = reserve.mock.calls.length;
					body = JSON.parse(init.body as string);
					return Response.json({
						choices: [{ message: { content: "answer" } }],
						usage: {
							prompt_tokens: 7,
							...(complete ? { completion_tokens: 9 } : {}),
						},
					});
				}),
			);
			const result = await runWithDispatchGuard(
				{
					key: "example-turn",
					assertDispatchable: async () => {},
					abortSignal: () => undefined,
					rethrowIfStopped: () => {},
					budget,
				},
				() =>
					new IntegrationHandler().execute(
						buildContext(
							buildInput("PERPLEXITY", {
								inputs: { query: "test query" },
							}),
						),
					),
			);
			expect(result.handled).toBe(true);
			expect(atSend).toBe(1);
			expect(reserve).toHaveBeenCalledWith(
				expect.objectContaining({
					modality: "language",
					inputEstimate: estimateLanguageRequestInputTokens({
						prompt: [{ content: "test query" }],
					}),
					requestedOutputTokens: 2048,
					minOutputTokens: 256,
					enforcesOutputCap: true,
				}),
			);
			expect(body).toMatchObject({
				model: "llama-3.1-sonar-small-128k-online",
				max_tokens: 512,
			});
			if (complete) {
				expect(budget.settle).toHaveBeenCalledWith("search-attempt", {
					inputTokens: 7,
					outputTokens: 9,
				});
			} else {
				expect(budget.markUnknown).toHaveBeenCalledWith(
					"search-attempt",
				);
				expect(budget.settle).not.toHaveBeenCalled();
			}
		},
	);
});
