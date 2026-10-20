/**
 * Regression tests for `applyTokenBudget` (Fizzy #1234).
 *
 * The bug this guards: the function has two exit paths — "everything fits" and
 * "progressively truncate" — and both used to hand-list the context keys they
 * returned. Adding `applicationLogs` to the priority list but to only ONE of
 * those literals meant the log section was silently dropped whenever the
 * budget was exceeded, which is precisely when a real project's analysis runs.
 * Both paths now build their result from the priority list itself.
 *
 * These tests assert the property that made the bug invisible: a source that
 * ranks high in priority must survive BOTH paths.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyTokenBudget, buildAnalysisPrompt } from "../analyze-context";

/** Roughly 4 chars per token, so 1000 chars is ~250 tokens. */
const small = "s".repeat(1_000);
/** Large enough to blow the 80k-token budget on its own. */
const huge = "h".repeat(400_000);

describe("applyTokenBudget — everything fits", () => {
	it("returns every supplied context source", () => {
		const out = applyTokenBudget({
			architectureDecisions: "decisions",
			applicationLogs: "logs",
			teamsMessages: "teams",
			slackMessages: "slack",
			meetingTranscripts: "meetings",
			notionContent: "notion",
			ragContext: "rag",
			backlog: small,
			systemPrompt: small,
			userPrompt: small,
		});

		expect(out).toEqual({
			backlog: small,
			pmWorkItems: "",
			meetingTranscriptBudget: { requestedTokens: 2, grantedTokens: 2 },
			architectureDecisions: "decisions",
			applicationLogs: "logs",
			teamsMessages: "teams",
			slackMessages: "slack",
			meetingTranscripts: "meetings",
			notionContent: "notion",
			ragContext: "rag",
		});
	});

	it("omits sources that were not supplied", () => {
		const out = applyTokenBudget({
			applicationLogs: "logs",
			backlog: small,
			systemPrompt: small,
			userPrompt: small,
		});

		expect(out).toEqual({
			applicationLogs: "logs",
			backlog: small,
			pmWorkItems: "",
			meetingTranscriptBudget: { requestedTokens: 0, grantedTokens: 0 },
		});
	});
});

describe("applyTokenBudget — truncation path", () => {
	it("keeps binding decisions whole when several large meetings exceed the budget", () => {
		const transcripts = Array.from(
			{ length: 8 },
			(_, index) => `Meeting ${index}: ${"discussion ".repeat(5_000)}`,
		).join("\n\n");
		const decisions = "ACCEPTED: use the existing queue.";
		const out = applyTokenBudget({
			architectureDecisions: decisions,
			meetingTranscripts: transcripts,
			backlog: small,
			systemPrompt: small,
			userPrompt: small,
		});

		expect(out.architectureDecisions).toBe(decisions);
		expect(out.meetingTranscripts?.length).toBeGreaterThan(0);
		expect(out.meetingTranscripts?.length).toBeLessThan(transcripts.length);
	});

	it("keeps the meeting whole before allocating security findings and logs", () => {
		const transcript = "Meeting: improve the export flow. ".repeat(2_000);
		const out = applyTokenBudget({
			meetingTranscripts: transcript,
			securityFindings: huge,
			applicationLogs: small,
			backlog: small,
			systemPrompt: small,
			userPrompt: small,
		});

		expect(out.meetingTranscripts).toBe(transcript);
		expect(out.securityFindings?.length ?? 0).toBeLessThan(huge.length);
		expect(out.applicationLogs).toBeUndefined();
	});

	it("keeps the high-priority sources, including application logs", () => {
		// `huge` in a low-priority slot forces progressive truncation.
		const out = applyTokenBudget({
			architectureDecisions: "decisions",
			applicationLogs: "logs",
			ragContext: huge,
			backlog: small,
			systemPrompt: small,
			userPrompt: small,
		});

		// This is the assertion that would have caught the original bug: the
		// log section precedes RAG in the allocation list and survives this case.
		expect(out.applicationLogs).toBe("logs");
		expect(out.architectureDecisions).toBe("decisions");
	});

	it("truncates the lowest-priority source rather than the highest", () => {
		const out = applyTokenBudget({
			applicationLogs: "logs",
			ragContext: huge,
			backlog: small,
			systemPrompt: small,
			userPrompt: small,
		});

		expect(out.applicationLogs).toBe("logs");
		expect(out.ragContext?.length ?? 0).toBeLessThan(huge.length);
	});

	it("returns nothing when the fixed content alone exceeds the budget", () => {
		expect(
			applyTokenBudget({
				applicationLogs: "logs",
				backlog: huge,
				systemPrompt: huge,
				userPrompt: huge,
			}),
		).toEqual({
			backlog: "",
			pmWorkItems: "",
			meetingTranscriptBudget: { requestedTokens: 0, grantedTokens: 0 },
		});
	});
});

describe("work-item budget protects meeting evidence", () => {
	const lines = (prefix: string, count: number) =>
		Array.from(
			{ length: count },
			(_, i) => `- [${prefix}:${i}] ${"x".repeat(390)}`,
		).join("\n");

	it("keeps a whole meeting when the backlog alone exceeds the old budget", () => {
		const meetingTranscripts = "meeting evidence ".repeat(2_000);
		const backlog = lines("id", 1_000);
		const out = applyTokenBudget({
			backlog,
			meetingTranscripts,
			systemPrompt: "",
			userPrompt: "",
		});
		expect(out.meetingTranscripts).toBe(meetingTranscripts);
		expect(out.backlog).toContain("- [id:0]");
		expect(out.backlog).not.toContain("- [id:999]");
		const kept = out.backlog
			.split("\n")
			.filter((line) => line.startsWith("- "));
		expect(out.backlog).toContain(
			`(${1_000 - kept.length} more existing work items not shown)`,
		);
		expect(kept.join("\n")).toBe(
			backlog.split("\n").slice(0, kept.length).join("\n"),
		);
		expect(
			Math.ceil(out.backlog.length / 4) +
				Math.ceil(meetingTranscripts.length / 4),
		).toBeLessThanOrEqual(80_000);
	});

	it("trims PM lines before touching Fabric ids", () => {
		const backlog = lines("id", 200);
		const out = applyTokenBudget({
			backlog,
			pmWorkItems: lines("pm", 200),
			meetingTranscripts: "m".repeat(200_000),
			systemPrompt: "",
			userPrompt: "",
		});
		expect(out.backlog).toBe(backlog);
		expect(out.pmWorkItems).toContain("- [pm:0]");
		expect(out.pmWorkItems).not.toContain("- [pm:199]");
		expect(out.pmWorkItems).toMatch(/\(\d+ more PM work items not shown\)/);
	});

	it("drops the whole PM list before trimming the end of the Fabric backlog", () => {
		const out = applyTokenBudget({
			backlog: lines("id", 400),
			pmWorkItems: lines("pm", 200),
			meetingTranscripts: "m".repeat(200_000),
			systemPrompt: "",
			userPrompt: "",
		});
		expect(out.pmWorkItems).toBe("(200 more PM work items not shown)");
		expect(out.backlog).toContain("- [id:0]");
		expect(out.backlog).not.toContain("- [id:399]");
	});

	it("reserves a useful work-item floor even for an oversized meeting", () => {
		const out = applyTokenBudget({
			backlog: lines("id", 400),
			meetingTranscripts: huge,
			systemPrompt: "",
			userPrompt: "",
		});
		expect(out.backlog).toContain("- [id:0]");
		expect(out.backlog.length).toBeGreaterThan(30_000);
		expect(out.backlog.length).toBeLessThanOrEqual(32_000);
		expect(out.meetingTranscripts?.length).toBeLessThan(huge.length);
	});

	it("does not repeat synced PM items across any PM category", () => {
		const prompt = buildAnalysisPrompt({
			fetchedContext: {},
			userPrompt: "Analyze context",
			existingBacklog: {
				stories: [
					{
						id: "example-item",
						identifier: "WI-001",
						title: "Existing work",
						externalId: "101",
					},
				],
			},
			pmWorkItems: {
				epics: [{ id: "101", title: "Synced epic" }],
				features: [{ id: "101", title: "Synced feature" }],
				stories: [
					{ id: "101", title: "Synced story" },
					{ id: "102", title: "Unmatched work" },
				],
			},
		});
		expect(prompt).toContain("[extId:101]");
		expect(prompt).not.toContain("- [101]");
		expect(prompt).toContain("- [102] Unmatched work");
		expect(prompt).toContain(
			"Synced items appear in the Existing Backlog with [extId:...]",
		);
	});

	it.each(["standard", "explore", "recommend"] as const)(
		"pins the pre-fix small %s prompt byte for byte",
		(intakeMode) => {
			const prompt = buildAnalysisPrompt({
				intakeMode,
				userPrompt: "Analyze the selected context.",
				fetchedContext: {
					meetingTranscripts: "Meeting: improve exports.",
					architectureDecisions: "Use the existing queue.",
					applicationLogs: "Example warning",
					slackMessages: "Example discussion",
				},
				existingBacklog: {
					stories: [
						{
							id: "example-item",
							identifier: "WI-001",
							title: "Export reports",
							externalId: "101",
							priority: "HIGH",
							size: "M",
						},
					],
				},
			});
			expect(
				createHash("sha256").update(prompt).digest("hex"),
			).toMatchSnapshot();
		},
	);
});

it("counts the truncation notice inside the allocated tokens", () => {
	const out = applyTokenBudget({
		backlog: small,
		meetingTranscripts: huge,
		systemPrompt: small,
		userPrompt: small,
	});
	expect(
		500 +
			Math.ceil(out.backlog.length / 4) +
			Math.ceil((out.meetingTranscripts?.length ?? 0) / 4),
	).toBeLessThanOrEqual(80_000);
});

it("removes 1,050 repeated PM lines from a synthetic 1,300-item backlog", () => {
	const stories = Array.from({ length: 1_300 }, (_, i) => ({
		id: `example-item-${i}`,
		identifier: `WI-${i}`,
		title: `Example work ${i}`,
		externalId: i < 1_050 ? String(i + 1) : undefined,
	}));
	const prompt = buildAnalysisPrompt({
		userPrompt: "Analyze context",
		fetchedContext: {},
		existingBacklog: { stories },
		pmWorkItems: {
			epics: [],
			features: [],
			stories: Array.from({ length: 1_051 }, (_, i) => ({
				id: String(i + 1),
				title: `Example PM work ${i}`,
			})),
		},
	});
	const pmLines = prompt
		.split("\n")
		.filter((line) => /^- \[\d+\]/.test(line));
	expect(pmLines).toEqual(["- [1051] Example PM work 1050"]);
	expect(
		prompt.split("\n").filter((line) => line.startsWith("- WI-")).length,
	).toBe(1_300);
});

it("retains PM ids when sync keys and list ids differ", () => {
	const prompt = buildAnalysisPrompt({
		userPrompt: "Analyze context",
		fetchedContext: {},
		existingBacklog: {
			stories: [
				{
					id: "example-item",
					identifier: "WI-001",
					title: "Existing work",
					externalId: "EXAMPLE-101",
				},
			],
		},
		pmWorkItems: {
			epics: [],
			features: [],
			stories: [{ id: "101", title: "External work" }],
		},
	});
	expect(prompt).toContain("[extId:EXAMPLE-101]");
	expect(prompt).toContain("- [101] External work");
});

it("keeps a fitting short backlog when its omission notice would cost more than its last row", () => {
	const backlog = "- [id:1]\n- [id:2]";
	const out = applyTokenBudget({
		backlog,
		pmWorkItems: `- [101] ${"x".repeat(1_000)}`,
		systemPrompt: "s".repeat(319_940),
		userPrompt: "",
	});
	expect(out.backlog).toBe(backlog);
	expect(out.pmWorkItems).toBe("(1 more PM work item not shown)");
});

it("pins a small PM prompt body apart from the requested header and rule changes", () => {
	const prompt = buildAnalysisPrompt({
		userPrompt: "Analyze the selected context.",
		fetchedContext: { meetingTranscripts: "Meeting: improve exports." },
		existingBacklog: {
			stories: [
				{
					id: "example-item",
					identifier: "WI-001",
					title: "Export reports",
				},
			],
		},
		pmWorkItems: {
			epics: [
				{
					id: "101",
					title: "Example epic",
					description: "Example description",
					url: "https://example.com/items/101",
				},
			],
			features: [{ id: "102", title: "Example feature" }],
			stories: [{ id: "103", title: "Example work" }],
		},
	});
	const body = prompt.slice(prompt.indexOf("### PM Epics"));
	expect(createHash("sha256").update(body).digest("hex")).toMatchSnapshot();
});

it.each(["backlog", "pmWorkItems"] as const)(
	"uses a singular omission notice for one trimmed %s item",
	(key) => {
		const out = applyTokenBudget({
			backlog: "",
			[key]: `- [101] ${"x".repeat(400)}`,
			systemPrompt: "x".repeat(319_920),
			userPrompt: "",
		});
		expect(out[key]).toBe(
			`(1 more ${key === "backlog" ? "existing" : "PM"} work item not shown)`,
		);
	},
);

it("keeps the PM header neutral for a create-only caller", () => {
	const prompt = buildAnalysisPrompt({
		userPrompt: "Capture discussion",
		allowUpdates: false,
		fetchedContext: {},
		existingBacklog: { stories: [] },
		pmWorkItems: {
			epics: [],
			features: [],
			stories: [{ id: "101", title: "Example work" }],
		},
	});
	expect(prompt).not.toContain("Compare both lists before proposing creates");
	expect(prompt).toContain("## Current PM Tool Backlog");
	expect(prompt).toContain("Do not deduplicate against the existing backlog");
});

it("omits the PM reference from the closing instruction when the PM section is dropped", () => {
	const prompt = buildAnalysisPrompt({
		userPrompt: "x".repeat(320_000),
		fetchedContext: {},
		existingBacklog: { stories: [] },
		pmWorkItems: {
			epics: [],
			features: [],
			stories: [{ id: "101", title: "Example work" }],
		},
	});
	expect(prompt).not.toContain("## Current PM Tool Backlog");
	expect(prompt).toContain(
		"Analyze the fetched context against the existing backlog and propose structured changes.",
	);
});
