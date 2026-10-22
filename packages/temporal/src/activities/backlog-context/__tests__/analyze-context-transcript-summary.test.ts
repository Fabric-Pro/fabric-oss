import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	generateObject: vi.fn(),
	generateText: vi.fn(),
	getModel: vi.fn(),
	info: vi.fn(),
	heartbeat: vi.fn(),
	execTool: vi.fn(),
	trackUsage: vi.fn(),
	logUsage: vi.fn(),
	current: vi.fn(),
	outputBudget: vi.fn(),
	redisGet: vi.fn(),
	redisSet: vi.fn(),
}));
vi.mock("@repo/ai", () => ({
	generateObject: mocks.generateObject,
	generateText: mocks.generateText,
	getAIModelWithMetadata: mocks.getModel,
	logModelUsageAsync: mocks.logUsage,
}));
vi.mock("@repo/ai/lib/output-token-budget", () => ({
	computeScaledOutputTokenBudget: (...args: unknown[]) =>
		mocks.outputBudget(...args),
}));
vi.mock("@repo/database", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	getBoundPromptForAgent: async () => null,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: mocks.info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@temporalio/activity", async () => ({
	ApplicationFailure: (await import("@temporalio/common")).ApplicationFailure,
	heartbeat: mocks.heartbeat,
	Context: {
		current: mocks.current,
	},
}));

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: mocks.execTool,
}));
vi.mock("../../../lib/redis-cache", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../lib/redis-cache")>();
	return {
		...actual,
		RedisCache: { get: mocks.redisGet, set: mocks.redisSet },
		CacheKeys: {
			...actual.CacheKeys,
			meetingTranscript: () => "example-cache-key",
		},
	};
});
vi.mock("@repo/mcp", () => ({ getCachedMcpClientForConfig: vi.fn() }));
vi.mock("@repo/rag", () => ({
	formatContextsForPrompt: vi.fn(),
	retrieveProjectContexts: vi.fn(),
}));
vi.mock("@repo/utils", () => ({ getBaseUrl: vi.fn() }));
vi.mock("../../search-project-slack-messages", () => ({
	fetchRecentSlackMessages: vi.fn(),
}));
vi.mock("../../search-project-teams-messages", () => ({
	fetchRecentTeamsMessages: vi.fn(),
}));

import {
	analyzeContextAndPropose,
	buildAnalysisPrompt,
} from "../analyze-context";
import { fetchMeetingTranscript } from "../fetch-context";

const INPUT = {
	projectId: "example-project",
	userId: "example-user",
	organizationId: "example-org",
	existingBacklog: { stories: [] },
	userPrompt: "Analyze the meeting requests.",
	allowUpdates: false,
	deferDecisionPrecheck: true,
};
const meeting = (label: string, length: number) =>
	`${label}: `.padEnd(length, label);
const run = (transcripts: string[], architectureDecisions?: string) =>
	analyzeContextAndPropose({
		...INPUT,
		fetchedContext: {
			meetingTranscripts: transcripts,
			architectureDecisions,
		},
	});
const prompt = (): string => mocks.generateObject.mock.calls[0][0].prompt;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.outputBudget.mockReturnValue(16_384);
	mocks.current.mockImplementation(() => {
		throw new Error("outside activity");
	});
	mocks.redisGet.mockReset().mockResolvedValue(null);
	mocks.redisSet.mockReset().mockResolvedValue(undefined);
	mocks.getModel.mockResolvedValue({
		model: {},
		metadata: {},
		trackUsage: mocks.trackUsage,
	});
	mocks.generateObject.mockResolvedValue({
		object: { changes: [], summary: "Analyzed" },
		usage: {},
	});
	mocks.generateText.mockReset().mockResolvedValue({
		text: "- Preserve the requested export.",
		usage: {},
	});
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("meeting summaries use the analysis grant", () => {
	it("passes a fitting 70K transcript to the analysis model verbatim", async () => {
		const transcript = meeting("small", 70_000);
		mocks.execTool.mockImplementation(async (method: string) => {
			if (method === "get_meeting_by_join_url") {
				return {
					meeting: { id: "example-meeting", subject: "Planning" },
				};
			}
			if (method === "list_meeting_transcripts") {
				return { transcripts: [{ id: "example-transcript" }] };
			}
			return { content: transcript };
		});
		const fetched = await fetchMeetingTranscript({
			joinUrl: "https://example.com/meeting",
			userId: INPUT.userId,
			organizationId: INPUT.organizationId,
		});
		expect(fetched.success).toBe(true);
		await run([fetched.transcript]);
		expect(prompt()).toContain(transcript);
		expect(mocks.generateText).not.toHaveBeenCalled();
		expect(mocks.getModel).toHaveBeenCalledTimes(1);
	});

	// The former activity truncated the joined raw section without a summary pass.
	it("summarizes the largest meetings and keeps smaller meetings in input order", async () => {
		const smaller = meeting("smaller", 70_000);
		const largest = meeting("largest", 200_000);
		const middle = meeting("middle", 160_000);
		await run([smaller, largest, middle]);
		expect(mocks.generateText).toHaveBeenCalledTimes(1);
		expect(mocks.generateText.mock.calls[0][0].prompt).toContain(largest);
		expect(prompt()).toContain(
			`${smaller}\n\n---\n\n## Meeting Summary: Meeting\n\n- Preserve the requested export.\n\n---\n\n${middle}`,
		);
		expect(mocks.getModel).toHaveBeenCalledWith(
			{ taskType: "COMPLEX", complexity: "medium" },
			{
				userId: "example-user",
				organizationId: "example-org",
				projectId: "example-project",
				featureKey: "backlog-update",
			},
		);
		expect(mocks.generateText.mock.calls[0][0].maxOutputTokens).toBe(
			16_384,
		);
		expect(mocks.trackUsage).toHaveBeenCalledTimes(2);
		expect(mocks.logUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				taskType: "COMPLEX",
				projectId: "example-project",
				context: {
					userId: "example-user",
					organizationId: "example-org",
				},
			}),
		);
		const logs = mocks.info.mock.calls.filter(
			(call) => call[1]?.event === "backlog.meeting_transcript_summaries",
		);
		expect(logs).toHaveLength(1);
		expect(logs[0][1]).toMatchObject({
			meetingCount: 3,
			summarizedCount: 1,
			before: { requestedTokens: 107504 },
			after: {
				requestedTokens: expect.any(Number),
				grantedTokens: expect.any(Number),
			},
		});
		expect(logs[0][1].before.grantedTokens).toBeLessThan(107504);
		expect(logs[0][1].after.grantedTokens).toBe(
			logs[0][1].after.requestedTokens,
		);
	});

	it.each(["error", "empty"])(
		"retains the original for budget truncation on summary %s",
		async (failure) => {
			const transcript = meeting("original", 400_000);
			if (failure === "error") {
				mocks.generateText.mockRejectedValue(
					new Error("summary unavailable"),
				);
			} else {
				mocks.generateText.mockResolvedValue({ text: " ", usage: {} });
			}
			await expect(run([transcript])).resolves.toMatchObject({
				summary: "Analyzed",
			});
			expect(mocks.generateText).toHaveBeenCalledTimes(1);
			expect(mocks.redisSet).not.toHaveBeenCalled();
			expect(prompt()).toContain(transcript.slice(0, 10_000));
			expect(prompt()).toContain(
				"[... truncated to fit token budget ...]",
			);
			const logs = mocks.info.mock.calls.filter(
				(call) =>
					call[1]?.event === "backlog.meeting_transcript_summaries",
			);
			expect(logs[0][1]).toMatchObject({
				summarizedCount: 0,
				selectedCount: 1,
				before: { requestedTokens: 100000 },
				after: { requestedTokens: 100000 },
			});
		},
	);

	it("keeps heartbeats running and limits concurrent summaries to six", async () => {
		vi.useFakeTimers();
		let active = 0;
		let peak = 0;
		mocks.generateText.mockImplementation(async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 20_000));
			active--;
			return { text: "Summary", usage: {} };
		});
		const analysis = run(
			Array.from({ length: 10 }, (_, i) =>
				meeting(`meeting-${i}`, 200_000),
			),
		);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(peak).toBe(6);
		expect(mocks.heartbeat).toHaveBeenCalledWith(
			expect.objectContaining({
				keepalive: true,
				stage: "summarize-meetings",
			}),
		);
		await vi.advanceTimersByTimeAsync(20_000);
		await analysis;
		expect(vi.getTimerCount()).toBe(0);
	});
});

// The selected extract uses the room left after the two raw meetings and separators.
it("reserves separators when sizing the selected meeting extract", async () => {
	const smaller = meeting("small", 10_000);
	const middle = meeting("middle", 100_000);
	const largest = meeting("large", 200_000);
	buildAnalysisPrompt({
		...INPUT,
		fetchedContext: {
			meetingTranscripts: "probe",
			architectureDecisions: "probe",
		},
	});
	const baseline = mocks.info.mock.calls.find(
		(call) => call[1]?.event === "backlog.context_budget",
	)?.[1];
	const reserved = Math.min(8_000, baseline.backlogBlock.requestedTokens);
	const decisions = "x".repeat(
		(baseline.availableForContext - reserved - 32_008) * 4,
	);
	mocks.info.mockClear();
	await run([smaller, largest, middle], decisions);
	expect(mocks.generateText).toHaveBeenCalledTimes(1);
	expect(mocks.generateText.mock.calls[0][0].prompt).toContain(largest);
	// The prompt states half the target; an odd bucket reads one character low.
	const target =
		2 *
		Number(
			mocks.generateText.mock.calls[0][0].instructions.match(
				/about (\d+) characters/,
			)?.[1],
		);
	expect(
		target +
			"## Meeting Summary: Meeting\n\n".length +
			100_000 +
			10_000 +
			14,
	).toBeLessThanOrEqual(32_008 * 4);
	expect(prompt()).toContain(middle);
	expect(prompt()).toContain(smaller);
	expect(prompt()).not.toContain("[... truncated to fit token budget ...]");
	const log = mocks.info.mock.calls.find(
		(call) => call[1]?.event === "backlog.meeting_transcript_summaries",
	)?.[1];
	expect(log.before.grantedTokens).toBe(32_008);
});

it("lets the budget truncate a summary longer than its estimate", async () => {
	mocks.generateText.mockResolvedValue({
		text: "unexpectedly long ".repeat(30_000),
		usage: {},
	});
	await expect(run([meeting("raw", 400_000)])).resolves.toMatchObject({
		summary: "Analyzed",
	});
	expect(mocks.generateText).toHaveBeenCalledTimes(1);
	expect(prompt()).toContain("## Meeting Summary: Meeting");
	expect(prompt()).toContain("[... truncated to fit token budget ...]");
});

function decisionsForGrant(grant: number): string {
	buildAnalysisPrompt({
		...INPUT,
		fetchedContext: {
			meetingTranscripts: "probe",
			architectureDecisions: "probe",
		},
	});
	const log = mocks.info.mock.calls
		.filter((call) => call[1]?.event === "backlog.context_budget")
		.at(-1)?.[1];
	return "x".repeat(
		(log.availableForContext -
			Math.min(8_000, log.backlogBlock.requestedTokens) -
			grant) *
			4,
	);
}

it("stops after actual round results fit instead of summarizing the initial estimate", async () => {
	const transcripts = Array.from({ length: 15 }, (_, i) =>
		meeting(`meeting-${i}`, 65_000),
	);
	mocks.generateText.mockResolvedValue({
		text: "s".repeat(4_163),
		usage: {},
	});
	await run(transcripts);
	expect(mocks.generateText).toHaveBeenCalledTimes(11);
	for (const text of transcripts.slice(11)) {
		expect(prompt()).toContain(text);
	}
	expect(prompt()).not.toContain("[... truncated to fit token budget ...]");
});

it("stops new rounds when the remaining time reaches the analysis reserve", async () => {
	vi.useFakeTimers();
	const started = Date.now();
	mocks.current.mockReturnValue({
		info: {
			currentAttemptScheduledTimestampMs: started,
			startToCloseTimeoutMs: 250_000,
		},
	});
	mocks.generateText.mockImplementation(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10_000));
		return { text: "s".repeat(4_163), usage: {} };
	});
	const analysis = run(
		Array.from({ length: 15 }, (_, i) => meeting(`meeting-${i}`, 65_000)),
	);
	await vi.advanceTimersByTimeAsync(10_000);
	expect(mocks.generateText).toHaveBeenCalledTimes(6);
	expect(mocks.generateObject).toHaveBeenCalledTimes(1);
	expect(mocks.info).toHaveBeenCalledWith(
		expect.any(String),
		expect.objectContaining({
			event: "backlog.meeting_transcript_summary_deadline",
		}),
	);
	await analysis;
});

it("does not start a round without its reserve plus time for analysis and merge", async () => {
	mocks.current.mockReturnValue({
		info: {
			currentAttemptScheduledTimestampMs: Date.now(),
			startToCloseTimeoutMs: 180_000,
		},
	});
	await run([meeting("original", 400_000)]);
	expect(mocks.generateText).not.toHaveBeenCalled();
	expect(mocks.generateObject).toHaveBeenCalledTimes(1);
});

it("aborts a slow summary at its call timeout and continues analysis", async () => {
	vi.useFakeTimers();
	mocks.generateText.mockImplementation(() => new Promise(() => {}));
	const analysis = run([meeting("original", 400_000)]);
	await vi.advanceTimersByTimeAsync(60_000);
	const signal = mocks.generateText.mock.calls[0][0].abortSignal;
	expect(signal).toBeInstanceOf(AbortSignal);
	expect(signal.aborted).toBe(true);
	expect(mocks.generateObject).toHaveBeenCalledTimes(1);
	expect(mocks.redisSet).not.toHaveBeenCalled();
	await analysis;
	expect(vi.getTimerCount()).toBe(0);
});

it("reuses a successful cached summary on a later attempt", async () => {
	const cache = new Map<string, unknown>();
	mocks.redisGet.mockImplementation(
		async (key: string) => cache.get(key) ?? null,
	);
	mocks.redisSet.mockImplementation(async (key: string, value: unknown) => {
		cache.set(key, value);
	});
	const transcript = meeting("original", 400_000);
	await run([transcript]);
	await run([transcript]);
	expect(mocks.generateText).toHaveBeenCalledTimes(1);
	expect(mocks.redisSet).toHaveBeenCalledWith(
		expect.any(String),
		expect.stringContaining("Preserve the requested export"),
		604800,
	);
	expect(mocks.generateObject).toHaveBeenCalledTimes(2);
});

it.each(["get", "set"])(
	"tolerates a Redis summary cache %s error",
	async (operation) => {
		if (operation === "get") {
			mocks.redisGet.mockRejectedValue(new Error("cache unavailable"));
		} else {
			mocks.redisSet.mockRejectedValue(new Error("cache unavailable"));
		}
		await expect(
			run([meeting("original", 400_000)]),
		).resolves.toMatchObject({ summary: "Analyzed" });
		expect(mocks.generateText).toHaveBeenCalledTimes(1);
		expect(
			mocks[operation === "get" ? "redisGet" : "redisSet"],
		).toHaveBeenCalled();
	},
);

it("bounds Redis wait time before continuing without a cache", async () => {
	vi.useFakeTimers();
	mocks.redisGet.mockImplementation(() => new Promise(() => {}));
	mocks.redisSet.mockImplementation(() => new Promise(() => {}));
	const analysis = run([meeting("original", 400_000)]);
	await vi.advanceTimersByTimeAsync(5_000);
	expect(mocks.redisGet).toHaveBeenCalled();
	expect(mocks.redisSet).toHaveBeenCalled();
	expect(mocks.generateObject).toHaveBeenCalledTimes(1);
	await analysis;
});

it("passes background job identity to summary model resolution and usage logging", async () => {
	await analyzeContextAndPropose({
		...INPUT,
		jobType: "meeting-transcript-sync",
		fetchedContext: { meetingTranscripts: [meeting("original", 400_000)] },
	});
	expect(mocks.getModel).toHaveBeenCalledWith(
		{ taskType: "COMPLEX", complexity: "medium" },
		expect.objectContaining({ jobType: "meeting-transcript-sync" }),
	);
	expect(mocks.logUsage).toHaveBeenCalledWith(
		expect.objectContaining({
			taskType: "COMPLEX",
			context: expect.objectContaining({
				jobType: "meeting-transcript-sync",
			}),
		}),
	);
});

it("skips summaries when the meeting grant is below the useful minimum", async () => {
	await expect(
		run([meeting("original", 400_000)], decisionsForGrant(127)),
	).rejects.toMatchObject({ type: "MEETING_TRANSCRIPT_BUDGET_EXHAUSTED" });
	expect(mocks.generateText).not.toHaveBeenCalled();
});

it.each(["organizationId", "projectId"] as const)(
	"does not reuse summaries across %s boundaries",
	async (field) => {
		const cache = new Map<string, unknown>();
		mocks.redisGet.mockImplementation(
			async (key: string) => cache.get(key) ?? null,
		);
		mocks.redisSet.mockImplementation(
			async (key: string, value: unknown) => {
				cache.set(key, value);
			},
		);
		const transcript = meeting("original", 400_000);
		await run([transcript]);
		await analyzeContextAndPropose({
			...INPUT,
			[field]: "another-example-scope",
			fetchedContext: { meetingTranscripts: [transcript] },
		});
		expect(mocks.generateText).toHaveBeenCalledTimes(2);
	},
);

it("logs actual summary attempt latency and distinguishes timeouts from successes", async () => {
	vi.useFakeTimers();
	mocks.generateText
		.mockImplementationOnce(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5_000));
			return { text: "Summary", usage: {} };
		})
		.mockImplementationOnce(() => new Promise(() => {}));
	const analysis = run([
		meeting("first", 400_000),
		meeting("second", 400_000),
	]);
	await vi.advanceTimersByTimeAsync(60_000);
	await analysis;
	const event = mocks.info.mock.calls.find(
		(call) => call[1]?.event === "backlog.meeting_transcript_summaries",
	)?.[1];
	expect(event).toMatchObject({
		timedOutCount: 1,
		summaryCallLatenciesMs: [5_000, 60_000],
		selectedCount: 2,
		summarizedCount: 1,
	});
});

it("reports no summary call latency or timeout for a cached summary", async () => {
	mocks.redisGet.mockResolvedValue("Cached summary");
	await run([meeting("original", 400_000)]);
	const event = mocks.info.mock.calls.find(
		(call) => call[1]?.event === "backlog.meeting_transcript_summaries",
	)?.[1];
	expect(event).toMatchObject({
		cacheHitCount: 1,
		timedOutCount: 0,
		summaryCallLatenciesMs: [],
	});
	expect(mocks.generateText).not.toHaveBeenCalled();
});

it("splits remaining room across selected meetings including headings and separators", async () => {
	const { summarizeMeetingsToFit } = await import(
		"../summarize-meetings-to-fit"
	);
	await summarizeMeetingsToFit(
		[
			meeting("large", 100_000),
			meeting("middle", 80_000),
			meeting("small", 5_000),
		],
		10_000,
		INPUT,
	);
	expect(mocks.generateText).toHaveBeenCalledTimes(2);
	for (const [call] of mocks.generateText.mock.calls) {
		// The prompt states half the target; an odd bucket reads one character low.
		const target =
			2 * Number(call.instructions.match(/about (\d+) characters/)?.[1]);
		const room =
			Math.floor((40_000 - 5_000 - 14) / 2) -
			"## Meeting Summary: Meeting\n\n".length;
		expect(target).toBeLessThanOrEqual(room);
		expect(target).toBe(Math.min(room, 12_000));
	}
});
it("clamps analysis targets to a useful floor and below the source length", async () => {
	const { summarizeMeetingsToFit } = await import(
		"../summarize-meetings-to-fit"
	);
	await summarizeMeetingsToFit(
		[meeting("large", 10_000), meeting("small", 2_000)],
		128,
		INPUT,
	);
	for (const [call] of mocks.generateText.mock.calls) {
		expect(call.instructions).toContain("about 512 characters");
	}
	expect(mocks.generateText).toHaveBeenCalledTimes(2);
});

it("bounds a target below a short source even when there is ample room", async () => {
	const { transcriptSummaryTargetChars } = await import(
		"../summarize-transcript"
	);
	expect(transcriptSummaryTargetChars(80_000, 2_000)).toBe(1_600);
});

it("caps an analysis target at the amount sized for its call deadline", async () => {
	const { summarizeMeetingsToFit } = await import(
		"../summarize-meetings-to-fit"
	);
	await summarizeMeetingsToFit([meeting("large", 400_000)], 70_000, INPUT);
	expect(mocks.generateText.mock.calls[0][0].instructions).toContain(
		"about 6000 characters",
	);
});
it.each([245_000, 300_000])(
	"admits a round only above the combined reserves (%i ms)",
	async (remainingMs) => {
		vi.useFakeTimers();
		mocks.current.mockReturnValue({
			info: {
				currentAttemptScheduledTimestampMs: Date.now(),
				startToCloseTimeoutMs: remainingMs,
			},
		});
		await run([meeting("large", 400_000)]);
		expect(mocks.generateText).toHaveBeenCalledTimes(
			remainingMs > 245_000 ? 1 : 0,
		);
	},
);
it("allows a summary past 45 seconds and aborts at 60 seconds", async () => {
	vi.useFakeTimers();
	mocks.generateText.mockImplementation(() => new Promise(() => {}));
	const analysis = run([meeting("large", 400_000)]);
	await vi.advanceTimersByTimeAsync(59_999);
	expect(mocks.generateText.mock.calls[0][0].abortSignal.aborted).toBe(false);
	expect(mocks.generateObject).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	await analysis;
	expect(mocks.generateText.mock.calls[0][0].abortSignal.aborted).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});

it("reuses a provider-shortened analysis extract under the requested bucket", async () => {
	const { summarizeMeetingsToFit } = await import(
		"../summarize-meetings-to-fit"
	);
	mocks.outputBudget.mockReturnValue(2_000);
	const cache = new Map<string, string>();
	mocks.redisGet.mockImplementation(
		async (key: string) => cache.get(key) ?? null,
	);
	mocks.redisSet.mockImplementation(async (key: string, value: string) => {
		cache.set(key, value);
	});
	const transcripts = [meeting("large", 400_000)];
	await summarizeMeetingsToFit(transcripts, 70_000, INPUT);
	await summarizeMeetingsToFit(transcripts, 70_000, INPUT);
	expect(mocks.generateText).toHaveBeenCalledTimes(1);
	expect(mocks.generateText.mock.calls[0][0].instructions).toContain(
		"about 1562 characters",
	);
	expect(
		[...cache.keys()].some((key) =>
			key.startsWith("transcript-summary:v4:12000:"),
		),
	).toBe(true);
});

it.each(["length", "stop"] as const)(
	"uses the analysis extract and caches it only when complete (%s)",
	async (finishReason) => {
		mocks.generateText.mockResolvedValue({
			text: "- Example speaker requested export",
			finishReason,
			usage: {},
		});
		await run([meeting("large", 400_000)]);
		expect(prompt()).toContain("- Example speaker requested export");
		const partial = finishReason === "length";
		const writes = mocks.redisSet.mock.calls.filter(([key]) =>
			key.startsWith("transcript-summary:"),
		);
		expect(writes).toHaveLength(partial ? 0 : 1);
		expect(mocks.info).toHaveBeenCalledWith(
			"[BacklogContext] Transcript summarized",
			expect.objectContaining({ partial }),
		);
		expect(mocks.info).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				event: "backlog.meeting_transcript_summaries",
				partial,
				partialCount: partial ? 1 : 0,
			}),
		);
	},
);
