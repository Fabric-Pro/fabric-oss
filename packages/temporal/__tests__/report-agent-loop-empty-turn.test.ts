import { describe, expect, it, vi } from "vitest";
import {
	isNoOutputGeneratedError,
	runModelIterationWithRetry,
} from "../src/activities/template-instance/report-agent-loop";

describe("isNoOutputGeneratedError", () => {
	it("matches an Error whose message contains 'No output generated'", () => {
		expect(
			isNoOutputGeneratedError(
				new Error("No output generated. Check the stream for errors."),
			),
		).toBe(true);
	});

	it("matches an error by name NoOutputGeneratedError", () => {
		const e = new Error("stream produced nothing");
		e.name = "AI_NoOutputGeneratedError";
		expect(isNoOutputGeneratedError(e)).toBe(true);
	});

	it("does not match a genuine provider error", () => {
		expect(
			isNoOutputGeneratedError(new Error("rate limit exceeded (429)")),
		).toBe(false);
		expect(isNoOutputGeneratedError(new Error("Unauthorized (401)"))).toBe(
			false,
		);
	});

	it("does not match non-errors", () => {
		expect(isNoOutputGeneratedError(undefined)).toBe(false);
		expect(isNoOutputGeneratedError("No output generated")).toBe(false);
		expect(
			isNoOutputGeneratedError({ message: "No output generated" }),
		).toBe(false);
	});
});

// Helper: NoOutputGeneratedError factory (SDK shape)
const noOut = () =>
	Object.assign(
		new Error("No output generated. Check the stream for errors."),
		{
			name: "AI_NoOutputGeneratedError",
		},
	);

function fakeStream(opts: {
	parts?: Array<Record<string, unknown>>; // fullStream parts in order
	finishReason?: string; // resolved finishReason value
	usage?: { inputTokens: number; outputTokens: number };
	rejectFinishReason?: Error; // finishReason promise rejects
	rejectUsage?: Error; // usage promise rejects
	rejectText?: Error; // text promise rejects
	rejectToolCalls?: Error; // toolCalls promise rejects
}) {
	const parts = opts.parts ?? [];
	const textPromise = opts.rejectText
		? Promise.reject(opts.rejectText)
		: Promise.resolve(
				parts
					.filter((p) => p.type === "text-delta")
					.map((p) => p.text)
					.join(""),
			);
	if (opts.rejectText) {
		(textPromise as Promise<unknown>).catch(() => {});
	}
	const toolCallsPromise = opts.rejectToolCalls
		? Promise.reject(opts.rejectToolCalls)
		: Promise.resolve(parts.filter((p) => p.type === "tool-call"));
	if (opts.rejectToolCalls) {
		(toolCallsPromise as Promise<unknown>).catch(() => {});
	}
	return {
		textStream: (async function* () {})(), // legacy field; unused by consumeStream
		text: textPromise,
		toolCalls: toolCallsPromise,
		fullStream: (async function* () {
			for (const p of parts) {
				yield p;
			}
		})(),
		finishReason: opts.rejectFinishReason
			? Promise.reject(opts.rejectFinishReason)
			: Promise.resolve(opts.finishReason),
		usage: opts.rejectUsage
			? Promise.reject(opts.rejectUsage)
			: Promise.resolve(opts.usage),
	} as any;
}

describe("runModelIterationWithRetry", () => {
	const noop = { heartbeat: () => {} };

	// #1 — normal turn, no retry
	it("returns the result without retrying on a normal turn", async () => {
		let calls = 0;
		const make = () => {
			calls++;
			return fakeStream({
				parts: [
					{ type: "text-delta", text: "done" },
					{ type: "finish-step", finishReason: "stop" },
				],
				finishReason: "stop",
				usage: { inputTokens: 1, outputTokens: 1 },
			});
		};
		const out = await runModelIterationWithRetry(make, noop);
		expect(out.kind).toBe("result");
		expect(calls).toBe(1);
	});

	// #2 — tool-call-only → result
	it("treats a tool-call-only turn as a result (not empty)", async () => {
		const make = () =>
			fakeStream({
				parts: [
					{
						type: "tool-call",
						toolCallId: "t",
						toolName: "x",
						input: {},
					},
					{ type: "finish-step", finishReason: "tool-calls" },
				],
				finishReason: "tool-calls",
				usage: { inputTokens: 1, outputTokens: 1 },
			});
		const out = await runModelIterationWithRetry(make, noop);
		expect(out).toMatchObject({ kind: "result" });
	});

	// #3 — empty then recover
	it("retries once on an empty result, then succeeds", async () => {
		let calls = 0;
		const make = () => {
			calls++;
			if (calls === 1) {
				return fakeStream({
					parts: [],
					rejectFinishReason: noOut(),
					rejectUsage: noOut(),
				});
			}
			return fakeStream({
				parts: [
					{ type: "text-delta", text: "recovered" },
					{ type: "finish-step", finishReason: "stop" },
				],
				finishReason: "stop",
				usage: { inputTokens: 1, outputTokens: 1 },
			});
		};
		const out = await runModelIterationWithRetry(make, noop);
		expect(out).toMatchObject({ kind: "result", text: "recovered" });
		expect(calls).toBe(2);
	});

	// #4 — two empties → empty (MAX_ATTEMPTS=3 now)
	it("returns empty after three empty turns (MAX_ATTEMPTS=3)", async () => {
		let calls = 0;
		const make = () => {
			calls++;
			return fakeStream({
				parts: [],
				rejectFinishReason: noOut(),
				rejectUsage: noOut(),
			});
		};
		const out = await runModelIterationWithRetry(make, noop);
		expect(out.kind).toBe("empty");
		expect(calls).toBe(3);
		expect(out.streamDiagnostics).toMatchObject({
			sawFinishStep: false,
			finishReason: null,
			usageResolved: false,
			attempts: 3,
		});
	});

	// #5 — text throws NoOutput, retried
	it("retries when stream.text throws NoOutputGeneratedError", async () => {
		let calls = 0;
		const make = () => {
			calls++;
			if (calls === 1) {
				return fakeStream({
					parts: [],
					rejectFinishReason: noOut(),
					rejectUsage: noOut(),
				});
			}
			return fakeStream({
				parts: [
					{ type: "text-delta", text: "ok" },
					{ type: "finish-step", finishReason: "stop" },
				],
				finishReason: "stop",
				usage: { inputTokens: 1, outputTokens: 1 },
			});
		};
		const out = await runModelIterationWithRetry(make, noop);
		expect(out).toMatchObject({ kind: "result", text: "ok" });
		expect(calls).toBe(2);
	});

	// #6 — genuine error, no retry
	it("propagates a genuine error without retrying", async () => {
		let calls = 0;
		const err429 = new Error("rate limit exceeded (429)");
		const make = () => {
			calls++;
			return fakeStream({
				parts: [{ type: "error", error: err429 }],
				rejectFinishReason: noOut(),
			});
		};
		await expect(runModelIterationWithRetry(make, noop)).rejects.toThrow(
			"429",
		);
		expect(calls).toBe(1);
	});

	// #7 — usage summed across attempts (length-empty then success)
	it("sums usage across attempts (length-empty then success) — Codex finding 3", async () => {
		let calls = 0;
		const make = () => {
			calls++;
			if (calls === 1) {
				// length-empty: finish-step with finishReason:"length", no content
				return fakeStream({
					parts: [{ type: "finish-step", finishReason: "length" }],
					finishReason: "length",
					usage: { inputTokens: 1, outputTokens: 1 },
				});
			}
			return fakeStream({
				parts: [
					{ type: "text-delta", text: "ok" },
					{ type: "finish-step", finishReason: "stop" },
				],
				finishReason: "stop",
				usage: { inputTokens: 1, outputTokens: 1 },
			});
		};
		const out = await runModelIterationWithRetry(make, noop);
		expect(out).toMatchObject({ kind: "result" });
		expect(out.usage).toEqual({ inputTokens: 2, outputTokens: 2 });
		expect(calls).toBe(2);
	});

	// #8 — usage preserved on empties (length-empty × 3)
	it("preserves usage on three length-empty turns", async () => {
		const make = () =>
			fakeStream({
				parts: [{ type: "finish-step", finishReason: "length" }],
				finishReason: "length",
				usage: { inputTokens: 1, outputTokens: 1 },
			});
		const out = await runModelIterationWithRetry(make, noop);
		expect(out.kind).toBe("empty");
		expect(out.usage).toEqual({ inputTokens: 3, outputTokens: 3 });
	});

	// #9→F3 — zero-finish-step NoOut: usage rejects → 0 usage, then next attempt succeeds
	// Replaces PR #1761's "aggregates usage even when an empty turn THROWS NoOutputGenerated"
	// REFUTED by SDK reality: when recordedSteps===0, usage rejects too → contributes 0.
	it("zero-finish-step NoOut contributes 0 usage; next attempt usage is counted (Codex F3 replacement)", async () => {
		let calls = 0;
		const make = () => {
			calls++;
			if (calls === 1) {
				// Zero-finish-step: both finishReason AND usage reject with NoOut
				return fakeStream({
					parts: [],
					rejectFinishReason: noOut(),
					rejectUsage: noOut(),
				});
			}
			return fakeStream({
				parts: [
					{ type: "text-delta", text: "ok" },
					{ type: "finish-step", finishReason: "stop" },
				],
				finishReason: "stop",
				usage: { inputTokens: 1, outputTokens: 1 },
			});
		};
		const out = await runModelIterationWithRetry(make, noop);
		expect(out).toMatchObject({ kind: "result", text: "ok" });
		// a1 contributed 0 (usage rejected), a2 contributed {1,1}
		expect(out.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
		// diagnostics describe the final (a2) attempt
		expect(out.streamDiagnostics).toMatchObject({
			sawFinishStep: true,
			finishReason: "stop",
			usageResolved: true,
		});
	});

	// #10 — genuine toolCalls reject, no retry
	it("fails loud when stream.toolCalls rejects with a genuine error — Codex round-3", async () => {
		let calls = 0;
		const err429 = new Error("rate limit exceeded (429)");
		const make = () => {
			calls++;
			return fakeStream({ parts: [], rejectToolCalls: err429 });
		};
		await expect(runModelIterationWithRetry(make, noop)).rejects.toThrow(
			"429",
		);
		expect(calls).toBe(1);
	});

	// #11 — genuine reject even when text empty
	it("does not treat a genuine toolCalls rejection as an empty turn even when text is empty", async () => {
		const make = () =>
			fakeStream({
				parts: [],
				rejectToolCalls: new Error("tool-call parse error"),
			});
		await expect(runModelIterationWithRetry(make, noop)).rejects.toThrow(
			"parse error",
		);
	});

	// C1/C2 (Copilot) — a clean finish observed only via the resolved finishReason
	// promise (no explicit finish-step part) is a legit completion, not truncation.
	it("treats a resolved finishReason 'stop' with no finish-step part as a completion, not truncation", async () => {
		const make = () =>
			fakeStream({
				parts: [],
				finishReason: "stop",
				usage: { inputTokens: 1, outputTokens: 1 },
			});
		const out = await runModelIterationWithRetry(make, noop);
		expect(out.kind).toBe("result");
		expect(out.streamDiagnostics).toMatchObject({
			sawFinishStep: true,
			finishReason: "stop",
		});
	});

	// #12 — eager reject while draining
	it("classifies an eager rejection even while textStream is still draining — round-4 finding 1", async () => {
		const make = () =>
			fakeStream({
				parts: [
					{ type: "text-delta", text: "a" },
					{ type: "text-delta", text: "b" },
					{
						type: "error",
						error: new Error("503 service unavailable"),
					},
				],
				rejectFinishReason: noOut(),
			});
		await expect(runModelIterationWithRetry(make, noop)).rejects.toThrow(
			"503",
		);
	});

	// #13 — mixed: tool calls + NoOut reject → result
	it("returns the fulfilled tool calls even when text rejects NoOutput (mixed state) — round-4 finding 2", async () => {
		const make = () =>
			fakeStream({
				parts: [
					{
						type: "tool-call",
						toolCallId: "t1",
						toolName: "fizzy_get_cards",
						input: {},
					},
				],
				rejectFinishReason: noOut(),
				rejectUsage: noOut(),
			});
		const out = await runModelIterationWithRetry(make, noop);
		expect(out).toMatchObject({ kind: "result" });
		expect((out as { toolCalls: unknown[] }).toolCalls).toHaveLength(1);
	});

	// #14 — genuine usage reject, no retry
	it("fails loud when stream.usage rejects with a genuine error — Codex final-review F1", async () => {
		let calls = 0;
		const err429 = new Error("rate limit exceeded (429)");
		const make = () => {
			calls++;
			return fakeStream({
				parts: [],
				rejectUsage: err429,
				rejectFinishReason: noOut(),
			});
		};
		await expect(runModelIterationWithRetry(make, noop)).rejects.toThrow(
			"429",
		);
		expect(calls).toBe(1);
	});

	// #15 — NoOut usage reject + real output → result, usageResolved:false
	it("does not fail loud when usage rejects with NoOutputGeneratedError and there is real output", async () => {
		const make = () =>
			fakeStream({
				parts: [
					{ type: "text-delta", text: "ok" },
					{ type: "finish-step", finishReason: "stop" },
				],
				finishReason: "stop",
				rejectUsage: noOut(),
			});
		const out = await runModelIterationWithRetry(make, noop);
		expect(out).toMatchObject({ kind: "result", text: "ok" });
		expect(out.streamDiagnostics).toMatchObject({ usageResolved: false });
	});

	// NEW cases from brief

	it("finish-step empty + 'stop' is a result, not salvage [Codex F2]", async () => {
		let calls = 0;
		const out = await runModelIterationWithRetry(
			() => {
				calls++;
				return fakeStream({
					parts: [{ type: "finish-step", finishReason: "stop" }],
					finishReason: "stop",
					usage: { inputTokens: 4, outputTokens: 0 },
				});
			},
			{ heartbeat: () => {} },
		);
		expect(out.kind).toBe("result");
		expect(calls).toBe(1); // NOT retried
		expect(out.streamDiagnostics).toMatchObject({
			sawFinishStep: true,
			finishReason: "stop",
		});
	});

	it("zero-finish-step: finishReason AND usage both reject → 0 usage, usageResolved:false [Codex F3]", async () => {
		const out = await runModelIterationWithRetry(
			() =>
				fakeStream({
					parts: [],
					rejectFinishReason: noOut(),
					rejectUsage: noOut(),
				}),
			{ heartbeat: () => {}, maxAttempts: 2 },
		);
		expect(out.kind).toBe("empty");
		expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
		expect(out.streamDiagnostics).toMatchObject({
			sawFinishStep: false,
			finishReason: null,
			usageResolved: false,
		});
	});

	it("finishReason 'length' with empty content is truncation → retried then salvaged", async () => {
		let calls = 0;
		const out = await runModelIterationWithRetry(
			() => {
				calls++;
				return fakeStream({
					parts: [{ type: "finish-step", finishReason: "length" }],
					finishReason: "length",
					usage: { inputTokens: 5, outputTokens: 16384 },
				});
			},
			{ heartbeat: () => {} },
		);
		expect(out.kind).toBe("empty"); // NOT complete
		expect(calls).toBe(3);
		expect(out.streamDiagnostics.finishReason).toBe("length");
	});

	it("backs off between truncation retries (fake timers)", async () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			const make = () => {
				calls++;
				return fakeStream({
					parts: [],
					rejectFinishReason: noOut(),
					rejectUsage: noOut(),
				});
			};
			const p = runModelIterationWithRetry(make, { heartbeat: () => {} });
			await vi.advanceTimersByTimeAsync(5000); // covers 1000 + 2000ms backoffs
			const out = await p;
			expect(out.kind).toBe("empty");
			expect(calls).toBe(3);
		} finally {
			vi.useRealTimers();
		}
	});

	// Fix 1 end-to-end: genuine error on text channel (finishReason+usage both NoOut) → THROW
	it("genuine error on text channel (finishReason+usage NoOut) makes runModelIterationWithRetry throw [Fix1 e2e]", async () => {
		const genuine = new Error("upstream HTTP 503");
		let calls = 0;
		const make = () => {
			calls++;
			return fakeStream({
				parts: [],
				rejectText: genuine,
				rejectFinishReason: noOut(),
				rejectUsage: noOut(),
			});
		};
		await expect(
			runModelIterationWithRetry(make, { heartbeat: () => {} }),
		).rejects.toThrow("503");
		// Fails immediately — does NOT retry
		expect(calls).toBe(1);
	});
});
