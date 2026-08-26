import { PredictiveToolArgsAccumulator } from "@repo/agent-core/predictive-tool-args";
import { describe, expect, it } from "vitest";

function accumulator(
	overrides: Partial<{
		minEmitIntervalMs: number;
		minGrowthChars: number;
	}> = {},
) {
	return new PredictiveToolArgsAccumulator({
		toolName: "write_document_local",
		argKey: "document",
		minEmitIntervalMs: 150,
		minGrowthChars: 4096,
		...overrides,
	});
}

describe("PredictiveToolArgsAccumulator", () => {
	it("ignores chunks for a non-target tool", () => {
		const acc = accumulator();
		const result = acc.push(
			{ name: "some_other_tool", args: '{"foo":"bar"}' },
			0,
		);
		expect(result).toBeNull();
	});

	it("extracts the value once enough content has streamed in", () => {
		const acc = accumulator({ minEmitIntervalMs: 0, minGrowthChars: 0 });
		acc.push({ name: "write_document_local", args: "" }, 0);
		const result = acc.push({ args: '{"document":"hello world' }, 1);
		expect(result).toBe("hello world");
	});

	it("resets the buffer on a new tool call — no leakage from a prior attempt", () => {
		const acc = accumulator({ minEmitIntervalMs: 0, minGrowthChars: 0 });
		// First attempt streams some content, then the call is abandoned
		// (e.g. retried after a corrective ToolMessage) without ever closing
		// the JSON.
		acc.push({ name: "write_document_local", args: "" }, 0);
		const first = acc.push(
			{ args: '{"document":"leftover from attempt one' },
			1,
		);
		expect(first).toBe("leftover from attempt one");

		// A second tool call starts — the name chunk must wipe the buffer so
		// none of attempt one's content can appear in attempt two's output.
		acc.push({ name: "write_document_local", args: "" }, 2);
		const second = acc.push({ args: '{"document":"fresh content' }, 3);
		expect(second).toBe("fresh content");
		expect(second).not.toContain("leftover");
	});

	it("throttles by time: withholds extraction until minEmitIntervalMs has elapsed", () => {
		const acc = accumulator({
			minEmitIntervalMs: 150,
			minGrowthChars: 999_999,
		});
		// A realistic Date.now()-scale base — lastEmitTime starts at 0 so the
		// very first push always clears the time threshold.
		const T0 = 1_000_000;
		acc.push({ name: "write_document_local", args: "" }, T0);
		const first = acc.push({ args: '{"document":"a' }, T0);
		expect(first).toBe("a");

		// Immediately after, neither the time nor growth threshold is met.
		const throttled = acc.push({ args: "b" }, T0 + 10);
		expect(throttled).toBeNull();

		// Once minEmitIntervalMs has elapsed, extraction resumes and picks up
		// everything accumulated in between.
		const afterInterval = acc.push({ args: "c" }, T0 + 200);
		expect(afterInterval).toBe("abc");
	});

	it("throttles by growth: extraction resumes early once minGrowthChars is crossed", () => {
		const acc = accumulator({
			minEmitIntervalMs: 999_999,
			minGrowthChars: 5,
		});
		const T0 = 1_000_000;
		acc.push({ name: "write_document_local", args: "" }, T0);
		const first = acc.push({ args: '{"document":"ab' }, T0);
		expect(first).toBe("ab");

		// Small growth, time threshold not met — throttled.
		const throttled = acc.push({ args: "c" }, T0 + 1);
		expect(throttled).toBeNull();

		// Enough characters have accumulated since the last extraction attempt
		// (>= minGrowthChars) to force extraction despite the time throttle.
		const afterGrowth = acc.push({ args: "defghi" }, T0 + 2);
		expect(afterGrowth).toBe("abcdefghi");
	});

	it("returns null when the extracted content is unchanged", () => {
		const acc = accumulator({ minEmitIntervalMs: 0, minGrowthChars: 0 });
		acc.push({ name: "write_document_local", args: "" }, 0);
		const first = acc.push({ args: '{"document":"same' }, 0);
		expect(first).toBe("same");
		// No new args appended, but another chunk arrives (e.g. an unrelated
		// chunk for the same call) — content unchanged, so null.
		const second = acc.push({ args: "" }, 1);
		expect(second).toBeNull();
	});

	it("returns null when the extracted content is empty", () => {
		const acc = accumulator({ minEmitIntervalMs: 0, minGrowthChars: 0 });
		const result = acc.push(
			{ name: "write_document_local", args: '{"document":"' },
			0,
		);
		expect(result).toBeNull();
	});

	it('unescapes \\n, \\", \\\\, \\t, \\r in the extracted value', () => {
		const acc = accumulator({ minEmitIntervalMs: 0, minGrowthChars: 0 });
		acc.push({ name: "write_document_local", args: "" }, 0);
		const raw =
			'{"document":"line1\\nline2\\ttabbed\\r\\nquote:\\"hi\\"\\\\backslash';
		const result = acc.push({ args: raw }, 0);
		expect(result).toBe('line1\nline2\ttabbed\r\nquote:"hi"\\backslash');
	});

	it("extracts to end of buffer for truncated JSON with no closing quote", () => {
		const acc = accumulator({ minEmitIntervalMs: 0, minGrowthChars: 0 });
		acc.push({ name: "write_document_local", args: "" }, 0);
		// The value's closing quote never arrives (model hit its output-token
		// limit mid-string) — extraction should still surface everything
		// captured so far rather than waiting for a quote that never comes.
		const result = acc.push(
			{ args: '{"document":"partial content with no end' },
			0,
		);
		expect(result).toBe("partial content with no end");
	});

	it("only accumulates continuation chunks while inside a target call", () => {
		const acc = accumulator({ minEmitIntervalMs: 0, minGrowthChars: 0 });
		// A continuation-shaped chunk (no name) arrives before any target call
		// has started — must not be treated as part of a call.
		const result = acc.push({ args: '{"document":"stray' }, 0);
		expect(result).toBeNull();
	});

	it("treats an empty-string name as a continuation, not a call boundary", () => {
		// OpenAI-compatible providers send `name: ""` on continuation deltas
		// (only the first chunk of a call carries the real name). Resetting on
		// an empty name would kill the rest of the preview after the first
		// chunk.
		const acc = accumulator({ minEmitIntervalMs: 0, minGrowthChars: 0 });
		acc.push({ name: "write_document_local", args: '{"document":"hel' }, 0);
		// Continuation chunks arrive with an empty-string name, per the
		// OpenAI-compatible shape.
		const second = acc.push({ name: "", args: "lo" }, 1);
		expect(second).toBe("hello");
		const third = acc.push({ name: "", args: " world" }, 2);
		expect(third).toBe("hello world");
	});

	it("a genuine second call (non-empty name) resets the buffer AND lastEmitTime", () => {
		const acc = accumulator({
			minEmitIntervalMs: 999_999,
			minGrowthChars: 999_999,
		});
		const T0 = 1_000_000;
		// Call 1 emits once.
		const first = acc.push(
			{ name: "write_document_local", args: '{"document":"call one' },
			T0,
		);
		expect(first).toBe("call one");

		// Call 2 starts immediately after (well within minEmitIntervalMs of
		// call 1's emit) — a real new-call boundary must still extract right
		// away rather than being throttled by call 1's lastEmitTime, and must
		// not contain any leftover content from call 1.
		const second = acc.push(
			{ name: "write_document_local", args: '{"document":"call two' },
			T0 + 1,
		);
		expect(second).toBe("call two");
	});

	it("escapes an argKey containing regex metacharacters instead of mismatching or throwing", () => {
		const acc = new PredictiveToolArgsAccumulator({
			toolName: "write_document_local",
			argKey: "doc.key[0]",
			minEmitIntervalMs: 0,
			minGrowthChars: 0,
		});
		expect(() =>
			acc.push(
				{
					name: "write_document_local",
					args: '{"doc.key[0]":"hello',
				},
				0,
			),
		).not.toThrow();
		const result = acc.push({ args: " world" }, 1);
		expect(result).toBe("hello world");
	});

	describe("interleaved parallel tool calls (index-bound continuations)", () => {
		it("without any index info, a non-target named chunk still resets the target (fallback behavior preserved)", () => {
			const acc = accumulator({
				minEmitIntervalMs: 0,
				minGrowthChars: 0,
			});
			acc.push(
				{ name: "write_document_local", args: '{"document":"target' },
				0,
			);
			// A different tool starts, no index on either side — old
			// behavior: this ends whatever call was active.
			acc.push({ name: "some_other_tool", args: "{}" }, 1);
			// A bare continuation chunk after that must NOT resume the target
			// (it's inactive).
			const result = acc.push({ args: "more" }, 2);
			expect(result).toBeNull();
		});

		it("a non-target named chunk with a DIFFERENT index mid-target-stream does not kill the target preview", () => {
			const acc = accumulator({
				minEmitIntervalMs: 0,
				minGrowthChars: 0,
			});
			// Target call starts at index 0.
			acc.push(
				{
					name: "write_document_local",
					args: '{"document":"tar',
					index: 0,
				},
				0,
			);
			// A different (parallel) tool call starts at index 1 — must not
			// touch the target's state.
			acc.push({ name: "some_other_tool", args: "{}", index: 1 }, 1);
			// The target's own continuation (index 0) must still accumulate
			// and extract normally.
			const result = acc.push({ args: "get", index: 0 }, 2);
			expect(result).toBe("target");
		});

		it("a non-target call's continuation args (no name, different index) never contaminate the target buffer", () => {
			const acc = accumulator({
				minEmitIntervalMs: 0,
				minGrowthChars: 0,
			});
			acc.push(
				{
					name: "write_document_local",
					args: '{"document":"tar',
					index: 0,
				},
				0,
			);
			acc.push({ name: "some_other_tool", args: "{}", index: 1 }, 1);
			// Continuation chunk for the OTHER call (index 1, no name) — must
			// be ignored, not appended to the target buffer.
			const contaminated = acc.push(
				{ args: "CONTAMINATION", index: 1 },
				2,
			);
			expect(contaminated).toBeNull();
			// The target's own continuation still produces the clean value.
			const result = acc.push({ args: "get", index: 0 }, 3);
			expect(result).toBe("target");
			expect(result).not.toContain("CONTAMINATION");
		});

		it("reverse ordering — a non-target call starts first, the target starts second — both stay isolated by index", () => {
			const acc = accumulator({
				minEmitIntervalMs: 0,
				minGrowthChars: 0,
			});
			// Non-target call starts first, at index 0.
			acc.push({ name: "some_other_tool", args: "{}", index: 0 }, 0);
			// Target starts second, at index 1.
			acc.push(
				{
					name: "write_document_local",
					args: '{"document":"iso',
					index: 1,
				},
				1,
			);
			// A continuation for the non-target call (index 0) must not reach
			// the target buffer.
			const ignored = acc.push({ args: "IGNORED", index: 0 }, 2);
			expect(ignored).toBeNull();
			// The target's own continuation (index 1) accumulates correctly.
			const result = acc.push({ args: "lated", index: 1 }, 3);
			expect(result).toBe("isolated");
		});

		it("the same index reused by a different tool ends the target call at that index", () => {
			const acc = accumulator({
				minEmitIntervalMs: 0,
				minGrowthChars: 0,
			});
			acc.push(
				{
					name: "write_document_local",
					args: '{"document":"first',
					index: 0,
				},
				0,
			);
			// Index 0 is reused by a DIFFERENT tool — the target call that
			// used to own index 0 is over.
			acc.push({ name: "some_other_tool", args: "{}", index: 0 }, 1);
			// A continuation at index 0 now belongs to the other call, not
			// the (no-longer-active) target.
			const result = acc.push({ args: "more", index: 0 }, 2);
			expect(result).toBeNull();
		});
	});
});
