/**
 * The runner sends nothing to a model unless the run is confirmed, and its
 * dry run estimates tokens and cost as documented. Every model call here is
 * mocked.
 */
import path from "node:path";
import { MODELS } from "@repo/database/prisma/ai-model-catalog";
import {
	PARLUME_NOTES_MAX_OUTPUT_TOKENS,
	writeAnchoredNotes,
} from "@repo/temporal/parlume-notes-passes";
import { PARLUME_NOTES_FALLBACK_BODY } from "@repo/utils/parlume-notes-prompt";
import { PARLUME_SUGGESTION_FALLBACK_BODY } from "@repo/utils/parlume-suggestion-prompt";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	PARLUME_SUGGESTION_MAX_OUTPUT_TOKENS,
	parlumeSuggestionPrompt,
} from "../../../modules/projects/lib/parlume-suggestions";
import { suggestionPasses } from "../evaluate";
import { buildEvalTranscript, loadEvalFixtures } from "../fixture";
import { type EvalDeps, runParlumeEval } from "../runner";

const mocks = vi.hoisted(() => ({
	generateText: vi.fn(),
	generateObject: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	generateText: mocks.generateText,
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: vi.fn(),
	Output: { object: (spec: unknown) => spec },
}));
vi.mock("@repo/database", () => ({
	db: {},
	getBoundPromptForAgent: vi.fn(),
	hasProjectAccess: vi.fn(),
	logAiUsageAsync: vi.fn(),
	tenantWhere: vi.fn(),
}));
vi.mock("@repo/rag", () => ({
	retrieveProjectContexts: vi.fn(),
	formatContextsForPrompt: vi.fn(),
}));

const FIXTURES = path.join(__dirname, "..", "fixtures");
const SHORT = path.join(FIXTURES, "sprint-planning-short.json");
const LONG = path.join(FIXTURES, "long-roadmap-3h.json");

const resolveModel = vi.fn<EvalDeps["resolveModel"]>();
const writeFile = vi.fn<EvalDeps["writeFile"]>();
const log = vi.fn<EvalDeps["log"]>();
const deps: EvalDeps = { resolveModel, writeFile, log };

function logged(): string {
	return log.mock.calls.map(([line]) => line).join("\n");
}

function haikuPrice() {
	const haiku = MODELS.find(
		(model) => model.canonicalName === "claude-haiku-5-5",
	);
	return {
		input: haiku?.inputCostPer1M ?? Number.NaN,
		output: haiku?.outputCostPer1M ?? Number.NaN,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	writeFile.mockResolvedValue(undefined);
});

describe("runParlumeEval without --confirm-spend", () => {
	it("refuses to call a model and prints a dry run instead", async () => {
		const result = await runParlumeEval(
			["--models", "claude-haiku-5-5,claude-sonnet-5-5"],
			deps,
		);

		expect(result.mode).toBe("dry-run");
		expect(resolveModel).not.toHaveBeenCalled();
		expect(mocks.generateText).not.toHaveBeenCalled();
		expect(mocks.generateObject).not.toHaveBeenCalled();
		expect(writeFile).not.toHaveBeenCalled();
		expect(logged()).toContain("DRY RUN. Nothing was sent to a model.");
		expect(logged()).toContain("--confirm-spend");
	});

	it("estimates the bundled fixtures for every model", async () => {
		const fixtures = await loadEvalFixtures([FIXTURES]);
		const result = await runParlumeEval(
			["--models", "claude-haiku-5-5,claude-opus-5-5"],
			deps,
		);

		if (result.mode !== "dry-run") {
			throw new Error("expected a dry run");
		}
		expect(result.estimates.map((row) => row.fixture)).toEqual(
			fixtures.map((fixture) => fixture.id),
		);
		expect(Object.keys(result.costs)).toEqual([
			"claude-haiku-5-5",
			"claude-opus-5-5",
		]);
		expect(result.costs["claude-opus-5-5"]).toBeGreaterThan(
			result.costs["claude-haiku-5-5"] ?? Number.POSITIVE_INFINITY,
		);
	});

	it("estimates input from the prompts' characters and output at the caps", async () => {
		const result = await runParlumeEval(
			["--models", "claude-haiku-5-5", "--fixtures", SHORT],
			deps,
		);
		if (result.mode !== "dry-run") {
			throw new Error("expected a dry run");
		}
		const [estimate] = result.estimates;

		// The prompts the passes would send, rebuilt here from the same
		// fixture: one notes pass, and a suggestion pass after each listed
		// segment.
		const [fixture] = await loadEvalFixtures([SHORT]);
		if (!fixture) {
			throw new Error("missing fixture");
		}
		let notesChars = 0;
		await writeAnchoredNotes({
			content: buildEvalTranscript(fixture).content,
			chatDeliveryFacts: "",
			pass: async (prompt) => {
				notesChars +=
					PARLUME_NOTES_FALLBACK_BODY.length + prompt.length;
				return {};
			},
		});
		const suggestionChars = suggestionPasses(fixture).reduce(
			(sum, pass) =>
				sum +
				PARLUME_SUGGESTION_FALLBACK_BODY.length +
				parlumeSuggestionPrompt(pass.material).length,
			0,
		);

		expect(estimate).toEqual({
			fixture: "sprint-planning-short",
			notesPasses: 1,
			suggestionPasses: 4,
			inputTokens:
				Math.ceil(notesChars / 3) + Math.ceil(suggestionChars / 3),
			outputTokens:
				PARLUME_NOTES_MAX_OUTPUT_TOKENS +
				4 * PARLUME_SUGGESTION_MAX_OUTPUT_TOKENS,
		});
		const price = haikuPrice();
		const input = (estimate?.inputTokens ?? 0) * price.input;
		const output = (estimate?.outputTokens ?? 0) * price.output;
		expect(result.costs["claude-haiku-5-5"]).toBeCloseTo(
			(input + output) / 1_000_000,
			10,
		);
	});

	it("counts a long meeting's checkpoint parts and their merge", async () => {
		const result = await runParlumeEval(
			["--models", "claude-haiku-5-5", "--fixtures", LONG],
			deps,
		);
		if (result.mode !== "dry-run") {
			throw new Error("expected a dry run");
		}
		const [estimate] = result.estimates;

		// At least two checkpoint parts, then the merge pass.
		expect(estimate?.notesPasses).toBeGreaterThanOrEqual(3);
	});

	it("prints tokens only for a model the catalog has no price for", async () => {
		const result = await runParlumeEval(
			["--models", "no-such-model", "--fixtures", SHORT],
			deps,
		);

		if (result.mode !== "dry-run") {
			throw new Error("expected a dry run");
		}
		expect(result.costs["no-such-model"]).toBeNull();
		expect(logged()).toContain(
			"no-such-model: the catalog has no price for this model",
		);
	});

	it("rejects an unknown flag and a missing --models", async () => {
		await expect(
			runParlumeEval(["--models", "claude-haiku-5-5", "--spend"], deps),
		).rejects.toThrow();
		await expect(runParlumeEval([], deps)).rejects.toThrow(
			"--models is required",
		);
	});
});

describe("runParlumeEval with --confirm-spend", () => {
	const confirmed = [
		"--models",
		"claude-haiku-5-5",
		"--fixtures",
		SHORT,
		"--confirm-spend",
	];

	it("needs the paying account and a report path before resolving a model", async () => {
		await expect(
			runParlumeEval([...confirmed, "--out", "report.json"], deps),
		).rejects.toThrow("--user-id");
		await expect(
			runParlumeEval([...confirmed, "--user-id", "user-1"], deps),
		).rejects.toThrow("--out");
		expect(resolveModel).not.toHaveBeenCalled();
		expect(mocks.generateText).not.toHaveBeenCalled();
	});

	it("sends nothing when the provider resolves another model", async () => {
		resolveModel.mockResolvedValue({
			canonicalName: "claude-sonnet-5-5",
			provider: "ANTHROPIC_DIRECT",
			model: "test-model",
		});

		await expect(
			runParlumeEval(
				[...confirmed, "--user-id", "user-1", "--out", "report.json"],
				deps,
			),
		).rejects.toThrow("resolved to claude-sonnet-5-5");
		expect(mocks.generateText).not.toHaveBeenCalled();
		expect(mocks.generateObject).not.toHaveBeenCalled();
	});

	it("runs, scores and writes the report with the run's tokens and cost", async () => {
		resolveModel.mockImplementation(async (modelId) => ({
			canonicalName: modelId,
			provider: "ANTHROPIC_DIRECT",
			model: "test-model",
		}));
		mocks.generateText.mockResolvedValue({
			output: {},
			usage: { inputTokens: 1_000, outputTokens: 100 },
			finishReason: "stop",
			response: {},
		});
		mocks.generateObject.mockResolvedValue({
			object: { suggest: false },
			usage: { inputTokens: 500, outputTokens: 10 },
		});

		const result = await runParlumeEval(
			[
				...confirmed,
				"--user-id",
				"user-1",
				"--organization-id",
				"org-1",
				"--out",
				"out/report.json",
			],
			deps,
		);

		if (result.mode !== "run") {
			throw new Error("expected a run");
		}
		expect(resolveModel).toHaveBeenCalledWith(
			"claude-haiku-5-5",
			"parlume-meeting-notes",
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				provider: null,
			}),
		);
		expect(resolveModel).toHaveBeenCalledWith(
			"claude-haiku-5-5",
			"parlume-live-turn",
			expect.objectContaining({ userId: "user-1" }),
		);
		const [model] = result.report.models;
		// One notes pass and four suggestion passes.
		expect(model?.usage).toEqual({ inputTokens: 3_000, outputTokens: 140 });
		const price = haikuPrice();
		expect(model?.costUsd).toBeCloseTo(
			(3_000 * price.input + 140 * price.output) / 1_000_000,
			10,
		);
		// The model wrote no notes: nothing proposed, nothing invented.
		expect(model?.scores).toEqual({
			anchorValidity: null,
			ownerAccuracy: null,
			inventedDecisions: 0,
			inventedDecisionRate: null,
			suggestionPrecision: null,
		});
		expect(writeFile.mock.calls.map(([file]) => file)).toEqual([
			"out/report.json",
			"out/report.md",
		]);
		expect(result.markdown).toContain(
			"| claude-haiku-5-5 | ANTHROPIC_DIRECT |",
		);
	});

	it("resolves every model on the provider --provider names", async () => {
		resolveModel.mockImplementation(async (modelId) => ({
			canonicalName: modelId,
			provider: "ANTHROPIC_DIRECT",
			model: "test-model",
		}));
		mocks.generateText.mockResolvedValue({
			output: {},
			usage: { inputTokens: 1_000, outputTokens: 100 },
			finishReason: "stop",
			response: {},
		});
		mocks.generateObject.mockResolvedValue({
			object: { suggest: false },
			usage: { inputTokens: 500, outputTokens: 10 },
		});

		const result = await runParlumeEval(
			[
				...confirmed,
				"--user-id",
				"user-1",
				"--provider",
				"ANTHROPIC_DIRECT",
				"--out",
				"report.json",
			],
			deps,
		);

		expect(result.mode).toBe("run");
		for (const job of ["parlume-meeting-notes", "parlume-live-turn"]) {
			expect(resolveModel).toHaveBeenCalledWith(
				"claude-haiku-5-5",
				job,
				expect.objectContaining({ provider: "ANTHROPIC_DIRECT" }),
			);
		}
	});

	it("sends nothing when a model resolves on another provider than --provider", async () => {
		resolveModel.mockImplementation(async (modelId) => ({
			canonicalName: modelId,
			provider: "OPENAI_DIRECT",
			model: "test-model",
		}));

		await expect(
			runParlumeEval(
				[
					...confirmed,
					"--user-id",
					"user-1",
					"--provider",
					"ANTHROPIC_DIRECT",
					"--out",
					"report.json",
				],
				deps,
			),
		).rejects.toThrow(
			"claude-haiku-5-5 resolved to claude-haiku-5-5 on OPENAI_DIRECT: ANTHROPIC_DIRECT does not serve claude-haiku-5-5",
		);
		expect(mocks.generateText).not.toHaveBeenCalled();
		expect(mocks.generateObject).not.toHaveBeenCalled();
	});

	it("records a fixture that fails and goes on with the rest", async () => {
		resolveModel.mockImplementation(async (modelId) => ({
			canonicalName: modelId,
			provider: "ANTHROPIC_DIRECT",
			model: "test-model",
		}));
		mocks.generateText.mockRejectedValue(new Error("provider unavailable"));

		const result = await runParlumeEval(
			[...confirmed, "--user-id", "user-1", "--out", "report.json"],
			deps,
		);

		if (result.mode !== "run") {
			throw new Error("expected a run");
		}
		expect(result.report.models[0]?.failed).toEqual([
			{
				fixture: "sprint-planning-short",
				error: "provider unavailable",
				usage: { inputTokens: 0, outputTokens: 0 },
			},
		]);
	});
});
