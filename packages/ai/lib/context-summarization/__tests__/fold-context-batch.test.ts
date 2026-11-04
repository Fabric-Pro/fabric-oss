import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the model resolution + AI SDK so the fold runs offline. generateText's
// returned object is what the fold assembles + sanitizes.
const { generateTextMock } = vi.hoisted(() => ({
	generateTextMock: vi.fn(),
}));
vi.mock("ai", () => ({
	Output: { object: (spec: unknown) => spec },
	generateText: generateTextMock,
}));
vi.mock("../../dynamic-model-selector", () => ({
	getAIModelWithMetadata: vi.fn(async () => ({
		model: {},
		metadata: {
			modelString: "test-model",
			provider: "openai",
			canonicalName: "test-model",
		},
		trackUsage: vi.fn(),
	})),
}));
vi.mock("../prompt-cache", () => ({
	cacheableSystem: (text: string) => ({ role: "system", content: text }),
}));
// The fold prices each call via estimateAiUsageCostUsd (a real @repo/database
// export); stub it so the test runs offline. 0.0005 USD → 500 micro-USD.
vi.mock("@repo/database", () => ({
	estimateAiUsageCostUsd: vi.fn(async () => 0.0005),
}));

import {
	FORMATTING_GUIDANCE,
	foldContextBatch,
	SYSTEM_GUIDANCE,
} from "../summarize-project-context";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("foldContextBatch — roadmap + code-repo citations", () => {
	it("keeps context/decision/roadmap/repo markers and strips invented ones", async () => {
		// The model cites a context (S1), decision (S2), roadmap (S3), repo (S4),
		// and one hallucinated marker (S99) that was never supplied.
		generateTextMock.mockResolvedValue({
			output: {
				goalsAndScope:
					"Ship the thing [S1]; direction from roadmap [S3].",
				keyDecisions: "Adopted Postgres [S2].",
				technicalContext: "Built on repo [S4].",
				constraintsAndNonGoals: "",
				historyTimeline: "",
				openItems: "Invented citation [S99] must be stripped.",
			},
		});

		const result = await foldContextBatch({
			projectName: "Proj",
			tenancy: { userId: "u1", organizationId: null },
			runningSummary: null,
			batchSources: [
				{
					marker: "S1",
					type: "TEXT",
					timestamp: "2026-07-10T00:00:00.000Z",
					label: "note",
					content: "some raw note",
				},
			],
			carriedReferences: [],
			decisions: [
				{
					marker: "S2",
					title: "Use Postgres",
					decision: "Postgres only",
					rationale: "integrity",
				},
			],
			roadmapItems: [
				{
					marker: "S3",
					title: "Auth revamp",
					kind: "FEATURE",
					status: "In Progress",
					priority: "P1_HIGH",
				},
			],
			codeRepos: [
				{
					marker: "S4",
					label: "acme/app",
					provider: "GITHUB",
					branch: "main",
					language: "TypeScript",
				},
			],
			includeProjectSources: true,
		});

		expect(result.model).toBe("test-model");
		// Roadmap (S3) and repo (S4) markers survive → they were in the allowed set.
		expect(result.citedMarkers.sort()).toEqual(["S1", "S2", "S3", "S4"]);
		expect(result.content).toContain("[S3]");
		expect(result.content).toContain("[S4]");
		// The invented marker is stripped.
		expect(result.content).not.toContain("[S99]");
		expect(result.citedMarkers).not.toContain("S99");

		// The prompt actually included the roadmap + codebase blocks.
		const userMsg = generateTextMock.mock.calls[0][0].messages[0].content;
		expect(userMsg).toContain("PROJECT ROADMAP");
		expect(userMsg).toContain("CONNECTED CODE REPOSITORY");
		expect(userMsg).toContain("Auth revamp");
		expect(userMsg).toContain("acme/app");
	});

	it("omits roadmap/repo blocks when none are supplied", async () => {
		generateTextMock.mockResolvedValue({
			output: { goalsAndScope: "Just context [S1]." },
		});

		await foldContextBatch({
			projectName: "Proj",
			tenancy: { userId: "u1", organizationId: null },
			runningSummary: null,
			batchSources: [
				{
					marker: "S1",
					type: "TEXT",
					timestamp: "2026-07-10T00:00:00.000Z",
					label: null,
					content: "raw",
				},
			],
			carriedReferences: [],
			decisions: [],
			roadmapItems: [],
			codeRepos: [],
			includeProjectSources: true,
		});

		const userMsg = generateTextMock.mock.calls[0][0].messages[0].content;
		expect(userMsg).not.toContain("PROJECT ROADMAP");
		expect(userMsg).not.toContain("CONNECTED CODE REPOSITORY");
	});
});

describe("foldContextBatch — usage + system prompt", () => {
	const baseInput = {
		projectName: "Proj",
		tenancy: { userId: "u1", organizationId: null },
		runningSummary: null,
		batchSources: [
			{
				marker: "S1",
				type: "TEXT",
				timestamp: "2026-07-10T00:00:00.000Z",
				label: null,
				content: "raw",
			},
		],
		carriedReferences: [],
		decisions: [],
		roadmapItems: [],
		codeRepos: [],
		includeProjectSources: true,
	};

	it("returns real token usage + priced cost from the model result", async () => {
		generateTextMock.mockResolvedValue({
			output: { goalsAndScope: "Just context [S1]." },
			usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
		});

		const result = await foldContextBatch({ ...baseInput });

		expect(result.usage).toEqual({
			inputTokens: 120,
			outputTokens: 40,
			totalTokens: 160,
			costMicroUsd: 500,
		});
	});

	it("defaults usage to zero when the model reports none", async () => {
		generateTextMock.mockResolvedValue({
			output: { goalsAndScope: "Just context [S1]." },
		});

		const result = await foldContextBatch({ ...baseInput });

		expect(result.usage.inputTokens).toBe(0);
		expect(result.usage.outputTokens).toBe(0);
	});

	it("uses the provided systemPrompt over the built-in guidance", async () => {
		generateTextMock.mockResolvedValue({
			output: { goalsAndScope: "x [S1]." },
		});

		await foldContextBatch({
			...baseInput,
			systemPrompt: "CUSTOM DB PROMPT",
		});

		const systemMsg =
			generateTextMock.mock.calls[0][0].instructions.content;
		// The admin prompt replaces the content guidance; the built-in guidance
		// is not used (only the formatting contract is always appended below).
		expect(systemMsg).toContain("CUSTOM DB PROMPT");
		expect(systemMsg).not.toContain(SYSTEM_GUIDANCE);
	});

	it("falls back to the built-in guidance when no systemPrompt is given", async () => {
		generateTextMock.mockResolvedValue({
			output: { goalsAndScope: "x [S1]." },
		});

		await foldContextBatch({ ...baseInput });

		const systemMsg =
			generateTextMock.mock.calls[0][0].instructions.content;
		expect(systemMsg).toContain(SYSTEM_GUIDANCE);
	});

	it("always appends the formatting contract, on top of either prompt", async () => {
		generateTextMock.mockResolvedValue({
			output: { goalsAndScope: "x [S1]." },
		});

		// Built-in guidance path.
		await foldContextBatch({ ...baseInput });
		const builtinMsg =
			generateTextMock.mock.calls[0][0].instructions.content;
		expect(builtinMsg).toContain(FORMATTING_GUIDANCE);

		// Admin DB-prompt path still gets the formatting contract.
		await foldContextBatch({
			...baseInput,
			systemPrompt: "CUSTOM DB PROMPT",
		});
		const dbMsg = generateTextMock.mock.calls[1][0].instructions.content;
		expect(dbMsg).toContain("CUSTOM DB PROMPT");
		expect(dbMsg).toContain(FORMATTING_GUIDANCE);
	});

	// Fizzy #2527: a `role: "system"` entry inside `messages` triggers an AI
	// SDK warning (and AI SDK 7 will reject the call outright). The system
	// guidance must travel through the top-level `system` option instead.
	it("passes the system guidance via `system`, never as a `messages` row", async () => {
		generateTextMock.mockResolvedValue({
			output: { goalsAndScope: "x [S1]." },
		});

		await foldContextBatch({ ...baseInput });

		const callArgs = generateTextMock.mock.calls[0][0];
		expect(callArgs.instructions).toEqual(
			expect.objectContaining({
				role: "system",
				content: expect.stringContaining(SYSTEM_GUIDANCE),
			}),
		);
		expect(
			callArgs.messages.some(
				(m: { role: string }) => m.role === "system",
			),
		).toBe(false);
	});
});
