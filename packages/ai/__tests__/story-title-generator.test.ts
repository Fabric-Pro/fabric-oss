import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGenerateText,
	mockGenerateObject,
	mockGetAIModelWithMetadata,
	mockLogModelUsageAsync,
	mockGetBoundPromptForAgent,
	mockProjectFindUnique,
	mockLoggerInfo,
	mockLoggerWarn,
} = vi.hoisted(() => ({
	mockGenerateText: vi.fn(),
	mockGenerateObject: vi.fn(),
	mockGetAIModelWithMetadata: vi.fn(),
	mockLogModelUsageAsync: vi.fn(),
	mockGetBoundPromptForAgent: vi.fn(),
	mockProjectFindUnique: vi.fn(),
	mockLoggerInfo: vi.fn(),
	mockLoggerWarn: vi.fn(),
}));

vi.mock("ai", () => ({
	generateText: (args: unknown) => mockGenerateText(args),
	generateObject: (args: unknown) => mockGenerateObject(args),
}));

vi.mock("../lib/dynamic-model-selector", async () => {
	const actual = await vi.importActual<
		typeof import("../lib/dynamic-model-selector")
	>("../lib/dynamic-model-selector");
	return {
		...actual,
		getAIModelWithMetadata: (...args: unknown[]) =>
			mockGetAIModelWithMetadata(...args),
	};
});

vi.mock("../lib/usage-logging", () => ({
	logModelUsageAsync: (...args: unknown[]) => mockLogModelUsageAsync(...args),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		getBoundPromptForAgent: (...args: unknown[]) =>
			mockGetBoundPromptForAgent(...args),
		db: {
			project: {
				findUnique: (...args: unknown[]) =>
					mockProjectFindUnique(...args),
			},
		},
	};
});

vi.mock("@repo/logs", () => ({
	logger: {
		info: mockLoggerInfo,
		warn: mockLoggerWarn,
		error: vi.fn(),
	},
}));

import { AIProviderNotConfiguredError } from "../lib/dynamic-model-selector";
import { promptGenerateStoryTitle } from "../lib/prompts";
import {
	cleanGeneratedStoryTitle,
	formatTimestamp,
	generateStoryTitleFromDescription,
	mapCreationSource,
} from "../lib/story-title-generator";

const STUB_MODEL = { provider: "test" } as const;
const STUB_METADATA = {
	provider: "OPENAI_DIRECT",
	configId: "cfg",
	modelString: "gpt-4o-mini",
	canonicalName: "gpt-4o-mini",
	billingMode: "external_byok",
	billingCustomerId: null,
} as const;

const STUB_USAGE = {
	inputTokens: 50,
	outputTokens: 5,
	totalTokens: 55,
};

const STUB_CONTEXT = {
	userId: "user-1",
	organizationId: "org-1",
	projectId: "project-1",
};

const STUB_PROMPT_BINDING = {
	key: "story_title_generator",
	format: "HANDLEBARS",
	version: { content: "TEMPLATE BODY {{description}}" },
};

// Snapshot whatever AI_TITLE_GENERATION_ENABLED looks like on the host so we
// can restore it between tests. Kill-switch tests set/unset this env var.
const ORIGINAL_KILL_SWITCH = process.env.AI_TITLE_GENERATION_ENABLED;

beforeEach(() => {
	mockGenerateText.mockReset();
	mockGenerateObject.mockReset();
	mockGetAIModelWithMetadata.mockReset();
	mockLogModelUsageAsync.mockReset();
	mockGetBoundPromptForAgent.mockReset();
	mockProjectFindUnique.mockReset();
	mockLoggerInfo.mockReset();
	mockLoggerWarn.mockReset();
	mockGetAIModelWithMetadata.mockResolvedValue({
		model: STUB_MODEL,
		metadata: STUB_METADATA,
		trackUsage: vi.fn(),
	});
	mockGetBoundPromptForAgent.mockResolvedValue(STUB_PROMPT_BINDING);
	mockProjectFindUnique.mockResolvedValue(null);
	// Default: existing `generateText`-based tests stub `mockGenerateText`
	// directly and rely on `generateObject` THROWING so the helper falls
	// back. Tests targeting the primary `generateObject` path override this
	// per-test with `mockGenerateObject.mockResolvedValue(...)`.
	mockGenerateObject.mockRejectedValue(
		new Error(
			"[test default] generateObject not stubbed — falling back to generateText path",
		),
	);
});

afterEach(() => {
	vi.clearAllMocks();
	if (ORIGINAL_KILL_SWITCH === undefined) {
		delete process.env.AI_TITLE_GENERATION_ENABLED;
	} else {
		process.env.AI_TITLE_GENERATION_ENABLED = ORIGINAL_KILL_SWITCH;
	}
});

describe("cleanGeneratedStoryTitle", () => {
	it("strips wrapping double quotes", () => {
		expect(cleanGeneratedStoryTitle('"Add login flow"')).toBe(
			"Add login flow",
		);
	});

	it("strips wrapping single quotes", () => {
		expect(cleanGeneratedStoryTitle("'Add login flow'")).toBe(
			"Add login flow",
		);
	});

	it("trims whitespace", () => {
		expect(cleanGeneratedStoryTitle("   Add login flow   ")).toBe(
			"Add login flow",
		);
	});

	it("sentence-cases only the first letter (rest unchanged)", () => {
		expect(cleanGeneratedStoryTitle("add SSO support")).toBe(
			"Add SSO support",
		);
	});

	it("strips a single trailing period", () => {
		expect(cleanGeneratedStoryTitle("Add login flow.")).toBe(
			"Add login flow",
		);
	});

	it("strips a single trailing exclamation mark", () => {
		expect(cleanGeneratedStoryTitle("Add login flow!")).toBe(
			"Add login flow",
		);
	});

	it("strips a single trailing question mark", () => {
		expect(cleanGeneratedStoryTitle("Why does login fail?")).toBe(
			"Why does login fail",
		);
	});

	it("caps at 255 chars after sentence-case (no ellipsis)", () => {
		const longInput = `${"a".repeat(300)}`;
		const result = cleanGeneratedStoryTitle(longInput);
		expect(result.length).toBe(255);
		expect(result.endsWith("...")).toBe(false);
		// First letter sentence-cased before truncation:
		expect(result[0]).toBe("A");
	});

	it("does not truncate inputs <= 255 chars", () => {
		const exactInput = "a".repeat(255);
		const result = cleanGeneratedStoryTitle(exactInput);
		expect(result.length).toBe(255);
	});

	it("applies steps in order: quote-strip → trim → sentence-case → de-punctuate → cap", () => {
		expect(cleanGeneratedStoryTitle('"   add login flow."')).toBe(
			"Add login flow",
		);
	});

	it("returns empty string for whitespace-only input", () => {
		expect(cleanGeneratedStoryTitle("    ")).toBe("");
	});
});

describe("promptGenerateStoryTitle (legacy export)", () => {
	it("does NOT include any locale string in the prompt", () => {
		const promptFeature = promptGenerateStoryTitle(
			"Add login flow",
			"FEATURE",
		);
		const promptBug = promptGenerateStoryTitle("Login is broken", "BUG");
		expect(promptFeature.toLowerCase()).not.toMatch(
			/locale|language|en[-_][a-z]{2}|de[-_][a-z]{2}/,
		);
		expect(promptBug.toLowerCase()).not.toMatch(
			/locale|language|en[-_][a-z]{2}|de[-_][a-z]{2}/,
		);
		expect(promptFeature).toContain("feature request");
		expect(promptBug).toContain("bug report");
	});
});

describe("mapCreationSource", () => {
	it("maps SLACK → Slack", () => {
		expect(mapCreationSource("SLACK")).toBe("Slack");
	});

	it("maps TEAMS → Teams", () => {
		expect(mapCreationSource("TEAMS")).toBe("Teams");
	});

	it("maps MANUAL → default fallback (UI)", () => {
		expect(mapCreationSource("MANUAL")).toBe("UI");
	});

	it("maps null → default fallback (UI)", () => {
		expect(mapCreationSource(null)).toBe("UI");
	});

	it("maps undefined → default fallback (UI)", () => {
		expect(mapCreationSource(undefined)).toBe("UI");
	});

	it("honors explicit fallback override (API)", () => {
		expect(mapCreationSource(null, "API")).toBe("API");
		expect(mapCreationSource("MANUAL", "API")).toBe("API");
		// SLACK/TEAMS are not affected by fallback
		expect(mapCreationSource("SLACK", "API")).toBe("Slack");
	});
});

describe("formatTimestamp", () => {
	it("renders UTC in YYYY-MM-DD HH:mm with leading-zero pad", () => {
		// 2026-01-01T00:00:00Z
		const frozen = new Date(Date.UTC(2026, 0, 1, 0, 0));
		expect(formatTimestamp(frozen)).toBe("2026-01-01 00:00");
	});

	it("renders mid-year double-digit values", () => {
		// 2026-10-25T13:42:00Z
		const frozen = new Date(Date.UTC(2026, 9, 25, 13, 42));
		expect(formatTimestamp(frozen)).toBe("2026-10-25 13:42");
	});

	it("uses UTC (not local) — drift-resistant assertion", () => {
		const frozen = new Date(Date.UTC(2026, 5, 1, 23, 59));
		expect(formatTimestamp(frozen)).toBe("2026-06-01 23:59");
	});
});

describe("generateStoryTitleFromDescription — generateObject primary path", () => {
	it("uses generateObject when the provider supports structured outputs", async () => {
		mockGenerateObject.mockResolvedValue({
			object: { title: "Add login flow", is_insufficient: false },
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"Users need to be able to log in with their email and password.",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(result).toEqual({
			title: "Add login flow",
			source: "ai",
			isInsufficient: false,
		});
		expect(mockGenerateObject).toHaveBeenCalledOnce();
		// generateText must NOT be called when generateObject succeeds —
		// avoids the double-LLM-spend regression risk.
		expect(mockGenerateText).not.toHaveBeenCalled();
		// And no JSON parse failures should be logged on the happy path —
		// the SDK + provider enforce the shape.
		expect(mockLoggerWarn).not.toHaveBeenCalledWith(
			expect.stringContaining("JSON parse failed"),
			expect.anything(),
		);
	});

	it("generateObject honors is_insufficient=true via provider schema", async () => {
		mockGenerateObject.mockResolvedValue({
			object: { title: "Untitled", is_insufficient: true },
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"x",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(result.source).toBe("untitled-fallback");
		expect(result.isInsufficient).toBe(true);
		expect(result.title).toMatch(
			/^Untitled – \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
		);
	});

	it("generateObject throws → falls back to generateText path", async () => {
		mockGenerateObject.mockRejectedValue(
			new Error("provider does not support structured outputs"),
		);
		mockGenerateText.mockResolvedValue({
			text: JSON.stringify({
				title: "Restore Slack integration in knowledge sources",
				is_insufficient: false,
			}),
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"Slack integration removed from the knowledge sources dropdown.",
			"BUG",
			STUB_CONTEXT,
		);

		expect(result.source).toBe("ai");
		expect(result.title).toBe(
			"Restore Slack integration in knowledge sources",
		);
		// We should log the fallback transition for observability.
		expect(mockLoggerWarn).toHaveBeenCalledWith(
			expect.stringContaining("generateObject failed"),
			expect.anything(),
		);
		// And both LLM calls (generateObject + generateText) should have run.
		expect(mockGenerateObject).toHaveBeenCalledOnce();
		expect(mockGenerateText).toHaveBeenCalledOnce();
	});

	it("generateObject throws AND generateText returns fenced JSON → fence-strip recovers", async () => {
		mockGenerateObject.mockRejectedValue(
			new Error("provider doesn't support structured outputs"),
		);
		mockGenerateText.mockResolvedValue({
			text: '```json\n{"title": "Tidy up the docs sidebar", "is_insufficient": false}\n```',
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"The docs sidebar has duplicate entries.",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(result.source).toBe("ai");
		expect(result.title).toBe("Tidy up the docs sidebar");
	});

	it("generateObject AND generateText both throw → untitled fallback", async () => {
		mockGenerateObject.mockRejectedValue(
			new Error("structured-output unsupported"),
		);
		mockGenerateText.mockRejectedValue(new Error("network blip"));

		const result = await generateStoryTitleFromDescription(
			"This is a clearly long enough description for the fallback.",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(result.source).toBe("untitled-fallback");
		expect(result.title).toMatch(
			/^Untitled – \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
		);
	});
});

describe("generateStoryTitleFromDescription", () => {
	it("happy path JSON returns { title, source: 'ai', isInsufficient: false }", async () => {
		mockGenerateText.mockResolvedValue({
			text: JSON.stringify({
				title: "Add login flow",
				is_insufficient: false,
			}),
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"Users need to be able to log in with their email and password.",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(result).toEqual({
			title: "Add login flow",
			source: "ai",
			isInsufficient: false,
		});
		// The project scope must reach the RESOLVER, not just the caller's own
		// context: the interceptor it installs is what stamps the usage row, and
		// `logModelUsageAsync` has been a no-op since it landed. Asserting the
		// exact pair here is what previously pinned the omission in place.
		// `featureKey` rides the same object for the same reason — the
		// interceptor is the only thing that writes it to the usage row.
		expect(mockGetAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "SIMPLE" },
			{
				userId: STUB_CONTEXT.userId,
				organizationId: STUB_CONTEXT.organizationId,
				projectId: STUB_CONTEXT.projectId,
				featureKey: "regenerate-title",
			},
		);
		expect(mockLogModelUsageAsync).toHaveBeenCalledOnce();
	});

	it("is_insufficient=true → timestamped fallback with isInsufficient=true", async () => {
		mockGenerateText.mockResolvedValue({
			text: JSON.stringify({ title: "Untitled", is_insufficient: true }),
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"hello",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(result.source).toBe("untitled-fallback");
		expect(result.isInsufficient).toBe(true);
		expect(result.title).toMatch(
			/^Untitled – \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
		);
	});

	it("malformed JSON → logger.warn + raw text treated as title", async () => {
		mockGenerateText.mockResolvedValue({
			text: "not json at all",
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"Long enough description text for the test.",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(result.source).toBe("ai");
		expect(result.title).toBe("Not json at all");
		expect(mockLoggerWarn).toHaveBeenCalledWith(
			expect.stringContaining("JSON parse failed"),
			expect.objectContaining({ sample: expect.any(String) }),
		);
	});

	it("JSON wrapped in ```json fence → parsed correctly (Stage 2)", async () => {
		mockGenerateText.mockResolvedValue({
			text: '```json\n{"title": "Restore Slack integration in knowledge sources", "is_insufficient": false}\n```',
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"Slack integration removed from the knowledge sources dropdown after recent UI changes.",
			"BUG",
			STUB_CONTEXT,
		);

		expect(result.source).toBe("ai");
		expect(result.isInsufficient).toBe(false);
		expect(result.title).toBe(
			"Restore Slack integration in knowledge sources",
		);
		// No JSON-parse-failed warning when the fence is the only problem.
		expect(mockLoggerWarn).not.toHaveBeenCalledWith(
			expect.stringContaining("JSON parse failed"),
			expect.anything(),
		);
	});

	it("JSON wrapped in plain ``` fence (no language tag) → parsed correctly", async () => {
		mockGenerateText.mockResolvedValue({
			text: '```\n{"title": "Tidy up the docs sidebar", "is_insufficient": false}\n```',
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"The docs sidebar has duplicate entries and inconsistent indentation.",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(result.source).toBe("ai");
		expect(result.title).toBe("Tidy up the docs sidebar");
	});

	it("JSON preceded by chatter → extracted via Stage 3 object regex", async () => {
		mockGenerateText.mockResolvedValue({
			text: 'Here is the title for your work item:\n{"title": "Add dark-mode toggle to navbar", "is_insufficient": false}',
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"Users have asked for a dark-mode toggle in the top navigation bar.",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(result.source).toBe("ai");
		expect(result.title).toBe("Add dark-mode toggle to navbar");
	});

	it("chatter + ```json fence → both stripped, parsed correctly", async () => {
		mockGenerateText.mockResolvedValue({
			text: 'Sure! Here is the title:\n```json\n{"title": "Fix flaky pagination on roadmap view", "is_insufficient": false}\n```\nLet me know if you want changes.',
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"The roadmap view drops some features when scrolling fast.",
			"BUG",
			STUB_CONTEXT,
		);

		expect(result.source).toBe("ai");
		expect(result.title).toBe("Fix flaky pagination on roadmap view");
	});

	it("is_insufficient=true inside a fenced JSON response → fallback honored", async () => {
		mockGenerateText.mockResolvedValue({
			text: '```json\n{"title": "Untitled", "is_insufficient": true}\n```',
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"x",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(result.source).toBe("untitled-fallback");
		expect(result.isInsufficient).toBe(true);
		expect(result.title).toMatch(
			/^Untitled – \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
		);
	});

	it("JSON array (wrong shape, not a plain object) → falls through to raw text", async () => {
		mockGenerateText.mockResolvedValue({
			text: '["Add login screen", "Add logout button"]',
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"Long enough description text for the test.",
			"FEATURE",
			STUB_CONTEXT,
		);

		// Array is valid JSON but not the {title, is_insufficient} shape,
		// so it routes through the raw-text fallback and gets cleaned/capped.
		expect(result.source).toBe("ai");
		expect(result.title).toMatch(/Add login screen/);
	});

	it("LLM throws → timestamped fallback (no propagation)", async () => {
		mockGenerateText.mockRejectedValue(new Error("network error"));

		const result = await generateStoryTitleFromDescription(
			"This is a clearly long enough description for the fallback.",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(result.source).toBe("untitled-fallback");
		expect(result.title).toMatch(
			/^Untitled – \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
		);
	});

	it("AIProviderNotConfiguredError → timestamped fallback (no propagation)", async () => {
		mockGetAIModelWithMetadata.mockRejectedValue(
			new AIProviderNotConfiguredError("No provider configured"),
		);

		const result = await generateStoryTitleFromDescription(
			"This is a clearly long enough description for the fallback.",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(result.source).toBe("untitled-fallback");
		expect(result.title).toMatch(
			/^Untitled – \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
		);
	});

	it("AI_TITLE_GENERATION_ENABLED=false → never calls LLM; returns timestamped fallback", async () => {
		process.env.AI_TITLE_GENERATION_ENABLED = "false";

		const result = await generateStoryTitleFromDescription(
			"This is a clearly long enough description.",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(result.source).toBe("untitled-fallback");
		expect(result.title).toMatch(
			/^Untitled – \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
		);
		// Kill-switch short-circuits BEFORE any DB/LLM call.
		expect(mockGetAIModelWithMetadata).not.toHaveBeenCalled();
		expect(mockGetBoundPromptForAgent).not.toHaveBeenCalled();
		expect(mockGenerateText).not.toHaveBeenCalled();
	});

	it("AI_TITLE_GENERATION_ENABLED='true' (or unset) → kill-switch does NOT activate", async () => {
		process.env.AI_TITLE_GENERATION_ENABLED = "true";
		mockGenerateText.mockResolvedValue({
			text: JSON.stringify({
				title: "Generated title",
				is_insufficient: false,
			}),
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"This is a long enough description.",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(result.source).toBe("ai");
		expect(mockGenerateText).toHaveBeenCalled();
	});

	it("Prompt not bound (getBoundPromptForAgent → null) → uses in-memory fallback prompt body", async () => {
		mockGetBoundPromptForAgent.mockResolvedValue(null);
		mockGenerateText.mockResolvedValue({
			text: JSON.stringify({
				title: "Generated title",
				is_insufficient: false,
			}),
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"Long description here.",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(result.source).toBe("ai");
		// Helper warns about the missing binding but proceeds.
		expect(mockLoggerWarn).toHaveBeenCalledWith(
			expect.stringContaining("prompt not bound"),
			expect.any(Object),
		);
		// LLM was called with the in-memory fallback body — the rendered
		// prompt should contain the description we passed.
		const callArg = mockGenerateText.mock.calls[0][0] as { prompt: string };
		expect(callArg.prompt).toContain("Long description here.");
	});

	it("PRD fetch throws → continues with empty project_prd_context", async () => {
		mockProjectFindUnique.mockRejectedValue(new Error("DB unavailable"));
		mockGenerateText.mockResolvedValue({
			text: JSON.stringify({
				title: "Title without PRD",
				is_insufficient: false,
			}),
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"Long description here.",
			"FEATURE",
			STUB_CONTEXT,
		);

		// Generation still succeeded — PRD failure is silent.
		expect(result).toEqual({
			title: "Title without PRD",
			source: "ai",
			isInsufficient: false,
		});
		expect(mockLoggerWarn).toHaveBeenCalledWith(
			expect.stringContaining("PRD fetch failed"),
			expect.any(Error),
		);
	});

	it("PRD content longer than 2000 chars → truncated in the rendered prompt", async () => {
		const longPrd = "p".repeat(3000);
		mockProjectFindUnique.mockResolvedValue({
			prdSourceContext: { content: longPrd },
		});
		// Use a minimal template body so PRD char count is isolated.
		mockGetBoundPromptForAgent.mockResolvedValue({
			key: "story_title_generator",
			format: "HANDLEBARS",
			version: { content: "prd: {{project_prd_context}}" },
		});
		mockGenerateText.mockResolvedValue({
			text: JSON.stringify({ title: "Title", is_insufficient: false }),
			usage: STUB_USAGE,
		});

		await generateStoryTitleFromDescription(
			"Long enough description.",
			"FEATURE",
			STUB_CONTEXT,
		);

		const callArg = mockGenerateText.mock.calls[0][0] as { prompt: string };
		const pCount = (callArg.prompt.match(/p/g) ?? []).length;
		expect(pCount).toBeLessThanOrEqual(2010); // small slack for "prd: " prefix
		expect(pCount).toBeGreaterThanOrEqual(1990);
	});

	it("creationSource is rendered into the prompt variables", async () => {
		mockGetBoundPromptForAgent.mockResolvedValue({
			key: "story_title_generator",
			format: "HANDLEBARS",
			version: { content: "creation_source: {{creation_source}}" },
		});
		mockGenerateText.mockResolvedValue({
			text: JSON.stringify({ title: "Title", is_insufficient: false }),
			usage: STUB_USAGE,
		});

		await generateStoryTitleFromDescription("Long enough.", "FEATURE", {
			...STUB_CONTEXT,
			creationSource: "Slack",
		});

		const callArg = mockGenerateText.mock.calls[0][0] as { prompt: string };
		expect(callArg.prompt).toContain("creation_source: Slack");
	});

	it("originContext is truncated to 2000 chars in the rendered prompt", async () => {
		const longOrigin = "o".repeat(3000);
		mockGetBoundPromptForAgent.mockResolvedValue({
			key: "story_title_generator",
			format: "HANDLEBARS",
			version: { content: "origin: {{origin_context}}" },
		});
		mockGenerateText.mockResolvedValue({
			text: JSON.stringify({ title: "Title", is_insufficient: false }),
			usage: STUB_USAGE,
		});

		await generateStoryTitleFromDescription("Long enough.", "FEATURE", {
			...STUB_CONTEXT,
			originContext: longOrigin,
		});

		const callArg = mockGenerateText.mock.calls[0][0] as { prompt: string };
		// Origin body in the rendered prompt should be capped near 2000.
		const oCount = (callArg.prompt.match(/o/g) ?? []).length;
		expect(oCount).toBeLessThanOrEqual(2050);
	});

	it("logger.info is called with isInsufficient flag for ai and fallback paths", async () => {
		// Happy path: isInsufficient=false
		mockGenerateText.mockResolvedValueOnce({
			text: JSON.stringify({ title: "Title", is_insufficient: false }),
			usage: STUB_USAGE,
		});

		await generateStoryTitleFromDescription(
			"Long enough description.",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(mockLoggerInfo).toHaveBeenCalledWith(
			expect.stringContaining("generated"),
			expect.objectContaining({
				feature: "story_title_generation",
				isInsufficient: false,
				source: "ai",
			}),
		);

		mockLoggerInfo.mockReset();

		// Fallback path: isInsufficient=true
		mockGenerateText.mockResolvedValueOnce({
			text: JSON.stringify({ title: "Untitled", is_insufficient: true }),
			usage: STUB_USAGE,
		});

		await generateStoryTitleFromDescription(
			"hello",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(mockLoggerInfo).toHaveBeenCalledWith(
			expect.stringContaining("generated"),
			expect.objectContaining({
				feature: "story_title_generation",
				isInsufficient: true,
				source: "untitled-fallback",
			}),
		);
	});

	it("truncates input description to 1000 chars before prompting", async () => {
		mockGenerateText.mockResolvedValue({
			text: JSON.stringify({
				title: "Generated title",
				is_insufficient: false,
			}),
			usage: STUB_USAGE,
		});
		mockGetBoundPromptForAgent.mockResolvedValue({
			key: "story_title_generator",
			format: "HANDLEBARS",
			version: { content: "description: {{description}}" },
		});

		const longDescription = "x".repeat(1500);
		await generateStoryTitleFromDescription(
			longDescription,
			"FEATURE",
			STUB_CONTEXT,
		);

		const callArg = mockGenerateText.mock.calls[0][0] as { prompt: string };
		expect(callArg.prompt).toContain("...");
		// Description body in prompt is 1000 chars + "..." marker.
		const xCount = (callArg.prompt.match(/x/g) ?? []).length;
		expect(xCount).toBeLessThanOrEqual(1010);
	});

	it("trims and sentence-cases the AI title (regression: pipeline runs)", async () => {
		mockGenerateText.mockResolvedValue({
			text: JSON.stringify({
				title: "add login flow.",
				is_insufficient: false,
			}),
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"This is a long enough description.",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(result.title).toBe("Add login flow");
		expect(result.source).toBe("ai");
	});

	it("rejects parsed JSON title that cleans to empty → timestamped fallback", async () => {
		mockGenerateText.mockResolvedValue({
			text: JSON.stringify({ title: "   ", is_insufficient: false }),
			usage: STUB_USAGE,
		});

		const result = await generateStoryTitleFromDescription(
			"Long enough description for fallback.",
			"FEATURE",
			STUB_CONTEXT,
		);

		expect(result.source).toBe("untitled-fallback");
		expect(result.title).toMatch(
			/^Untitled – \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
		);
	});
});
