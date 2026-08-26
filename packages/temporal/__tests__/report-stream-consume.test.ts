import { describe, expect, it } from "vitest";
import {
	buildReportStreamRequest,
	consumeStream,
	isNoOutputGeneratedError,
	REPORT_MAX_OUTPUT_TOKENS,
} from "../src/activities/template-instance/report-agent-loop";

describe("buildReportStreamRequest", () => {
	const base = {
		model: {} as any,
		system: "sys",
		messages: [{ role: "user", content: "hi" }] as any,
	};

	it("sets maxOutputTokens to the report cap", () => {
		const req = buildReportStreamRequest({
			...base,
			tools: { a: {} } as any,
		});
		expect(req.maxOutputTokens).toBe(REPORT_MAX_OUTPUT_TOKENS);
		expect(REPORT_MAX_OUTPUT_TOKENS).toBe(16384);
	});

	it("uses toolChoice 'auto' when tools are present", () => {
		const req = buildReportStreamRequest({
			...base,
			tools: { a: {} } as any,
		});
		expect(req.toolChoice).toBe("auto");
		expect(req.tools).toBeDefined();
	});

	it("omits tools and toolChoice when there are none", () => {
		const req = buildReportStreamRequest({ ...base, tools: {} as any });
		expect(req.tools).toBeUndefined();
		expect(req.toolChoice).toBeUndefined();
	});

	it("puts a rolling anthropic cache breakpoint on the LAST message only", () => {
		const messages = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "second" },
			{ role: "user", content: "third" },
		] as any;
		const req = buildReportStreamRequest({
			...base,
			messages,
			tools: {} as any,
		});
		const out = req.messages as any[];
		expect(out).toHaveLength(3);
		expect(out[2].providerOptions).toEqual({
			anthropic: { cacheControl: { type: "ephemeral" } },
		});
		// earlier messages are left untouched — one breakpoint per request
		expect(out[0].providerOptions).toBeUndefined();
		expect(out[1].providerOptions).toBeUndefined();
	});

	it("does not mutate the caller's history (persistent array stays marker-free)", () => {
		const messages = [{ role: "user", content: "only" }] as any;
		buildReportStreamRequest({ ...base, messages, tools: {} as any });
		expect(messages[0].providerOptions).toBeUndefined();
	});
});

function fakeStream(opts: {
	parts?: Array<Record<string, unknown>>;
	finishReason?: string;
	usage?: { inputTokens: number; outputTokens: number } | undefined;
	rejectFinishReason?: Error;
	rejectUsage?: Error;
	rejectText?: Error;
	rejectToolCalls?: Error;
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
	// suppress unhandled rejection when caller only cares about resolveError
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
		textStream: (async function* () {})(),
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
const noHb = { heartbeat: () => {}, idleHeartbeatMs: 30_000 };
const noOut = () =>
	Object.assign(
		new Error("No output generated. Check the stream for errors."),
		{ name: "AI_NoOutputGeneratedError" },
	);

describe("consumeStream", () => {
	it("collects text + finishReason 'stop' from a normal turn", async () => {
		const r = await consumeStream(
			fakeStream({
				parts: [
					{ type: "text-delta", text: "hello " },
					{ type: "text-delta", text: "world" },
					{ type: "finish-step", finishReason: "stop" },
				],
				finishReason: "stop",
				usage: { inputTokens: 10, outputTokens: 5 },
			}),
			noHb,
		);
		expect(r.text).toBe("hello world");
		expect(r.sawFinishStep).toBe(true);
		expect(r.finishReason).toBe("stop");
		expect(r.usageResolved).toBe(true);
		expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
	});

	it("collects tool calls + finishReason 'tool-calls'", async () => {
		const r = await consumeStream(
			fakeStream({
				parts: [
					{
						type: "tool-call",
						toolCallId: "t1",
						toolName: "get_cards",
						input: { board_id: "1" },
					},
					{ type: "finish-step", finishReason: "tool-calls" },
				],
				finishReason: "tool-calls",
				usage: { inputTokens: 8, outputTokens: 2 },
			}),
			noHb,
		);
		expect(r.toolCalls).toEqual([
			{
				toolCallId: "t1",
				toolName: "get_cards",
				input: { board_id: "1" },
			},
		]);
		expect(r.finishReason).toBe("tool-calls");
		expect(r.sawFinishStep).toBe(true);
	});

	it("zero-finish-step truncation: finishReason + usage both reject (Codex F3)", async () => {
		const r = await consumeStream(
			fakeStream({
				parts: [],
				rejectFinishReason: noOut(),
				rejectUsage: noOut(),
			}),
			noHb,
		);
		expect(r.text).toBe("");
		expect(r.toolCalls).toHaveLength(0);
		expect(r.sawFinishStep).toBe(false);
		expect(r.usageResolved).toBe(false);
		expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
		expect(isNoOutputGeneratedError(r.resolveError)).toBe(true);
	});

	it("captures an 'error' part as streamError without throwing", async () => {
		const boom = new Error("HTTP 503");
		const r = await consumeStream(
			fakeStream({
				parts: [{ type: "error", error: boom }],
				rejectFinishReason: noOut(),
			}),
			noHb,
		);
		expect(r.streamError).toBe(boom);
	});

	it("finish-step empty + finishReason 'length' (output cut off)", async () => {
		const r = await consumeStream(
			fakeStream({
				parts: [{ type: "finish-step", finishReason: "length" }],
				finishReason: "length",
				usage: { inputTokens: 100, outputTokens: 16384 },
			}),
			noHb,
		);
		expect(r.sawFinishStep).toBe(true);
		expect(r.finishReason).toBe("length");
		expect(r.text).toBe("");
	});

	// Fix 1 — text channel rejects with a genuine error; finishReason+usage reject NoOutput
	// → resolveError must be the genuine one (not a NoOutput)
	it("text rejects genuine while finishReason+usage reject NoOutput → genuine resolveError [Fix1]", async () => {
		const genuine = new Error("provider HTTP 500");
		const r = await consumeStream(
			fakeStream({
				parts: [],
				rejectText: genuine,
				rejectFinishReason: noOut(),
				rejectUsage: noOut(),
			}),
			noHb,
		);
		expect(isNoOutputGeneratedError(r.resolveError)).toBe(false);
		expect(r.resolveError).toBe(genuine);
	});

	// Fix 1 — toolCalls channel rejects with a genuine error; finishReason+usage reject NoOutput
	it("toolCalls rejects genuine while finishReason+usage reject NoOutput → genuine resolveError [Fix1]", async () => {
		const genuine = new Error("provider HTTP 429");
		const r = await consumeStream(
			fakeStream({
				parts: [],
				rejectToolCalls: genuine,
				rejectFinishReason: noOut(),
				rejectUsage: noOut(),
			}),
			noHb,
		);
		expect(isNoOutputGeneratedError(r.resolveError)).toBe(false);
		expect(r.resolveError).toBe(genuine);
	});

	// Fix 2 — two error parts: genuine first then NoOutput → streamError is the genuine one
	it("two error parts (genuine first, NoOutput second) → streamError is genuine [Fix2]", async () => {
		const genuine = new Error("HTTP 503");
		const noOutErr = Object.assign(new Error("No output generated"), {
			name: "AI_NoOutputGeneratedError",
		});
		const r = await consumeStream(
			fakeStream({
				parts: [
					{ type: "error", error: genuine },
					{ type: "error", error: noOutErr },
				],
				rejectFinishReason: noOut(),
			}),
			noHb,
		);
		expect(isNoOutputGeneratedError(r.streamError)).toBe(false);
		expect(r.streamError).toBe(genuine);
	});

	// Fix 2 — two error parts: NoOutput first then genuine → streamError is still the genuine one
	it("two error parts (NoOutput first, genuine second) → streamError is genuine [Fix2]", async () => {
		const genuine = new Error("HTTP 503");
		const noOutErr = Object.assign(new Error("No output generated"), {
			name: "AI_NoOutputGeneratedError",
		});
		const r = await consumeStream(
			fakeStream({
				parts: [
					{ type: "error", error: noOutErr },
					{ type: "error", error: genuine },
				],
				rejectFinishReason: noOut(),
			}),
			noHb,
		);
		expect(isNoOutputGeneratedError(r.streamError)).toBe(false);
		expect(r.streamError).toBe(genuine);
	});

	// opus #5 — usage fulfilled but undefined → usageResolved false, usage defaults to {0,0}
	it("usage fulfilled-but-undefined → usageResolved:false, usage:{inputTokens:0,outputTokens:0} [opus#5]", async () => {
		const r = await consumeStream(
			fakeStream({
				parts: [{ type: "finish-step", finishReason: "stop" }],
				finishReason: "stop",
				usage: undefined,
			}),
			noHb,
		);
		expect(r.usageResolved).toBe(false);
		expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
	});
});
