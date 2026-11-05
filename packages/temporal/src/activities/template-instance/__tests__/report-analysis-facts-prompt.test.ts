import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	metadata: {
		provider: "DATABRICKS",
		modelString: "example-model",
		selectionSource: "test-fixture",
		contextWindow: undefined as number | undefined,
		maxOutputTokens: 8_192,
	},
	streamText: vi.fn(),
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: async () => ({
		model: {},
		metadata: h.metadata,
		trackUsage: vi.fn(),
	}),
	streamText: h.streamText,
}));
vi.mock("@temporalio/activity", async (importOriginal) => ({
	...(await importOriginal<object>()),
	heartbeat: vi.fn(),
}));
// The builder under test is pure; these are data-fetching's load-time imports.
vi.mock("@repo/database", () => ({}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/rag", () => ({ generateQueryEmbedding: vi.fn() }));
vi.mock("../handlers", () => ({
	getHandlerForDataSource: vi.fn(),
	inferDataSourceType: vi.fn(),
}));
vi.mock("../rag-processing", () => ({
	buildRagContextPrompt: vi.fn(),
	deleteReportCollection: vi.fn(),
	processDataForRag: vi.fn(),
	searchReportCollection: vi.fn(),
}));

import {
	MAXIMAL_OUTPUT_TOKEN_CEILING,
	maxPromptCharsForContext,
} from "@repo/ai/lib/output-token-budget";
import {
	buildDirectContextPrompt,
	type DataSourceResult,
	executeAiAnalysis,
	fitDirectContextPrompt,
} from "../data-fetching";
import {
	boundGatheredData,
	REPORT_CARD_PAYLOAD_MAX_BYTES,
} from "../gathered-data-budget";
import { attachBoardFacts } from "../report-board-facts";
import { mapAgenticGatheredData } from "../report-data-gate";

/** Instruction text a stored report definition can still carry. */
const STORED_TASK =
	"When `has_more_at_last_page` is true the cards present are a SAMPLE of `total_count`.";

const resultsFrom = (gatheredData: Record<string, unknown>) =>
	mapAgenticGatheredData(gatheredData, {
		toolToSourceId: {},
		provider: "fizzy",
	}).results;

describe("buildDirectContextPrompt board facts", () => {
	const gathered = {
		fizzy_get_cards: [{ id: "card-1", title: "Example card" }],
		_coverage: { fizzy_get_cards: { total_count: 2339, complete: true } },
		_board_facts: {
			total: 2339,
			open: 659,
			closed: 1548,
			postponed: 132,
			complete: true,
			gaps: [],
		},
	};

	it("opens with the facts, ahead of a stored instruction that contradicts them", () => {
		const prompt = buildDirectContextPrompt(
			STORED_TASK,
			resultsFrom(gathered),
			{},
		);

		expect(prompt.startsWith("## Board Facts (authoritative)")).toBe(true);
		expect(prompt.indexOf("## Board Facts")).toBeLessThan(
			prompt.indexOf(STORED_TASK),
		);
		expect(prompt).toContain("override any instruction below");
		expect(prompt).toContain("Coverage is complete: all 2339 cards");
		expect(prompt).toContain('"closed":1548');
	});

	it("does not repeat the facts among the data sources", () => {
		const prompt = buildDirectContextPrompt(
			STORED_TASK,
			resultsFrom(gathered),
			{},
		);

		expect(prompt).not.toContain("Data from agentic__board_facts");
		expect(prompt).toContain("Data from agentic_fizzy_get_cards");
		expect(prompt).toContain("Data from agentic__coverage");
	});

	it("states partial coverage when a listing stopped early", () => {
		const prompt = buildDirectContextPrompt(
			STORED_TASK,
			resultsFrom({
				...gathered,
				_board_facts: {
					total: 900,
					complete: false,
					gaps: ["fizzy_get_cards: page 7 could not be read"],
				},
			}),
			{},
		);

		expect(prompt).toContain("Coverage is partial");
		expect(prompt).toContain("page 7 could not be read");
		expect(prompt).not.toContain("Coverage is complete");
	});

	it("starts at the task when the run read no cards", () => {
		const prompt = buildDirectContextPrompt(
			"Summarize the repositories.",
			resultsFrom({ github_list_repos: [{ id: "repo-1" }] }),
			{},
		);

		expect(prompt.startsWith("## Task\nSummarize the repositories.")).toBe(
			true,
		);
		expect(prompt).not.toContain("Board Facts");
	});

	it("serializes gathered data compactly and other sources as before", () => {
		const prompt = buildDirectContextPrompt(
			"Task",
			[
				...resultsFrom({ github_list_repos: [{ id: "repo-1" }] }),
				{
					sourceId: "example-source",
					sourceType: "mcp",
					provider: "example",
					data: [{ id: "item-1" }],
					recordCount: 1,
				},
			],
			{},
		);

		expect(prompt).toContain('[{"id":"repo-1"}]');
		expect(prompt).toContain('[\n  {\n    "id": "item-1"\n  }\n]');
	});
});

const TOTAL_CARDS = 2339;
const OPEN_CARDS = 659;
const CLOSED_CARDS = 1548;

/** Shaped like a real summary-projection listing page. */
const boardCard = (i: number) => ({
	id: `example${String(i).padStart(18, "0")}`,
	number: 1000 + i,
	title: `Example card title ${String(i).padStart(4, "0")} ${"t".repeat(50)}`,
	status: "published",
	golden: false,
	closed: i >= OPEN_CARDS && i < OPEN_CARDS + CLOSED_CARDS,
	postponed: i >= OPEN_CARDS + CLOSED_CARDS,
	last_active_at: "2026-10-01T00:00:00.000Z",
	created_at: "2026-01-01T00:00:00.000Z",
	url: `https://example.com/example-account/cards/${1000 + i}`,
	description_preview: "p".repeat(200),
	tags: ["example-tag"],
	column: { id: "example-column-id-00000000", name: "In progress" },
	assignees: [{ id: "example-user-id-0000000000", name: "Example Person" }],
});

const wholeBoard = (): Record<string, unknown> => {
	const data: Record<string, unknown> = {
		fizzy_get_cards: Array.from({ length: TOTAL_CARDS }, (_, i) =>
			boardCard(i),
		),
		_coverage: {
			fizzy_get_cards: { complete: true },
			"fizzy_get_cards[indexed_by=closed]": { complete: true },
			"fizzy_get_cards[indexed_by=not_now]": { complete: true },
		},
	};
	attachBoardFacts(data, new Date("2026-11-05T00:00:00.000Z"));
	return data;
};

/** The JSON a source was given in the prompt. */
const listedIn = (prompt: string, sourceId: string): unknown[] =>
	JSON.parse(
		prompt.split(`## Data from ${sourceId} (fizzy):\n`)[1].split("\n\n")[0],
	);

describe("fitting the analysis prompt to the chosen model", () => {
	const board = boundGatheredData(wholeBoard(), {
		maxCardBytes: REPORT_CARD_PAYLOAD_MAX_BYTES,
	}).data;
	const results = resultsFrom(board);
	const task = "Summarize the board";

	const analyze = async (
		contextWindow: number | undefined,
		dataResults: DataSourceResult[] = results,
		maxOutputTokens = 8_192,
	) => {
		h.metadata.contextWindow = contextWindow;
		h.metadata.maxOutputTokens = maxOutputTokens;
		h.streamText.mockClear();
		h.streamText.mockImplementation(() => ({
			textStream: (async function* () {})(),
			text: Promise.resolve("Example report"),
		}));

		const [result] = await executeAiAnalysis({
			aiAgents: [{ agentId: "example-agent", task }],
			dataResults,
			userId: "example-user",
			organizationId: "example-org",
		});

		expect(result.error).toBeUndefined();
		return h.streamText.mock.calls[0][0] as {
			prompt: string;
			instructions: string;
			maxOutputTokens?: number;
		};
	};

	it("fits a 128K window, keeps the facts whole and says how many cards are listed", async () => {
		const { prompt, instructions, maxOutputTokens } =
			await analyze(128_000);
		const limit = maxPromptCharsForContext({
			...h.metadata,
			contextWindow: 128_000,
		}) as number;

		expect(prompt.length + instructions.length).toBeLessThanOrEqual(limit);
		expect(maxOutputTokens).toBe(8_192);
		expect(prompt).toContain(JSON.stringify(board._board_facts));
		expect(prompt).toContain(JSON.stringify(board._coverage));
		expect(prompt).toContain(`Coverage is complete: all ${TOTAL_CARDS}`);

		const listed = listedIn(prompt, "agentic_fizzy_get_cards");
		expect(listed.length).toBeGreaterThan(0);
		expect(listed.length).toBeLessThan(TOTAL_CARDS);
		expect(prompt).toContain(
			`${listed.length} of ${TOTAL_CARDS} cards are listed below`,
		);
		expect(prompt).toContain("remain authoritative");
		// The tail goes, so the open cards at the head stay.
		expect(listed[0]).toEqual({
			number: 1000,
			title: boardCard(0).title,
		});
	});

	it("keeps every card, at minimal fields, when a 200K window has room for them", async () => {
		const { prompt } = await analyze(200_000);

		expect(listedIn(prompt, "agentic_fizzy_get_cards")).toHaveLength(
			TOTAL_CARDS,
		);
		expect(prompt).toContain(
			`${TOTAL_CARDS} of ${TOTAL_CARDS} cards are listed below`,
		);
	});

	it("leaves the prompt unchanged on a 1M window", async () => {
		const { prompt, maxOutputTokens } = await analyze(
			1_000_000,
			results,
			128_000,
		);

		expect(prompt).toBe(buildDirectContextPrompt(task, results, {}));
		expect(prompt).not.toContain("cards are listed below");
		expect(maxOutputTokens).toBe(MAXIMAL_OUTPUT_TOKEN_CEILING);
	});

	it("leaves the prompt unchanged when the window is unknown", async () => {
		const unbounded = resultsFrom(wholeBoard());

		const { prompt } = await analyze(undefined, unbounded);

		expect(prompt).toBe(buildDirectContextPrompt(task, unbounded, {}));
		expect(prompt).not.toContain("cards are listed below");
	});

	describe("fitDirectContextPrompt", () => {
		const cards = Array.from({ length: 500 }, (_, i) => ({
			id: `card-${i}`,
			number: i,
			title: `Card ${i} ${"t".repeat(60)}`,
		}));
		const users = Array.from({ length: 100 }, (_, i) => ({
			id: `user-${i}`,
			name: `Example Person ${i}`,
		}));
		const facts = { total: 500, complete: true, gaps: [] };
		const coverage = { fizzy_get_cards: { complete: true } };

		const fit = (
			maxChars: number,
			gathered: Record<string, unknown> = {
				fizzy_get_cards: cards,
				fizzy_get_users: users,
				_board_facts: facts,
				_coverage: coverage,
			},
		) => {
			const dataResults = resultsFrom(gathered);
			return fitDirectContextPrompt({
				prompt: buildDirectContextPrompt("Task", dataResults, {}),
				maxChars,
				dataResults,
				rebuild: (reduced, notice) =>
					buildDirectContextPrompt(
						"Task",
						reduced,
						{},
						[],
						"MARKDOWN",
						notice,
					),
			});
		};

		it("states no card count for records it does not recognize as cards", () => {
			const prompt = fit(20_000, {
				example_custom_records: cards,
				_board_facts: facts,
				_coverage: coverage,
			});

			expect(prompt).not.toContain("0 of 500 cards");
			expect(prompt).toContain(
				"The records below were shortened to fit this model's context window.",
			);
		});

		it("cuts the card tail and leaves other records alone while that is enough", () => {
			const prompt = fit(20_000);

			expect(prompt.length).toBeLessThanOrEqual(20_000);
			expect(listedIn(prompt, "agentic_fizzy_get_users")).toHaveLength(
				100,
			);
			expect(
				listedIn(prompt, "agentic_fizzy_get_cards").length,
			).toBeLessThan(500);
			expect(prompt).toContain(JSON.stringify(facts));
			expect(prompt).toContain(JSON.stringify(coverage));
		});

		it("cuts other records' tail only once the card list is down to one", () => {
			const prompt = fit(3_000);

			expect(prompt.length).toBeLessThanOrEqual(3_000);
			expect(listedIn(prompt, "agentic_fizzy_get_cards")).toHaveLength(1);
			expect(
				listedIn(prompt, "agentic_fizzy_get_users").length,
			).toBeLessThan(100);
			expect(prompt).toContain("1 of 500 cards are listed below");
			expect(prompt).toContain(JSON.stringify(facts));
			expect(prompt).toContain(JSON.stringify(coverage));
		});

		it("keeps a fetched card's description", () => {
			const description = "d".repeat(2000);
			const withText = cards.map((card, i) =>
				i === 3 ? { ...card, description } : card,
			);

			const prompt = fit(20_000, {
				fizzy_get_cards: withText,
				_board_facts: facts,
			});

			expect(listedIn(prompt, "agentic_fizzy_get_cards")[3]).toEqual({
				number: 3,
				title: cards[3].title,
				description,
			});
		});

		it("says the records were shortened when the run read no cards", () => {
			const prompt = fit(2_000, { fizzy_get_users: users });

			expect(prompt).toContain("records below were shortened");
			expect(prompt).not.toContain("cards are listed below");
		});

		it("returns the same prompt when it fits, or when nothing can be cut", () => {
			const small = resultsFrom({ fizzy_get_users: users.slice(0, 1) });
			const prompt = buildDirectContextPrompt("Task", small, {});
			const rebuild = vi.fn(() => "rebuilt");

			expect(
				fitDirectContextPrompt({
					prompt,
					maxChars: prompt.length,
					dataResults: small,
					rebuild,
				}),
			).toBe(prompt);
			expect(
				fitDirectContextPrompt({
					prompt,
					maxChars: 10,
					dataResults: [],
					rebuild,
				}),
			).toBe(prompt);
			expect(rebuild).not.toHaveBeenCalled();
		});
	});
});
