import { describe, expect, it } from "vitest";
import {
	recordTurnSpeechSentence,
	recordTurnUsage,
	recordTurnValue,
	recordTurnValueOnce,
	TurnTimings,
	timeTurnStep,
	withTurnTimings,
} from "../turn-timing";
import { isVoiceTurn } from "../voice-turn-policy";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("TurnTimings", () => {
	it("measures a step in wall-clock milliseconds", async () => {
		const timings = new TurnTimings();
		await timings.time("stepMs", () => sleep(30));
		const { stepMs } = timings.snapshot().values;
		expect(stepMs).toBeGreaterThanOrEqual(25);
		expect(stepMs).toBeLessThan(250);
	});

	it("records a step that throws and rethrows its error", async () => {
		const timings = new TurnTimings();
		await expect(
			timings.time("failingMs", async () => {
				await sleep(10);
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(timings.snapshot().values.failingMs).toBeGreaterThanOrEqual(5);
	});

	it("times the members of a parallel group on their own and the group as a whole", async () => {
		const timings = new TurnTimings();
		await timings.time("groupMs", () =>
			Promise.all([
				timings.time("fastMs", () => sleep(10)),
				timings.time("slowMs", () => sleep(80)),
			]),
		);
		const { fastMs, slowMs, groupMs } = timings.snapshot().values;
		expect(slowMs).toBeGreaterThan(fastMs);
		expect(groupMs).toBeGreaterThanOrEqual(slowMs - 2);
		expect(groupMs).toBeLessThan(fastMs + slowMs);
	});

	it("keeps the first value of a once-only mark", () => {
		const timings = new TurnTimings();
		timings.setOnce("firstTextMs", 10);
		timings.setOnce("firstTextMs", 99);
		expect(timings.snapshot().values.firstTextMs).toBe(10);
	});
});

describe("turn timing context", () => {
	it("does nothing, and still runs the step, outside a collected turn", async () => {
		recordTurnValue("looseMs", 1);
		recordTurnValueOnce("looseMs", 2);
		recordTurnSpeechSentence({
			chars: 1,
			route: "gateway",
			startedAtMs: 0,
			firstByteMs: 1,
			totalMs: 1,
		});
		await expect(
			timeTurnStep("looseMs", async () => "result"),
		).resolves.toBe("result");
	});

	it("reaches steps run anywhere inside the turn, across awaits", async () => {
		const timings = new TurnTimings();
		await withTurnTimings(timings, async () => {
			await sleep(1);
			await timeTurnStep("outerMs", async () => {
				await sleep(1);
				recordTurnValue("deepMs", 7);
				recordTurnValueOnce("firstMs", 3);
				recordTurnValueOnce("firstMs", 4);
			});
		});
		expect(timings.snapshot().values).toMatchObject({
			deepMs: 7,
			firstMs: 3,
		});
		expect(timings.snapshot().values.outerMs).toBeDefined();
	});

	it("keeps two concurrent turns apart", async () => {
		const first = new TurnTimings();
		const second = new TurnTimings();
		await Promise.all([
			withTurnTimings(first, async () => {
				await sleep(10);
				recordTurnValue("whoMs", 1);
			}),
			withTurnTimings(second, async () => {
				recordTurnValue("whoMs", 2);
			}),
		]);
		expect(first.snapshot().values.whoMs).toBe(1);
		expect(second.snapshot().values.whoMs).toBe(2);
	});

	it("collects per-sentence speech timings in order", async () => {
		const timings = new TurnTimings();
		await withTurnTimings(timings, async () => {
			recordTurnSpeechSentence({
				chars: 10,
				route: "gateway",
				startedAtMs: 5,
				firstByteMs: 800,
				totalMs: 800,
			});
			recordTurnSpeechSentence({
				chars: 20,
				route: "openai-direct",
				startedAtMs: 900,
				firstByteMs: 300,
				totalMs: null,
			});
		});
		expect(timings.snapshot().speech.map((s) => s.chars)).toEqual([10, 20]);
	});
});

describe("recordTurnUsage", () => {
	it("reads the AI SDK 7 nested reasoning and cache-read counts", async () => {
		const timings = new TurnTimings();
		await withTurnTimings(timings, async () => {
			recordTurnUsage("llm", {
				inputTokens: 9_000,
				outputTokens: 120,
				inputTokenDetails: { cacheReadTokens: 8_000 },
				outputTokenDetails: { reasoningTokens: 64 },
			});
		});
		expect(timings.snapshot().values).toEqual({
			"llm.inputTokens": 9_000,
			"llm.outputTokens": 120,
			"llm.reasoningTokens": 64,
			"llm.cachedInputTokens": 8_000,
		});
	});

	it("leaves out a count the provider did not report instead of recording zero", async () => {
		const timings = new TurnTimings();
		await withTurnTimings(timings, async () => {
			recordTurnUsage("llm", { inputTokens: 5, outputTokens: 2 });
			recordTurnUsage("llm", undefined);
		});
		expect(Object.keys(timings.snapshot().values).sort()).toEqual([
			"llm.inputTokens",
			"llm.outputTokens",
		]);
	});
});

describe("isVoiceTurn", () => {
	it("is true for Parlume and nothing else", () => {
		expect(isVoiceTurn("parlume")).toBe(true);
		expect(isVoiceTurn("chat-agent")).toBe(false);
		expect(isVoiceTurn("fabric-agent")).toBe(false);
		expect(isVoiceTurn(undefined)).toBe(false);
	});
});
