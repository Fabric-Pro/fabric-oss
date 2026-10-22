/**
 * Tests the per-user Redis transcript cache added to fetchMeetingTranscript:
 *  - a Redis cache hit returns immediately and never calls Microsoft Graph,
 *  - a cache miss fetches live and write-through caches the result.
 *
 * (The DB ProjectLinkedMeeting cache is mocked to miss so we isolate the new
 * Redis layer.)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const heartbeatMock = vi.fn();
const logInfo = vi.fn();
const currentActivity = vi.fn();
const generateTextMock = vi.fn();
const modelMetadata = vi.fn();
const execTool = vi.fn();
const redisGet = vi.fn();
const redisSet = vi.fn();
const findLinkedMeeting = vi.fn();
const transcriptKey = vi.fn((..._args: unknown[]) => "tkey");

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: (...a: unknown[]) => execTool(...a),
}));
// +1 `../` vs fetch-context's import — vi.mock resolves relative to this test.
vi.mock("../../../lib/redis-cache", async (importOriginal) => ({
	RedisCache: {
		get: (...a: unknown[]) => redisGet(...a),
		set: (...a: unknown[]) => redisSet(...a),
	},
	CacheKeys: {
		...(await importOriginal<typeof import("../../../lib/redis-cache")>())
			.CacheKeys,
		meetingTranscript: (...args: unknown[]) => transcriptKey(...args),
	},
	CacheTTL: { meetingTranscript: 604800 },
}));
vi.mock("@repo/database", () => ({
	db: {
		projectLinkedMeeting: {
			findUnique: (...a: unknown[]) => findLinkedMeeting(...a),
		},
		projectContext: {
			findUnique: vi.fn(),
			findMany: vi.fn().mockResolvedValue([]),
		},
	},
}));
vi.mock("@repo/ai", () => ({
	generateText: (...args: unknown[]) => generateTextMock(...args),
	getAIModelWithMetadata: async () => ({
		model: {},
		metadata: modelMetadata(),
		trackUsage: vi.fn(),
	}),
	logModelUsageAsync: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: {
		info: (...args: unknown[]) => logInfo(...args),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));
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

vi.mock("@temporalio/activity", () => ({
	heartbeat: (...args: unknown[]) => heartbeatMock(...args),
	Context: { current: () => currentActivity() },
}));

import { fetchMeetingTranscript } from "../fetch-context";

beforeEach(() => {
	logInfo.mockClear();
	modelMetadata.mockReset().mockReturnValue({ provider: "DATABRICKS" });
	currentActivity.mockReset().mockImplementation(() => {
		throw new Error("outside activity");
	});
	generateTextMock
		.mockReset()
		.mockResolvedValue({ text: "Summary", usage: {} });
	execTool.mockReset();
	transcriptKey.mockReset().mockReturnValue("tkey");
	redisGet.mockReset().mockResolvedValue(null);
	redisSet.mockReset().mockResolvedValue(undefined);
	findLinkedMeeting.mockReset().mockResolvedValue(null); // DB cache miss
});

describe("fetchMeetingTranscript — Redis transcript cache", () => {
	it("returns the Redis-cached transcript and never calls Microsoft Graph", async () => {
		redisGet.mockResolvedValue({
			success: true,
			transcript: "cached text",
			meetingSubject: "Standup",
			wasSummarized: false,
		});

		const result = await fetchMeetingTranscript({
			joinUrl: "u1",
			startTime: "2026-06-11T10:00:00Z",
			userId: "user-1",
			projectId: "p1",
		});

		expect(result).toMatchObject({
			success: true,
			transcript: "cached text",
		});
		expect(execTool).not.toHaveBeenCalled();
		expect(redisSet).not.toHaveBeenCalled();
	});

	it("fetches live on a cache miss and write-through caches the result", async () => {
		execTool.mockImplementation(async (method: string) => {
			if (method === "get_meeting_by_join_url") {
				return { meeting: { id: "m1", subject: "Standup" } };
			}
			if (method === "list_meeting_transcripts") {
				return {
					transcripts: [
						{ id: "t1", createdDateTime: "2026-06-11T10:00:00Z" },
					],
				};
			}
			if (method === "get_meeting_transcript_content") {
				return { entries: [{ speaker: "Alice", text: "hello" }] };
			}
			return {};
		});

		const result = await fetchMeetingTranscript({
			joinUrl: "u1",
			startTime: "2026-06-11T10:00:00Z",
			userId: "user-1",
			projectId: "p1",
		});

		expect(result).toMatchObject({
			success: true,
			transcript: "Alice: hello",
			wasSummarized: false,
		});
		expect(redisSet).toHaveBeenCalledWith(
			"tkey",
			expect.objectContaining({
				success: true,
				transcript: "Alice: hello",
			}),
			604800,
		);
	});
});

describe("fetchMeetingTranscript — recurring occurrence pick (Fizzy #3253)", () => {
	function wireSeries(
		transcripts: Array<{ id: string; createdDateTime?: string }>,
	) {
		execTool.mockImplementation(
			async (method: string, args: { transcriptId?: string }) => {
				if (method === "get_meeting_by_join_url") {
					return { meeting: { id: "m1", subject: "Standup" } };
				}
				if (method === "list_meeting_transcripts") {
					return { transcripts };
				}
				return {
					entries: [
						{ speaker: "Alice", text: `${args.transcriptId}` },
					],
				};
			},
		);
	}
	const fetchedIds = () =>
		execTool.mock.calls
			.filter(([method]) => method === "get_meeting_transcript_content")
			.map(([, args]) => (args as { transcriptId: string }).transcriptId);

	it.each([
		[
			"only another day's transcript",
			[{ id: "t-12", createdDateTime: "2026-10-12T16:00:57Z" }],
		],
		[
			"no transcript near the selected day",
			[
				{ id: "t-12", createdDateTime: "2026-10-12T16:00:57Z" },
				{ id: "t-13", createdDateTime: "2026-10-13T16:01:10Z" },
			],
		],
		["an undated transcript", [{ id: "t-x" }]],
	])(
		"reports no transcript, fetches nothing and caches nothing for %s",
		async (_label, transcripts) => {
			wireSeries(transcripts);
			const result = await fetchMeetingTranscript({
				joinUrl: "u1",
				startTime: "2026-10-14T16:00:00Z",
				userId: "user-1",
				projectId: "p1",
			});
			expect(result).toMatchObject({ success: false, transcript: "" });
			expect(result.error).toMatch(/No transcript available/);
			expect(fetchedIds()).toEqual([]);
			expect(redisSet).not.toHaveBeenCalled();
		},
	);

	it("picks the selected occurrence's transcript among the series", async () => {
		wireSeries([
			{ id: "t-12", createdDateTime: "2026-10-12T16:00:57Z" },
			{ id: "t-13", createdDateTime: "2026-10-13T16:01:10Z" },
		]);
		const result = await fetchMeetingTranscript({
			joinUrl: "u1",
			startTime: "2026-10-13T16:00:00Z",
			userId: "user-1",
			projectId: "p1",
		});
		expect(result).toMatchObject({
			success: true,
			transcript: "Alice: t-13",
		});
		expect(fetchedIds()).toEqual(["t-13"]);
	});
});

it.each([70_000, 320_000, 320_001])(
	"budgets a live %i-character transcript against the analysis ceiling",
	async (length) => {
		const transcript = "x".repeat(length);
		execTool.mockImplementation(async (method: string) => {
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
		const result = await fetchMeetingTranscript({
			joinUrl: "https://example.com/meeting",
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(result.success).toBe(true);
		if (length <= 320_000) {
			expect(result.transcript).toBe(transcript);
			expect(result.wasSummarized).toBe(false);
			expect(generateTextMock).not.toHaveBeenCalled();
		} else {
			expect(result.transcript).toBe(
				"## Meeting Summary: Planning\n\nSummary",
			);
			expect(generateTextMock).toHaveBeenCalledTimes(1);
		}
		expect(redisSet).toHaveBeenCalledWith(
			"tkey",
			expect.objectContaining({ transcript, wasSummarized: false }),
			604800,
		);
	},
);

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});
const LIVE_INPUT = {
	joinUrl: "https://example.com/meeting",
	userId: "example-user",
	organizationId: "example-org",
};
function wireLive(transcript: string) {
	execTool.mockImplementation(async (method: string) => {
		if (method === "get_meeting_by_join_url") {
			return { meeting: { id: "example-meeting", subject: "Planning" } };
		}
		if (method === "list_meeting_transcripts") {
			return { transcripts: [{ id: "example-transcript" }] };
		}
		return { content: transcript };
	});
}

it.each(["x".repeat(70_000), "界".repeat(10_000)])(
	"shrinks the live byte ceiling for many selected meetings (%#)",
	async (transcript) => {
		wireLive(transcript);
		const result = await fetchMeetingTranscript({
			...LIVE_INPUT,
			selectedMeetingCount: 60,
		});
		expect(generateTextMock).toHaveBeenCalledTimes(1);
		expect(result.wasSummarized).toBe(true);
		expect(Buffer.byteLength(result.transcript)).toBeLessThanOrEqual(
			26_214,
		);
	},
);

it.each(["error", "empty"])(
	"caches the fetched source without caching a failed summary (%s)",
	async (failure) => {
		wireLive("😀".repeat(170_000));
		if (failure === "error") {
			generateTextMock.mockRejectedValue(
				new Error("summary unavailable"),
			);
		} else {
			generateTextMock.mockResolvedValue({ text: " ", usage: {} });
		}
		const result = await fetchMeetingTranscript({
			...LIVE_INPUT,
			selectedMeetingCount: 60,
		});
		expect(result.success).toBe(true);
		expect(result.wasSummarized).toBe(false);
		expect(Buffer.byteLength(result.transcript)).toBeLessThanOrEqual(
			26_214,
		);
		expect(result.transcript).not.toContain("�");
		expect(result.transcript).toMatch(/\[.*truncated.*\]$/);
		expect(redisSet).toHaveBeenCalledTimes(1);
		expect(redisSet).toHaveBeenCalledWith(
			"tkey",
			expect.objectContaining({
				transcript: "😀".repeat(170_000),
				wasSummarized: false,
			}),
			604800,
		);
	},
);

it("caps successful summaries as well as raw text to the serialized meeting share", async () => {
	wireLive("x".repeat(320_001));
	generateTextMock.mockResolvedValue({
		text: "\u0001😀".repeat(100_000),
		usage: {},
	});
	const results = await Promise.all(
		Array.from({ length: 12 }, () =>
			fetchMeetingTranscript({ ...LIVE_INPUT, selectedMeetingCount: 12 }),
		),
	);
	const transcripts = results.map((result) => result.transcript);
	expect(Buffer.byteLength(JSON.stringify(transcripts))).toBeLessThanOrEqual(
		1_572_864,
	);
	expect(transcripts.every((text) => !text.includes("�"))).toBe(true);
});

it("keeps fetch summary heartbeats alive beyond the fetch heartbeat timeout", async () => {
	vi.useFakeTimers();
	wireLive("x".repeat(320_001));
	heartbeatMock.mockClear();
	generateTextMock.mockImplementation(async () => {
		await new Promise((resolve) => setTimeout(resolve, 65_000));
		return { text: "Summary", usage: {} };
	});
	const fetched = fetchMeetingTranscript(LIVE_INPUT);
	await vi.advanceTimersByTimeAsync(15_000);
	expect(heartbeatMock).toHaveBeenCalledWith(
		expect.objectContaining({
			keepalive: true,
			stage: "fetch-meeting-summary",
		}),
	);
	await vi.advanceTimersByTimeAsync(50_000);
	await fetched;
	expect(vi.getTimerCount()).toBe(0);
});

it("uses a selection-independent key for live cached transcripts", async () => {
	wireLive("short transcript");
	await fetchMeetingTranscript(LIVE_INPUT);
	await fetchMeetingTranscript({ ...LIVE_INPUT, selectedMeetingCount: 60 });
	expect(transcriptKey.mock.calls).toEqual([
		["example-user", "https://example.com/meeting", undefined],
		["example-user", "https://example.com/meeting", undefined],
	]);
});

async function useStoredCache() {
	const { CacheKeys } = await vi.importActual<
		typeof import("../../../lib/redis-cache")
	>("../../../lib/redis-cache");
	transcriptKey.mockImplementation((...args: unknown[]) =>
		Reflect.apply(CacheKeys.meetingTranscript, CacheKeys, args),
	);
	const summaries = new Map<string, string>();
	const cache = new Map<
		string,
		{ transcript: string; wasSummarized: boolean }
	>();
	redisGet.mockImplementation(
		async (key: string) => summaries.get(key) ?? cache.get(key) ?? null,
	);
	redisSet.mockImplementation(
		async (
			key: string,
			value: { transcript: string; wasSummarized: boolean } | string,
		) => {
			if (typeof value === "string") {
				summaries.set(key, value);
			} else {
				cache.set(key, value);
			}
		},
	);
	return cache;
}

it("reuses one live transcript entry across selection counts one through four", async () => {
	const cache = await useStoredCache();
	const transcript = "x".repeat(70_000);
	wireLive(transcript);
	for (const selectedMeetingCount of [1, 2, 3, 4]) {
		const result = await fetchMeetingTranscript({
			...LIVE_INPUT,
			selectedMeetingCount,
		});
		expect(result.transcript).toBe(transcript);
	}
	expect(execTool).toHaveBeenCalledTimes(3);
	expect(cache.size).toBe(1);
	expect(generateTextMock).not.toHaveBeenCalled();
});

it("keeps a raw cache entry when a narrow first selection needs a summary", async () => {
	const cache = await useStoredCache();
	const transcript = "x".repeat(70_000);
	wireLive(transcript);
	const narrow = await fetchMeetingTranscript({
		...LIVE_INPUT,
		projectId: "example-project",
		selectedMeetingCount: 60,
	});
	expect(narrow.wasSummarized).toBe(true);
	expect([...cache.values()]).toEqual([
		expect.objectContaining({ transcript, wasSummarized: false }),
	]);
	const repeated = await fetchMeetingTranscript({
		...LIVE_INPUT,
		projectId: "example-project",
		selectedMeetingCount: 60,
	});
	expect(repeated.transcript).toBe(narrow.transcript);
	expect(generateTextMock).toHaveBeenCalledTimes(1);
	const wide = await fetchMeetingTranscript({
		...LIVE_INPUT,
		projectId: "example-project",
		selectedMeetingCount: 1,
	});
	expect(wide.transcript).toBe(transcript);
	expect(wide.wasSummarized).toBe(false);
	expect(execTool).toHaveBeenCalledTimes(3);
	expect(cache.size).toBe(1);
});

it("fits a wide cached transcript to a smaller share without fetching Graph again", async () => {
	const cache = await useStoredCache();
	const transcript = "界".repeat(30_000);
	wireLive(transcript);
	await fetchMeetingTranscript({ ...LIVE_INPUT, selectedMeetingCount: 1 });
	const narrow = await fetchMeetingTranscript({
		...LIVE_INPUT,
		selectedMeetingCount: 60,
	});
	expect(Buffer.byteLength(narrow.transcript)).toBeLessThanOrEqual(26_214);
	expect(
		Buffer.byteLength(JSON.stringify(narrow.transcript)),
	).toBeLessThanOrEqual(26_211);
	expect(narrow.wasSummarized).toBe(true);
	expect(execTool).toHaveBeenCalledTimes(3);
	expect([...cache.values()]).toEqual([
		expect.objectContaining({ transcript, wasSummarized: false }),
	]);
});

it("retains cached raw text when fitting it to a smaller share fails", async () => {
	const cache = await useStoredCache();
	const transcript = "😀".repeat(30_000);
	wireLive(transcript);
	await fetchMeetingTranscript({ ...LIVE_INPUT, selectedMeetingCount: 1 });
	generateTextMock.mockRejectedValue(new Error("summary unavailable"));
	const narrow = await fetchMeetingTranscript({
		...LIVE_INPUT,
		selectedMeetingCount: 60,
	});
	expect(narrow.success).toBe(true);
	expect(narrow.wasSummarized).toBe(false);
	expect(Buffer.byteLength(narrow.transcript)).toBeLessThanOrEqual(26_214);
	expect(narrow.transcript).not.toContain("�");
	expect(narrow.transcript).toMatch(/\[.*truncated.*\]$/);
	expect([...cache.values()]).toEqual([
		expect.objectContaining({ transcript, wasSummarized: false }),
	]);
	expect(redisSet).toHaveBeenCalledTimes(1);
	expect(execTool).toHaveBeenCalledTimes(3);
});

it("caches the raw source above the fixed limit and derives extracts for each selection", async () => {
	const cache = await useStoredCache();
	wireLive("x".repeat(320_001));
	const summary = `${"s".repeat(70_000)}summary-tail`;
	generateTextMock.mockResolvedValue({ text: summary, usage: {} });
	const narrow = await fetchMeetingTranscript({
		...LIVE_INPUT,
		selectedMeetingCount: 60,
	});
	const canonical = `## Meeting Summary: Planning\n\n${summary}`;
	expect(Buffer.byteLength(narrow.transcript)).toBeLessThanOrEqual(26_214);
	expect(
		Buffer.byteLength(JSON.stringify(narrow.transcript)),
	).toBeLessThanOrEqual(26_211);
	expect(narrow.wasSummarized).toBe(true);
	expect([...cache.values()]).toEqual([
		expect.objectContaining({
			transcript: "x".repeat(320_001),
			wasSummarized: false,
		}),
	]);
	const wide = await fetchMeetingTranscript({
		...LIVE_INPUT,
		selectedMeetingCount: 1,
	});
	expect(wide.transcript).toBe(canonical);
	expect(generateTextMock).toHaveBeenCalledTimes(2);
	expect(execTool).toHaveBeenCalledTimes(3);
	expect(cache.size).toBe(1);
});

it.each([110_000, 320_000])(
	"keeps a live %i-character CJK transcript whole for one selection",
	async (length) => {
		const transcript = "界".repeat(length);
		wireLive(transcript);
		const result = await fetchMeetingTranscript(LIVE_INPUT);
		expect(result.transcript).toBe(transcript);
		expect(result.wasSummarized).toBe(false);
		expect(generateTextMock).not.toHaveBeenCalled();
	},
);
it("bounds the same large CJK transcript by a wide selection's raw and serialized share", async () => {
	const transcript = "界".repeat(110_000);
	wireLive(transcript);
	generateTextMock.mockRejectedValue(new Error("summary unavailable"));
	const result = await fetchMeetingTranscript({
		...LIVE_INPUT,
		selectedMeetingCount: 60,
	});
	expect(result.transcript).toMatch(/\[.*truncated.*\]$/);
	expect(Buffer.byteLength(result.transcript)).toBeLessThanOrEqual(26_214);
	expect(
		Buffer.byteLength(JSON.stringify(result.transcript)),
	).toBeLessThanOrEqual(26_211);
	expect(result.wasSummarized).toBe(false);
});

it.each(["organizationId", "projectId"] as const)(
	"skips the shared fetch summary cache without %s",
	async (missing) => {
		await useStoredCache();
		wireLive("x".repeat(70_000));
		const input = {
			...LIVE_INPUT,
			projectId: "example-project",
			selectedMeetingCount: 60,
			[missing]: undefined,
		};
		await fetchMeetingTranscript(input);
		await fetchMeetingTranscript(input);
		expect(generateTextMock).toHaveBeenCalledTimes(2);
		expect(execTool).toHaveBeenCalledTimes(3);
		for (const [key] of [...redisGet.mock.calls, ...redisSet.mock.calls]) {
			expect(key).not.toMatch(/^transcript-summary:/);
		}
	},
);

it.each([1, 60])(
	"targets the fetch ceiling or selection share (%i)",
	async (selectedMeetingCount) => {
		wireLive("x".repeat(selectedMeetingCount === 1 ? 320_001 : 70_000));
		await fetchMeetingTranscript({ ...LIVE_INPUT, selectedMeetingCount });
		const instructions = generateTextMock.mock.calls[0][0].instructions;
		// The prompt states half the target; an odd bucket reads one character low.
		const target =
			2 * Number(instructions.match(/about (\d+) characters/)?.[1]);
		const room =
			Math.min(
				320_000,
				Math.floor(1_572_864 / selectedMeetingCount) - 5,
			) - "## Meeting Summary: Planning\n\n".length;
		expect(target).toBeLessThanOrEqual(room);
		expect(target).toBe(Math.min(room, 24_000));
	},
);

it.each(["界", "\u0001"])(
	"reserves the source byte expansion when targeting a fetch extract (%#)",
	async (character) => {
		const transcript = character.repeat(70_000);
		wireLive(transcript);
		await fetchMeetingTranscript({
			...LIVE_INPUT,
			selectedMeetingCount: 60,
		});
		// The prompt states half the target; an odd bucket reads one character low.
		const target =
			2 *
			Number(
				generateTextMock.mock.calls[0][0].instructions.match(
					/about (\d+) characters/,
				)?.[1],
			);
		const serializedRoom =
			Math.floor(1_572_864 / 60) -
			3 -
			Buffer.byteLength(
				JSON.stringify("## Meeting Summary: Planning\n\n"),
			);
		const expansion =
			(Buffer.byteLength(JSON.stringify(transcript)) - 2) /
			transcript.length;
		expect(target).toBeLessThanOrEqual(serializedRoom / expansion);
		expect(target).toBeGreaterThan(serializedRoom / expansion / 1.35);
	},
);
it("uses the truncation fallback when the fetch share cannot hold a target bucket", async () => {
	wireLive("x".repeat(1_000));
	const result = await fetchMeetingTranscript({
		...LIVE_INPUT,
		selectedMeetingCount: 10_000,
	});
	expect(generateTextMock).not.toHaveBeenCalled();
	expect(result.wasSummarized).toBe(false);
	expect(
		Buffer.byteLength(JSON.stringify(result.transcript)),
	).toBeLessThanOrEqual(154);
	expect(result.transcript).toContain("truncated");
});

it("caps a fetch target at the amount sized for its call deadline", async () => {
	wireLive("x".repeat(400_000));
	await fetchMeetingTranscript(LIVE_INPUT);
	expect(generateTextMock.mock.calls[0][0].instructions).toContain(
		"about 12000 characters",
	);
});
it("aborts a fetch summary at 100 seconds and retains the failed-summary fallback", async () => {
	vi.useFakeTimers();
	wireLive("x".repeat(400_000));
	let finish: (value: { text: string; usage: object }) => void = () => {};
	generateTextMock.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const fetched = fetchMeetingTranscript({
		...LIVE_INPUT,
		projectId: "example-project",
	});
	await vi.advanceTimersByTimeAsync(99_999);
	const signal = generateTextMock.mock.calls[0][0].abortSignal;
	expect(signal).toBeInstanceOf(AbortSignal);
	expect(signal.aborted).toBe(false);
	expect(heartbeatMock).toHaveBeenCalledWith(
		expect.objectContaining({
			keepalive: true,
			stage: "fetch-meeting-summary",
		}),
	);
	await vi.advanceTimersByTimeAsync(1);
	const result = await fetched;
	expect(signal.aborted).toBe(true);
	expect(result.wasSummarized).toBe(false);
	expect(result.transcript).toContain("truncated");
	finish({ text: "Late extract", usage: {} });
	await vi.advanceTimersByTimeAsync(0);
	expect(
		redisSet.mock.calls.filter(([key]) =>
			key.startsWith("transcript-summary:"),
		),
	).toHaveLength(0);
	expect(vi.getTimerCount()).toBe(0);
});

it("shrinks the fetch timeout and target to the enclosing activity's remaining time", async () => {
	vi.useFakeTimers();
	currentActivity.mockReturnValue({
		info: {
			currentAttemptScheduledTimestampMs: Date.now() - 80_000,
			startToCloseTimeoutMs: 120_000,
		},
	});
	wireLive("x".repeat(400_000));
	generateTextMock.mockImplementation(() => new Promise(() => {}));
	const fetched = fetchMeetingTranscript(LIVE_INPUT);
	await vi.advanceTimersByTimeAsync(34_999);
	const call = generateTextMock.mock.calls[0][0];
	// The prompt states half the target; an odd bucket reads one character low.
	const target =
		2 * Number(call.instructions.match(/about (\d+) characters/)?.[1]);
	expect(target).toBeLessThanOrEqual((24_000 * 35) / 100);
	expect(call.abortSignal.aborted).toBe(false);
	await vi.advanceTimersByTimeAsync(1);
	expect((await fetched).wasSummarized).toBe(false);
	expect(call.abortSignal.aborted).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});

it("reuses a provider-shortened fetch extract under the requested bucket", async () => {
	await useStoredCache();
	modelMetadata.mockReturnValue({
		provider: "DATABRICKS",
		maxOutputTokens: 2_000,
	});
	wireLive("x".repeat(400_000));
	const input = { ...LIVE_INPUT, projectId: "example-project" };
	await fetchMeetingTranscript(input);
	await fetchMeetingTranscript(input);
	expect(generateTextMock).toHaveBeenCalledTimes(1);
	expect(generateTextMock.mock.calls[0][0].instructions).toContain(
		"about 1562 characters",
	);
	expect(
		redisSet.mock.calls.some(([key]) =>
			key.startsWith("transcript-summary:v4:24000:"),
		),
	).toBe(true);
});
it.each([
	["x".repeat(4 * 1024 * 1024 - 256), true],
	["x".repeat(4 * 1024 * 1024), false],
	["\u0001".repeat(2 * 1024 * 1024), false],
] as const)(
	"bounds the serialized live cache entry, including escaping (%#)",
	async (transcript, shouldCache) => {
		wireLive(transcript);
		const result = await fetchMeetingTranscript(LIVE_INPUT);
		expect(result.success).toBe(true);
		expect(result.wasSummarized).toBe(true);
		const rawWrites = redisSet.mock.calls.filter(([key]) => key === "tkey");
		expect(rawWrites).toHaveLength(shouldCache ? 1 : 0);
		for (const [, value] of rawWrites) {
			expect(
				Buffer.byteLength(JSON.stringify(value)),
			).toBeLessThanOrEqual(4 * 1024 * 1024);
		}
	},
);

it.each(["length", "stop"] as const)(
	"uses the fetch extract and caches it only when complete (%s)",
	async (finishReason) => {
		await useStoredCache();
		wireLive("x".repeat(400_000));
		generateTextMock.mockResolvedValue({
			text: "- Example speaker requested export",
			finishReason,
			usage: {},
		});
		const input = { ...LIVE_INPUT, projectId: "example-project" };
		const first = await fetchMeetingTranscript(input);
		const second = await fetchMeetingTranscript(input);
		const partial = finishReason === "length";
		expect(first.wasSummarized).toBe(true);
		expect(first.transcript).toContain(
			"- Example speaker requested export",
		);
		expect(second.transcript).toBe(first.transcript);
		expect(generateTextMock).toHaveBeenCalledTimes(partial ? 2 : 1);
		expect(
			redisSet.mock.calls.filter(([key]) =>
				key.startsWith("transcript-summary:"),
			),
		).toHaveLength(partial ? 0 : 1);
		expect(logInfo).toHaveBeenCalledWith(
			"[BacklogContext] Transcript summarized",
			expect.objectContaining({ partial }),
		);
		expect(logInfo).toHaveBeenCalledWith(
			"[BacklogContext] Fetch summary call completed",
			expect.objectContaining({ partial }),
		);
	},
);
