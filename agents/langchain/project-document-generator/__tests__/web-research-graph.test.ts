/**
 * Web research through the compiled graph: a scripted model searches once
 * and then writes the document, over a mocked fetch. Proves that the tool
 * node's outcome reaches graph state through the state reducers, and that
 * consecutive runs sharing the same cached tool node each start their
 * research count from zero.
 */

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { modelInvoke } = vi.hoisted(() => ({ modelInvoke: vi.fn() }));

vi.mock("../utils", async () => ({
	...(await vi.importActual<typeof import("../utils")>("../utils")),
	getAgentModelAsync: vi.fn().mockResolvedValue({
		bindTools: vi.fn().mockImplementation(function (this: unknown) {
			return this;
		}),
		invoke: (...args: unknown[]) => modelInvoke(...args),
	}),
	extractProviderConfig: vi.fn().mockReturnValue({ model: "gpt-4o" }),
	summarizeMessagesForLogging: vi.fn().mockReturnValue([]),
}));

vi.mock("../prompts", async () => ({
	...(await vi.importActual<typeof import("../prompts")>("../prompts")),
	buildSystemPromptAsync: vi.fn().mockResolvedValue("Test system prompt"),
}));

vi.mock("@repo/agent-core/services/usage-logging", async () => ({
	...(await vi.importActual<
		typeof import("@repo/agent-core/services/usage-logging")
	>("@repo/agent-core/services/usage-logging")),
	logAgentUsageFromRunnableConfig: vi.fn().mockResolvedValue(undefined),
}));

const { projectDocumentGeneratorGraph } = await import("../agent");
const { emptyWebResearchOutcome } = await import("../nodes/web-research");

/** An unsigned JWT-shaped token; the agent reads its claims without verifying. */
function tokenWith(payload: Record<string, unknown>): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`;
}

const RESEARCH_TOKEN = tokenWith({ sub: "user-1", org: "org-1", wr: true });

const fetchMock = vi.fn();

function searchResponse(): Response {
	return new Response(
		JSON.stringify({
			ok: true,
			provider: "example-search",
			results: [
				{
					url: "https://example.com/benchmark",
					title: "Industry benchmark",
					snippet: "Median adoption rose in 2025.",
				},
			],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

/**
 * The model calls `web_search` once, then writes the document once it has
 * seen a search result.
 */
function scriptModel(callName = "web_search") {
	let call = 0;
	modelInvoke.mockImplementation(async (messages: unknown[]) => {
		call++;
		const sawResult = messages.some(
			(message) =>
				message instanceof ToolMessage && message.name === callName,
		);
		if (!sawResult && call < 5) {
			return new AIMessage({
				content: "",
				tool_calls: [
					{
						id: `research-${call}`,
						name: callName,
						args: {
							query: "document automation adoption benchmarks",
						},
					},
				],
			});
		}
		return new AIMessage({
			content: "",
			tool_calls: [
				{
					id: `write-${call}`,
					name: "write_document_local",
					args: {
						document: "# Business Case\n\nAdoption is rising.",
					},
				},
			],
		});
	});
}

function runInput(allowWebResearch: boolean) {
	return {
		messages: [new HumanMessage({ content: "Write the business case" })],
		documentType: "general" as const,
		projectId: "project-1",
		userId: "user-1",
		organizationId: "org-1",
		allowWebResearch,
		webResearchOutcome: emptyWebResearchOutcome(allowWebResearch),
		webResearchSearchedUrls: [],
	};
}

const runConfig = {
	recursionLimit: 25,
	configurable: { ai_token: RESEARCH_TOKEN },
};

beforeEach(() => {
	fetchMock.mockReset();
	fetchMock.mockImplementation(async () => searchResponse());
	vi.stubGlobal("fetch", fetchMock);
	modelInvoke.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("web research through the compiled graph", () => {
	it("starts every run's research count from zero", async () => {
		for (const run of [1, 2]) {
			scriptModel();
			const result = await projectDocumentGeneratorGraph.invoke(
				runInput(true),
				runConfig,
			);
			expect(result.webResearchOutcome, `run ${run}`).toMatchObject({
				authorized: true,
				searches: 1,
				searchFailures: 0,
				limitReached: false,
			});
			expect(result.webResearchSearchedUrls, `run ${run}`).toEqual([
				"https://example.com/benchmark",
			]);
		}
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("refuses an invented search in a run without research, without fetching", async () => {
		scriptModel();
		const result = await projectDocumentGeneratorGraph.invoke(
			runInput(false),
			runConfig,
		);

		expect(fetchMock).not.toHaveBeenCalled();
		const refusal = result.messages.find(
			(message: unknown) =>
				message instanceof ToolMessage && message.name === "web_search",
		) as ToolMessage | undefined;
		expect(refusal?.content).toContain("not authorized");
		expect(result.webResearchOutcome).toMatchObject({
			authorized: false,
			searches: 0,
		});
	});
});
