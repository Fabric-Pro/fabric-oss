/**
 * The data the `orchestrator_memory_context` prompt is rendered against.
 *
 * `buildMemoryContextPromptVariables` assembles only data; the wording is the
 * Prompt Library's. Rendered here against the seeded default body, so the pair
 * is pinned end to end: an episode that says a workflow was created reaches the
 * model dated, under the rule that it is history to verify with a tool.
 */

import { ORCHESTRATOR_MEMORY_FALLBACK_BODY } from "@repo/utils/orchestrator-memory-prompt";
import { renderTemplate } from "@repo/utils/template-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma/client", () => ({ db: {} }));

import {
	buildMemoryContextPromptVariables,
	type EpisodeSummary,
	renderOrchestratorMemoryContext,
} from "../prisma/queries/orchestrator-memory";

function episode(overrides: Partial<EpisodeSummary>): EpisodeSummary {
	return {
		id: "episode-example-1",
		conversationId: "conversation-example-1",
		title: "Weekly project status page",
		summary:
			"Created a scheduled workflow that publishes a status page every Monday; ran it once.",
		keyTopics: [],
		userIntents: [],
		outcome: "success",
		messageCount: 4,
		turnCount: 2,
		recordedTurnCount: 1,
		toolsUsed: [],
		agentsUsed: [],
		conversationStartedAt: new Date("2026-10-16T08:58:00.000Z"),
		conversationEndedAt: new Date("2026-10-16T09:05:00.000Z"),
		projectId: "project-example-1",
		workspaceId: null,
		qdrantPointId: null,
		...overrides,
	};
}

const NO_PREFERENCES = {
	preferences: {},
	recentProjectIds: [],
	recentWorkspaceIds: [],
};

const EMPTY = {
	preferences: NO_PREFERENCES,
	recentEpisodes: [],
	projectEpisodes: [],
	workspaceEpisodes: [],
	relevantEpisodes: [],
};

describe("buildMemoryContextPromptVariables", () => {
	it("dates each recalled episode by when its conversation ended", () => {
		const variables = buildMemoryContextPromptVariables({
			...EMPTY,
			projectEpisodes: [episode({})],
			recentEpisodes: [
				episode({
					id: "ongoing-example",
					title: "Ongoing discussion",
					conversationEndedAt: null,
				}),
			],
		});

		expect(variables.project_discussions).toBe(
			"- [2026-10-16] Weekly project status page: Created a scheduled workflow that publishes a status page every Monday; ran it once.",
		);
		expect(variables.recent_conversations).toMatch(/^- \[ongoing\] /);
		expect(variables.has_recalled_conversations).toBe(true);
		expect(variables.has_memory).toBe(true);
	});

	it("lists a relevant episode's topics under it", () => {
		const variables = buildMemoryContextPromptVariables({
			...EMPTY,
			relevantEpisodes: [
				episode({ keyTopics: ["workflow", "schedule"] }),
			],
		});

		expect(variables.relevant_conversations).toBe(
			"- [2026-10-16] Weekly project status page: Created a scheduled workflow that publishes a status page every Monday; ran it once.\n  Topics: workflow, schedule",
		);
	});

	it("keeps the last ten learned patterns and only string ones", () => {
		const patterns = Array.from({ length: 12 }, (_, i) => `pattern ${i}`);
		const variables = buildMemoryContextPromptVariables({
			...EMPTY,
			preferences: {
				...NO_PREFERENCES,
				responseStyle: "concise",
				preferences: { learnedPatterns: [...patterns, 42] },
			},
		});

		expect(variables.learned_patterns.split("\n")).toEqual(
			patterns.slice(-10).map((pattern) => `- ${pattern}`),
		);
		expect(variables.preferences).toBe("- Response style: concise");
		expect(variables.has_recalled_conversations).toBe(false);
	});

	it("reports no memory when there is none", () => {
		const variables = buildMemoryContextPromptVariables(EMPTY);

		expect(variables.has_memory).toBe(false);
		expect(variables.has_preferences).toBe(false);
		expect(variables.has_learned_patterns).toBe(false);
	});

	it("with the seeded body, puts an episode that created a workflow under the verify-before-claiming rule", async () => {
		const variables = buildMemoryContextPromptVariables({
			...EMPTY,
			relevantEpisodes: [episode({})],
		});

		const { rendered, error } = await renderTemplate({
			format: "HANDLEBARS",
			template: ORCHESTRATOR_MEMORY_FALLBACK_BODY,
			variables,
			escape: false,
		});

		expect(error).toBeUndefined();
		const rule = rendered.indexOf("History, Not Current State");
		const summary = rendered.indexOf("Created a scheduled workflow");
		expect(rule).toBeGreaterThan(-1);
		expect(summary).toBeGreaterThan(rule);
		expect(rendered).toContain(
			"Never report anything as done in this turn because a past conversation says it was done.",
		);
		expect(rendered).toContain("check it now with a tool");
	});
});

// These cases reject independent section mapping, input-order sorting, and
// unbounded episode rendering respectively.
async function renderMemory(
	context: Parameters<typeof buildMemoryContextPromptVariables>[0],
) {
	return (await renderOrchestratorMemoryContext(context)).text;
}

describe("memory episode selection", () => {
	it("deduplicates IDs and normalized content while retaining unique episodes", async () => {
		const shared = episode({
			title: "Review the shared project discussion",
			summary: "Shared fact",
			keyTopics: ["topic A"],
		});
		const context = {
			...EMPTY,
			relevantEpisodes: [shared],
			projectEpisodes: [
				shared,
				episode({
					id: "copy",
					title: " REVIEW  the SHARED project discussion ",
					summary: " shared FACT ",
				}),
			],
			workspaceEpisodes: [
				shared,
				episode({
					id: "near",
					title: "Shared discussion with an exception",
					summary: "Shared fact with an exception",
				}),
			],
			recentEpisodes: [
				shared,
				episode({
					id: "unique",
					title: "Recent unique",
					summary: "Recent fact",
				}),
			],
		};
		const result = await renderOrchestratorMemoryContext(context);
		const { text } = result;
		// Equal-date attempts use episodeOrder's ID tie-break (copy before episode).
		expect(result.context.relevantEpisodes.map((row) => row.id)).toEqual([
			"copy",
		]);
		expect(text).not.toContain("Topics: topic A");
		expect(text).toContain("Shared fact with an exception");
		expect(text).toContain("Recent fact");
		expect(
			await renderMemory({
				...context,
				relevantEpisodes: [...context.relevantEpisodes].reverse(),
				projectEpisodes: [...context.projectEpisodes].reverse(),
				workspaceEpisodes: [...context.workspaceEpisodes].reverse(),
				recentEpisodes: [...context.recentEpisodes].reverse(),
			}),
		).toBe(text);
		expect(text).not.toContain("## Related Project Discussions");
	});
	it.each([
		"projectEpisodes",
		"workspaceEpisodes",
		"recentEpisodes",
	] as const)(
		"renders shuffled %s inputs byte-identically with date and ID ties",
		async (section) => {
			const rows = [
				episode({ id: "b", title: "B" }),
				episode({ id: "a", title: "A" }),
				episode({
					id: "c",
					title: "C",
					conversationEndedAt: new Date("2026-10-17"),
				}),
			];
			const first = await renderMemory({ ...EMPTY, [section]: rows });
			const second = await renderMemory({
				...EMPTY,
				[section]: [...rows].reverse(),
			});
			expect(first).toBe(second);
			expect(first.indexOf("C:")).toBeLessThan(first.indexOf("A:"));
			expect(first.indexOf("A:")).toBeLessThan(first.indexOf("B:"));
		},
	);
	it("keeps the highest-priority entry without merging discarded text or topics", () => {
		const kept = episode({
			title: "Kept entry",
			summary: "Kept summary",
			keyTopics: ["zeta", "alpha"],
		});
		const discarded = {
			...kept,
			title: "Discarded entry",
			summary: "Discarded summary",
			keyTopics: ["discarded"],
		};
		const variables = buildMemoryContextPromptVariables({
			...EMPTY,
			relevantEpisodes: [kept],
			projectEpisodes: [discarded],
		});
		expect(variables.relevant_conversations).toBe(
			"- [2026-10-16] Kept entry: Kept summary\n  Topics: zeta, alpha",
		);
		expect(variables.has_project_discussions).toBe(false);
	});
	it("keeps the oldest top-ranked relevant hit when the byte cap removes lower ranks", async () => {
		const rows = [1, 2, 3, 4, 5].map((rank) =>
			writerEpisode(
				`rank-${rank}`,
				1950,
				new Date(`2026-10-${10 + rank}`),
			),
		);
		const result = await renderOrchestratorMemoryContext({
			...EMPTY,
			relevantEpisodes: rows,
		});
		expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8192);
		expect(result.context.relevantEpisodes.map((row) => row.id)).toEqual([
			"rank-1",
			"rank-2",
		]);
		expect(result.text.indexOf(rows[0].summary)).toBeLessThan(
			result.text.indexOf(rows[1].summary),
		);
		expect(result.text).not.toContain(rows[2].summary);
		expect(
			(
				await renderOrchestratorMemoryContext({
					...EMPTY,
					relevantEpisodes: rows,
				})
			).text,
		).toBe(result.text);
	});

	it("omits headings for sections emptied by deduplication", async () => {
		const row = episode({});
		const text = await renderMemory({
			...EMPTY,
			relevantEpisodes: [row],
			projectEpisodes: [row],
			workspaceEpisodes: [row],
			recentEpisodes: [row],
		});
		expect(text).not.toContain("## Recent Conversations");
		expect(text).not.toContain("## Related Project Discussions");
		expect(text).not.toContain("## Related Workspace Discussions");
		expect(text).toContain("## Relevant Past Conversations");
	});
	it("caps UTF-8 output by dropping whole lower-priority episodes", async () => {
		const make = (id: string) =>
			episode({
				id,
				title: id,
				summary: `${id} start ${"界".repeat(850)} ${id} end`,
			});
		const text = await renderMemory({
			...EMPTY,
			relevantEpisodes: [make("relevant")],
			projectEpisodes: [make("project")],
			workspaceEpisodes: [make("workspace")],
			recentEpisodes: [make("recent")],
		});
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
		expect(text).toContain("relevant end");
		expect(text).toContain("project end");
		expect(text).not.toContain("workspace start");
		expect(text).not.toContain("recent start");
	});
});

// This mirrors the pre-deduplication variable contract, independently of selection.
function legacyMemoryVariables(
	context: Parameters<typeof buildMemoryContextPromptVariables>[0],
) {
	const { responseStyle, verbosity, codeLanguage, timezone } =
		context.preferences;
	const preferenceLines = [
		responseStyle && `- Response style: ${responseStyle}`,
		verbosity && `- Verbosity: ${verbosity}`,
		codeLanguage && `- Preferred code language: ${codeLanguage}`,
		timezone && `- Timezone: ${timezone}`,
	].filter(Boolean);
	const patterns = context.preferences.preferences.learnedPatterns;
	const patternLines = (Array.isArray(patterns) ? patterns : [])
		.filter((pattern): pattern is string => typeof pattern === "string")
		.slice(-10)
		.map((pattern) => `- ${pattern}`);
	const line = (row: EpisodeSummary) =>
		`- [${row.conversationEndedAt ? new Date(row.conversationEndedAt).toISOString().slice(0, 10) : "ongoing"}] ${row.title}: ${row.summary}`;
	const recalled =
		context.relevantEpisodes.length +
			context.projectEpisodes.length +
			context.workspaceEpisodes.length +
			context.recentEpisodes.length >
		0;
	return {
		has_memory:
			preferenceLines.length > 0 || patternLines.length > 0 || recalled,
		has_preferences: preferenceLines.length > 0,
		preferences: preferenceLines.join("\n"),
		has_learned_patterns: patternLines.length > 0,
		learned_patterns: patternLines.join("\n"),
		has_recalled_conversations: recalled,
		has_recent_conversations: context.recentEpisodes.length > 0,
		recent_conversations: context.recentEpisodes.map(line).join("\n"),
		has_project_discussions: context.projectEpisodes.length > 0,
		project_discussions: context.projectEpisodes.map(line).join("\n"),
		has_workspace_discussions: context.workspaceEpisodes.length > 0,
		workspace_discussions: context.workspaceEpisodes.map(line).join("\n"),
		has_relevant_conversations: context.relevantEpisodes.length > 0,
		relevant_conversations: context.relevantEpisodes
			.map((row) =>
				row.keyTopics.length > 0
					? `${line(row)}\n  Topics: ${row.keyTopics.join(", ")}`
					: line(row),
			)
			.join("\n"),
	};
}

async function legacyMemoryText(
	context: Parameters<typeof buildMemoryContextPromptVariables>[0],
) {
	const result = await renderTemplate({
		format: "HANDLEBARS",
		template: ORCHESTRATOR_MEMORY_FALLBACK_BODY,
		variables: legacyMemoryVariables(context),
		escape: false,
	});
	return result.rendered.trim();
}

it("matches the pre-deduplication rendered value of each variable on unique episodes", async () => {
	const row = (id: string) =>
		episode({
			id,
			title: `${id} discussion`,
			summary: `${id} fact`,
			keyTopics: ["zeta", "alpha"],
		});
	const context = {
		...EMPTY,
		preferences: {
			...NO_PREFERENCES,
			responseStyle: "concise",
			verbosity: "standard",
			codeLanguage: "typescript",
			timezone: "UTC",
			preferences: { learnedPatterns: ["Use examples", "Use lists"] },
		},
		relevantEpisodes: [row("relevant")],
		projectEpisodes: [row("project")],
		workspaceEpisodes: [row("workspace")],
		recentEpisodes: [row("recent")],
	};
	const before = legacyMemoryVariables(context);
	const after = buildMemoryContextPromptVariables(context);
	for (const name of Object.keys(before).sort() as Array<
		keyof typeof before
	>) {
		const template = `{{{${name}}}}`;
		const previous = await renderTemplate({
			format: "HANDLEBARS",
			template,
			variables: before,
			escape: false,
		});
		const current = await renderTemplate({
			format: "HANDLEBARS",
			template,
			variables: after,
			escape: false,
		});
		expect(current.rendered, name).toBe(previous.rendered);
	}
	expect(after).toEqual(before);
	process.stdout.write(
		`Variable compatibility: ${Object.keys(before).length} rendered values unchanged\n`,
	);
});

// Match the execution writer's title/summary bounds and Task/Steps format.
function writerEpisode(
	id: string,
	summarySize: number,
	ended = new Date("2026-10-16"),
): EpisodeSummary {
	const task = `Prepare the synthetic ${id} project report with findings and follow-up actions for the example release. `;
	const description =
		`${task}Review the example source documents and summarize the decisions for the project team.`.slice(
			0,
			200,
		);
	const steps: string[] = [];
	let summary = `Task: ${description}\n\nSteps executed:\n`;
	// Finish complete steps for shorter summaries; only the writer's 2,000
	// character boundary can truncate a step.
	for (let index = 0; summary.length < summarySize; index++) {
		steps.push(
			`- Review example document ${index + 1}, record its findings and update the synthetic report with supporting evidence and follow-up actions (completed)`,
		);
		summary = `Task: ${description}\n\nSteps executed:\n${steps.join("\n")}`;
	}

	return episode({
		id,
		conversationId: `conversation-${id}`,
		title: description,
		summary: summary.slice(0, 2000),
		keyTopics: ["report", "project"],
		conversationStartedAt: new Date(ended.getTime() - 300_000),
		conversationEndedAt: ended,
		workspaceId: "workspace-example-1",
	});
}

it.each(["two-section overlap", "six-copy overlap"] as const)(
	"measures writer-shaped %s memory",
	async (shape) => {
		const first = writerEpisode(
			"example-first",
			shape === "two-section overlap" ? 1000 : 1500,
		);
		const second = writerEpisode("example-second", 1000);
		// Distinct rows with identical content account for more than four copies
		// without repeating an ID within one retrieved section.
		const copy = {
			...first,
			id: "example-copy",
			conversationId: "conversation-example-copy",
		};
		const context =
			shape === "two-section overlap"
				? {
						...EMPTY,
						relevantEpisodes: [first, second],
						projectEpisodes: [first, second],
					}
				: {
						...EMPTY,
						relevantEpisodes: [first],
						projectEpisodes: [first],
						workspaceEpisodes: [first, copy],
						recentEpisodes: [first, copy],
					};
		const rows = shape === "two-section overlap" ? [first, second] : [copy];
		for (const row of rows) {
			expect(row.title.length).toBeLessThanOrEqual(200);
			expect(row.summary.length).toBeGreaterThanOrEqual(1000);
			expect(row.summary.length).toBeLessThanOrEqual(2000);
			expect(row.summary).toMatch(/^Task: .+\n\nSteps executed:\n- /);
		}
		const before = Buffer.byteLength(await legacyMemoryText(context));
		const result = await renderOrchestratorMemoryContext(context);
		const after = Buffer.byteLength(result.text);
		expect(after).toBeLessThan(before);
		expect(after).toBeLessThanOrEqual(8192);
		expect(result.context.relevantEpisodes.map((row) => row.id)).toEqual(
			rows.map((row) => row.id),
		);
		for (const row of rows) {
			expect(result.text.split(row.summary)).toHaveLength(2);
		}
		expect(result.text).not.toContain("## Related Project Discussions");
		expect(result.text).not.toContain("## Related Workspace Discussions");
		expect(result.text).not.toContain("## Recent Conversations");
		process.stdout.write(
			`Writer-shaped ${shape}: ${before} -> ${after} bytes\n`,
		);
	},
);

it("preserves preferences when their text alone exceeds the episode budget", async () => {
	const style = "p".repeat(9000);
	const result = await renderOrchestratorMemoryContext({
		...EMPTY,
		preferences: { ...NO_PREFERENCES, responseStyle: style },
		relevantEpisodes: [episode({})],
	});
	expect(result.text).toContain(style);
	expect(result.context.relevantEpisodes).toEqual([]);
	expect(result.text).not.toContain("## Relevant Past Conversations");
});

// Selection assertions catch retaining stale attempts, moving a group to its
// newest member's rank, and matching task prefixes instead of full titles.
function attempt(id: string, title: string, day: number) {
	return episode({
		id,
		conversationId: `conversation-${id}`,
		title,
		summary: `${id} outcome`,
		keyTopics: [id],
		conversationEndedAt: new Date(`2026-10-${day}`),
	});
}

describe("repeated task selection", () => {
	it.each(["yes", "go ahead", "continue", "please continue with this"])(
		"retains distinct conversations ending with the short reply %s at their relevant ranks",
		async (title) => {
			const result = await renderOrchestratorMemoryContext({
				...EMPTY,
				relevantEpisodes: [
					attempt("match", title, 16),
					attempt("unrelated", title, 19),
				],
			});
			expect(
				result.context.relevantEpisodes.map((row) => row.id),
			).toEqual(["match", "unrelated"]);
			expect(result.text.indexOf("match outcome")).toBeGreaterThan(-1);
			expect(result.text.indexOf("match outcome")).toBeLessThan(
				result.text.indexOf("unrelated outcome"),
			);
		},
	);

	it("keeps project B's discussion separate from a newer project A recent conversation", async () => {
		const question = "List the five most recently updated example features";
		const result = await renderOrchestratorMemoryContext({
			...EMPTY,
			projectEpisodes: [
				{
					...attempt("b", question, 16),
					projectId: "project-example-b",
				},
			],
			recentEpisodes: [
				{
					...attempt("a", question, 19),
					projectId: "project-example-a",
				},
			],
		});
		expect(result.context.projectEpisodes.map((row) => row.id)).toEqual([
			"b",
		]);
		expect(result.context.recentEpisodes.map((row) => row.id)).toEqual([
			"a",
		]);
		expect(
			buildMemoryContextPromptVariables(result.context)
				.project_discussions,
		).toBe(`- [2026-10-16] ${question}: b outcome`);
		expect(result.text).toContain(
			`## Related Project Discussions\n- [2026-10-16] ${question}: b outcome`,
		);
	});

	it.each([
		{ projectId: "project-example-other", workspaceId: null },
		{
			projectId: "project-example-1",
			workspaceId: "workspace-example-other",
		},
		{ projectId: null, workspaceId: null },
	])("keeps cross-scope attempts separate: %j", async (scope) => {
		const question = "Review project reports today please";
		const result = await renderOrchestratorMemoryContext({
			...EMPTY,
			relevantEpisodes: [attempt("old", question, 16)],
			projectEpisodes: [{ ...attempt("new", question, 19), ...scope }],
		});
		expect(result.context.relevantEpisodes.map((row) => row.id)).toEqual([
			"old",
		]);
		expect(result.context.projectEpisodes.map((row) => row.id)).toEqual([
			"new",
		]);
		expect(result.text).toContain("old outcome");
		expect(result.text).toContain("new outcome");
	});

	it("uses the newest of ranks 2, 4 and 5 at rank 2's position", async () => {
		const result = await renderOrchestratorMemoryContext({
			...EMPTY,
			relevantEpisodes: [
				attempt("first", "First task", 20),
				attempt("old", " Review  project reports today please ", 16),
				attempt("third", "Third task", 21),
				attempt("new", "review project reports today please", 19),
				attempt("middle", "REVIEW PROJECT REPORTS TODAY PLEASE", 18),
			],
		});
		expect(result.context.relevantEpisodes.map((row) => row.id)).toEqual([
			"first",
			"new",
			"third",
		]);
		expect(result.text).toContain(
			"- [2026-10-19] review project reports today please: new outcome\n  Topics: new",
		);
		expect(result.text).not.toContain("old outcome");
		expect(result.text).not.toContain("middle outcome");
	});

	it.each([
		["relevantEpisodes", "projectEpisodes"],
		["projectEpisodes", "workspaceEpisodes"],
		["workspaceEpisodes", "recentEpisodes"],
	] as const)(
		"places newest same-scope content in %s ahead of %s",
		async (best, lower) => {
			const scope = {
				projectId: "project-example-1",
				workspaceId: "workspace-example-1",
			};
			const result = await renderOrchestratorMemoryContext({
				...EMPTY,
				[best]: [
					{
						...attempt(
							"old",
							"Review project reports today please",
							16,
						),
						...scope,
					},
				],
				[lower]: [
					{
						...attempt(
							"new",
							" review project REPORTS today please ",
							19,
						),
						...scope,
					},
				],
			});
			expect(result.context[best].map((row) => row.id)).toEqual(["new"]);
			expect(result.context[lower]).toEqual([]);
			expect(result.text).toContain("new outcome");
			expect(result.text).not.toContain("old outcome");
			expect(result.text.includes("Topics: new")).toBe(
				best === "relevantEpisodes",
			);
		},
	);

	it("keeps different full titles sharing a prefix while collapsing their repeats", async () => {
		const prefix = "Review the five most recently updated example reports";
		const result = await renderOrchestratorMemoryContext({
			...EMPTY,
			relevantEpisodes: [
				attempt("a-old", `${prefix} and list owners`, 16),
				attempt("b", `${prefix} and list decisions`, 17),
				attempt("a-new", `${prefix} and list owners`, 18),
			],
		});
		expect(result.context.relevantEpisodes.map((row) => row.id)).toEqual([
			"a-new",
			"b",
		]);
	});

	it("renders shuffled scoped attempts byte-identically with date and ID tie-breaks", async () => {
		const rows = [
			attempt("z", "Review project reports today please", 16),
			attempt("b", "Review project reports today please", 19),
			attempt("a", "Review project reports today please", 19),
			attempt("other", "Another task", 18),
		];
		const render = (projectEpisodes: EpisodeSummary[]) =>
			renderOrchestratorMemoryContext({
				...EMPTY,
				projectEpisodes,
			});
		const first = await render(rows);
		const shuffled = await render([rows[2], rows[0], rows[3], rows[1]]);
		expect(first.text).toBe(shuffled.text);
		expect(first.context.projectEpisodes.map((row) => row.id)).toEqual([
			"a",
			"other",
		]);
	});

	it("measures three plus two writer-shaped attempts with distinct steps", async () => {
		const make = (task: string, id: string, day: number) => {
			const row = writerEpisode(task, 1400, new Date(`2026-10-${day}`));
			return {
				...row,
				id,
				conversationId: `conversation-${id}`,
				summary: row.summary.replace("document 1,", `document ${id},`),
			};
		};
		const context = {
			...EMPTY,
			relevantEpisodes: [
				make("example-list", "a", 16),
				make("example-list", "b", 17),
				make("example-list", "c", 18),
			],
			projectEpisodes: [
				make("example-open", "d", 16),
				make("example-open", "e", 19),
			],
		};
		for (const row of [
			...context.relevantEpisodes,
			...context.projectEpisodes,
		]) {
			expect(row.summary.length).toBeGreaterThanOrEqual(1000);
			expect(row.summary.length).toBeLessThanOrEqual(2000);
		}
		const result = await renderOrchestratorMemoryContext(context);
		process.stdout.write(
			`Repeated writer fixture: uncapped=${Buffer.byteLength(await legacyMemoryText(context))} rendered=${Buffer.byteLength(result.text)} bytes\n`,
		);
		expect(result.context.relevantEpisodes.map((row) => row.id)).toEqual([
			"c",
		]);
		expect(result.context.projectEpisodes.map((row) => row.id)).toEqual([
			"e",
		]);
		expect(result.text.match(/^- \[/gm)).toHaveLength(2);
	});
});
