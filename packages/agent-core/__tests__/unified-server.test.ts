import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createUnifiedServer,
	EMPTY_RESPONSE_FALLBACK,
	type LangGraphStreamEvent,
	sanitizeStateForCopilotKit,
	stripEmptyResponseFallbacks,
} from "../src/unified-server";

function createTestApp(events: LangGraphStreamEvent[]) {
	return createUnifiedServer(
		{
			name: "test-agent",
			description: "Test agent",
			baseUrl: "http://localhost:3000",
			port: 3000,
			skills: [],
			supportsStreaming: true,
		},
		async () => ({ response: "ok" }),
		(output) => ({
			response:
				typeof output.response === "string" ? output.response : "",
		}),
		undefined,
		async function* () {
			for (const event of events) {
				yield event;
			}
		},
	).app;
}

async function readAgUiEvents(response: Response) {
	const body = await response.text();

	return body.split("\n\n").flatMap((chunk) =>
		chunk
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map(
				(line) => JSON.parse(line.slice(6)) as Record<string, unknown>,
			),
	);
}

describe("createUnifiedServer AG-UI streaming", () => {
	beforeEach(() => {
		vi.stubEnv("AGENT_API_KEY", "");
		vi.stubEnv("AGENT_API_KEYS", "");
		vi.stubEnv("AGENT_HMAC_SECRET", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("emits a terminal STATE_SNAPSHOT even when the run has no document payload", async () => {
		// Post-confirmation acknowledgment turns (e.g. the agent replying
		// "Applied your changes.") carry no new document content. useCoAgent
		// relies on the nodeName "end" snapshot to detect run completion, so
		// skipping it here would leave the frontend waiting until the browser
		// times out.
		const app = createTestApp([
			{
				nodeName: "tool_node",
				state: {
					messages: [
						{ type: "human", content: "Confirm the change." },
						{ type: "ai", content: "Done." },
					],
				},
			},
		]);

		const response = await app.request("/", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messages: [{ role: "user", content: "Confirm the change." }],
			}),
		});

		expect(response.status).toBe(200);

		const events = await readAgUiEvents(response);
		const terminalSnapshots = events.filter(
			(event) =>
				event.type === "STATE_SNAPSHOT" && event.nodeName === "end",
		);

		expect(terminalSnapshots).toHaveLength(1);
	});

	it("emits a terminal STATE_SNAPSHOT when the run produced document content", async () => {
		const app = createTestApp([
			{
				nodeName: "draft_document",
				state: {
					document: "# Updated document",
				},
			},
		]);

		const response = await app.request("/", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messages: [{ role: "user", content: "Update the document." }],
			}),
		});

		expect(response.status).toBe(200);

		const events = await readAgUiEvents(response);
		const terminalSnapshots = events.filter(
			(event) =>
				event.type === "STATE_SNAPSHOT" && event.nodeName === "end",
		);

		expect(terminalSnapshots).toHaveLength(1);
		expect(terminalSnapshots[0]?.snapshot).toMatchObject({
			document: "# Updated document",
		});
	});

	it("preserves client-managed fields from incoming body.state in the terminal snapshot", async () => {
		// useCoAgent replaces its state from the terminal STATE_SNAPSHOT
		// payload. Client-managed fields that the graph doesn't own
		// (projectId, organizationId, promptId, …) must survive the
		// replacement, otherwise subsequent agent turns lose tenant context.
		const app = createTestApp([
			{
				nodeName: "tool_node",
				state: {
					messages: [{ type: "ai", content: "Done." }],
				},
			},
		]);

		const response = await app.request("/", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messages: [{ role: "user", content: "Confirm the change." }],
				state: {
					projectId: "proj_123",
					organizationId: "org_456",
					promptId: "prompt_789",
					document: "# Existing document",
				},
			}),
		});

		expect(response.status).toBe(200);

		const events = await readAgUiEvents(response);
		const terminalSnapshots = events.filter(
			(event) =>
				event.type === "STATE_SNAPSHOT" && event.nodeName === "end",
		);

		expect(terminalSnapshots).toHaveLength(1);
		expect(terminalSnapshots[0]?.snapshot).toMatchObject({
			projectId: "proj_123",
			organizationId: "org_456",
			promptId: "prompt_789",
			document: "# Existing document",
		});
	});

	it("drops graph-owned transient fields from incoming body.state in the terminal snapshot", async () => {
		// Graph-owned fields like focusAnchor / error / retryCount are
		// declared in the agent state but never set by the client. The client
		// echoes their previous values back in body.state. Blindly merging
		// them replays stale values — e.g. the DocumentEditor re-scrolls to a
		// previous focusAnchor on every post-confirmation "end" snapshot.
		const app = createTestApp([
			{
				nodeName: "tool_node",
				state: {
					messages: [{ type: "ai", content: "Done." }],
				},
			},
		]);

		const response = await app.request("/", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messages: [{ role: "user", content: "Confirm the change." }],
				state: {
					projectId: "proj_123",
					focusAnchor: "## Stale Section",
					error: "stale error",
					retryCount: 3,
				},
			}),
		});

		expect(response.status).toBe(200);

		const events = await readAgUiEvents(response);
		const terminalSnapshots = events.filter(
			(event) =>
				event.type === "STATE_SNAPSHOT" && event.nodeName === "end",
		);

		expect(terminalSnapshots).toHaveLength(1);
		const snapshot = terminalSnapshots[0]?.snapshot as Record<
			string,
			unknown
		>;
		expect(snapshot.projectId).toBe("proj_123");
		expect(snapshot).not.toHaveProperty("focusAnchor");
		expect(snapshot).not.toHaveProperty("error");
		expect(snapshot).not.toHaveProperty("retryCount");
	});

	it("lets graph-produced fields win over incoming body.state in the terminal snapshot", async () => {
		const app = createTestApp([
			{
				nodeName: "draft_document",
				state: {
					document: "# Updated document",
				},
			},
		]);

		const response = await app.request("/", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messages: [{ role: "user", content: "Update the document." }],
				state: {
					projectId: "proj_123",
					document: "# Stale client doc",
				},
			}),
		});

		expect(response.status).toBe(200);

		const events = await readAgUiEvents(response);
		const terminalSnapshots = events.filter(
			(event) =>
				event.type === "STATE_SNAPSHOT" && event.nodeName === "end",
		);

		expect(terminalSnapshots).toHaveLength(1);
		expect(terminalSnapshots[0]?.snapshot).toMatchObject({
			projectId: "proj_123",
			document: "# Updated document",
		});
	});

	it("keeps graph-produced transient fields when the graph emits them", async () => {
		// The denylist only drops stale body.state values. When the graph
		// itself emits focusAnchor / error / retryCount, those must flow
		// through to the terminal snapshot.
		const app = createTestApp([
			{
				nodeName: "draft_document",
				state: {
					document: "# Updated",
					focusAnchor: "## Overview",
					retryCount: 1,
				},
			},
		]);

		const response = await app.request("/", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messages: [{ role: "user", content: "Update." }],
				state: {
					projectId: "proj_123",
					focusAnchor: "## Stale Section",
				},
			}),
		});

		expect(response.status).toBe(200);

		const events = await readAgUiEvents(response);
		const terminalSnapshots = events.filter(
			(event) =>
				event.type === "STATE_SNAPSHOT" && event.nodeName === "end",
		);

		expect(terminalSnapshots).toHaveLength(1);
		expect(terminalSnapshots[0]?.snapshot).toMatchObject({
			projectId: "proj_123",
			document: "# Updated",
			focusAnchor: "## Overview",
			retryCount: 1,
		});
	});
});

describe("sanitizeStateForCopilotKit — reasoningByTurn passthrough", () => {
	// Regression coverage for Codex Finding 6: the AG-UI sanitize pass is the
	// last shared chokepoint between real model output and the React
	// `useCoAgent` state on the client. If someone refactors the function to
	// whitelist known fields (instead of the current shallow copy), custom
	// agent state like `reasoningByTurn` would silently disappear from
	// STATE_SNAPSHOT events. These tests guard byte-equal passthrough.
	it("preserves reasoningByTurn keys intact through shallow copy", () => {
		const state = {
			messages: [
				{ type: "human", content: "Hello", id: "u1" },
				{ type: "ai", content: "Hi", id: "a1" },
			],
			document: "Test document",
			reasoningByTurn: {
				1: {
					text: "Internal reasoning text",
					durationMs: 4200,
					startedAt: 1000,
					completedAt: 5200,
				},
				2: {
					text: "Second turn thinking",
					durationMs: 3000,
					startedAt: 6000,
					completedAt: 9000,
				},
			},
		};

		const sanitized = sanitizeStateForCopilotKit(state);

		// The full reasoningByTurn record survives the shallow copy.
		expect(sanitized.reasoningByTurn).toEqual({
			1: {
				text: "Internal reasoning text",
				durationMs: 4200,
				startedAt: 1000,
				completedAt: 5200,
			},
			2: {
				text: "Second turn thinking",
				durationMs: 3000,
				startedAt: 6000,
				completedAt: 9000,
			},
		});
		// And other fields are still there (messages was transformed,
		// document untouched).
		expect(sanitized.document).toBe("Test document");
		expect(Array.isArray(sanitized.messages)).toBe(true);
	});

	it("preserves empty reasoningByTurn record", () => {
		const state = {
			messages: [],
			reasoningByTurn: {},
		};

		const sanitized = sanitizeStateForCopilotKit(state);
		expect(sanitized.reasoningByTurn).toEqual({});
	});

	it("does not introduce reasoningByTurn when absent from input", () => {
		const state = { messages: [], document: "x" };
		const sanitized = sanitizeStateForCopilotKit(state);
		expect(sanitized.reasoningByTurn).toBeUndefined();
	});
});

// =============================================================================
// Terminal graph errors
// =============================================================================
//
// Graph nodes report fatal errors by returning `goto: END` with `error` set
// rather than throwing, so the RUN_ERROR catch never fires for them, and the
// generic text fallback is skipped once a frontend action has been emitted.
// Without an explicit terminal-error path such a run finishes as
// STATE_SNAPSHOT + RUN_FINISHED with no assistant turn at all: nothing renders
// and nothing is persisted to the transcript, because no client reads `error`
// off the state snapshot.

describe("createUnifiedServer terminal errors", () => {
	beforeEach(() => {
		vi.stubEnv("AGENT_API_KEY", "");
		vi.stubEnv("AGENT_API_KEYS", "");
		vi.stubEnv("AGENT_HMAC_SECRET", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	async function runWith(
		events: LangGraphStreamEvent[],
	): Promise<Record<string, unknown>[]> {
		const response = await createTestApp(events).request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: "Do the thing." }],
			}),
		});
		expect(response.status).toBe(200);
		return readAgUiEvents(response);
	}

	const textOf = (events: Record<string, unknown>[]) =>
		events
			.filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
			.map((e) => String(e.delta ?? ""))
			.join("");

	it("emits a terminal error as assistant text, wrapped in one start/end pair", async () => {
		const events = await runWith([
			{
				nodeName: "chat_node",
				state: { error: "The AI provider rejected the request." },
			},
		]);

		expect(
			events.filter((e) => e.type === "TEXT_MESSAGE_START"),
		).toHaveLength(1);
		expect(
			events.filter((e) => e.type === "TEXT_MESSAGE_END"),
		).toHaveLength(1);
		expect(textOf(events)).toContain(
			"The AI provider rejected the request.",
		);
		expect(events.some((e) => e.type === "RUN_FINISHED")).toBe(true);
	});

	it("prefers a safe response over the raw error", async () => {
		// Several agents keep the raw exception in `error` for logs and the
		// user-safe explanation in `response`. Rendering `error` would publish
		// internal failure detail into durable chat history.
		const events = await runWith([
			{
				nodeName: "chat_node",
				state: {
					error: "TypeError: cannot read property 'x' of undefined",
					response: "Something went wrong. Please try again.",
				},
			},
		]);

		const text = textOf(events);
		expect(text).toContain("Something went wrong. Please try again.");
		expect(text).not.toContain("TypeError");
	});

	it("does not emit the error twice when it was already streamed as AI text", async () => {
		const events = await runWith([
			{
				nodeName: "chat_node",
				state: {
					error: "Could not finish.",
					messages: [
						{ type: "human", content: "Do the thing." },
						{ type: "ai", content: "Could not finish." },
					],
				},
			},
		]);

		expect(
			events.filter((e) => e.type === "TEXT_MESSAGE_START"),
		).toHaveLength(1);
		const occurrences =
			textOf(events).split("Could not finish.").length - 1;
		expect(occurrences).toBe(1);
	});

	it("emits nothing extra for a successful run with no error", async () => {
		const events = await runWith([
			{
				nodeName: "chat_node",
				state: {
					messages: [
						{ type: "human", content: "Do the thing." },
						{ type: "ai", content: "All done." },
					],
				},
			},
		]);

		expect(textOf(events)).toContain("All done.");
		expect(
			events.filter((e) => e.type === "TEXT_MESSAGE_START").length,
		).toBeLessThanOrEqual(1);
	});

	it("surfaces a terminal error after emitting a frontend tool call", async () => {
		// The condition the generic fallback is gated against: once a frontend
		// tool call has been emitted it stops looking for AI text, so a graph
		// that then terminates with `error` set would otherwise finish with no
		// assistant turn at all.
		const events = await runWith([
			{
				nodeName: "chat_node",
				state: {
					messages: [
						{ type: "human", content: "Do the thing." },
						{
							type: "ai",
							content: "",
							tool_calls: [
								{
									id: "call_confirm",
									name: "confirm_changes",
									args: {},
								},
							],
						},
					],
				},
			},
			{
				nodeName: "chat_node",
				state: { error: "Could not finish." },
			},
		]);

		expect(events.some((e) => e.type === "TOOL_CALL_START")).toBe(true);
		expect(textOf(events)).toContain("Could not finish.");
		expect(
			events.filter((e) => e.type === "TEXT_MESSAGE_START"),
		).toHaveLength(1);
		expect(
			events.filter((e) => e.type === "TEXT_MESSAGE_END"),
		).toHaveLength(1);
	});

	it("does not surface a non-string error value", async () => {
		// Agents type `error` loosely; only a non-empty string is user-facing
		// copy. Anything else must not be stringified into the transcript.
		const events = await runWith([
			{
				nodeName: "chat_node",
				state: { error: { code: 500 } },
			},
		]);

		expect(textOf(events)).not.toContain("[object Object]");
		expect(textOf(events)).not.toContain("500");
		expect(events.some((e) => e.type === "RUN_FINISHED")).toBe(true);
	});

	it("delivers every non-droppable node delta even while droppable previews are being coalesced under backpressure", async () => {
		// A burst of droppable preview events fired back-to-back with no
		// consumer draining in between reliably pushes the stream's
		// desiredSize <= 0 (proven by the drop count asserted below). Two
		// distinct non-droppable node deltas are interleaved — unlike the
		// previews, deltas must ALL survive regardless of backpressure.
		const fillerBurst = (prefix: string): LangGraphStreamEvent[] =>
			Array.from({ length: 8 }, (_, i) => ({
				nodeName: "chat_node",
				state: { document: `${prefix} ${i}` },
				droppable: true,
			}));

		const events = await runWith([
			...fillerBurst("preview-a"),
			{ nodeName: "node_a", state: { document: "DELTA_A" } },
			...fillerBurst("preview-b"),
			{ nodeName: "node_b", state: { document: "DELTA_B" } },
		]);

		const snapshots = events.filter(
			(e) => e.type === "STATE_SNAPSHOT",
		) as Array<{ nodeName?: string; snapshot?: { document?: string } }>;

		// Sanity check that backpressure was actually exercised — otherwise
		// this test would pass trivially without the gate doing anything.
		const previewSnapshots = snapshots.filter((s) =>
			s.snapshot?.document?.startsWith("preview-"),
		);
		expect(previewSnapshots.length).toBeLessThan(16);

		// Both node deltas reached the output exactly once (by originating
		// node, not just content — the terminal "end" snapshot also carries
		// the final document value and must not be conflated with the
		// interim delta it came from). Coalescing never applies to
		// non-droppable events.
		expect(snapshots.filter((s) => s.nodeName === "node_a")).toHaveLength(
			1,
		);
		expect(snapshots.filter((s) => s.nodeName === "node_b")).toHaveLength(
			1,
		);
	});

	it("flushes a held droppable preview BEFORE the tool-call events derived from newer state (barrier ordering)", async () => {
		// A burst of droppable previews builds up a pending, coalesced
		// snapshot under backpressure; the very next event is a non-droppable
		// delta carrying a frontend tool call. The barrier must flush the
		// pending preview first, so the frontend never processes a TOOL_CALL
		// against state older than what it was just shown.
		const previewBurst: LangGraphStreamEvent[] = Array.from(
			{ length: 10 },
			(_, i) => ({
				nodeName: "chat_node",
				state: { document: `preview ${i}` },
				droppable: true,
			}),
		);

		const events = await runWith([
			...previewBurst,
			{
				nodeName: "chat_node",
				state: {
					messages: [
						{
							type: "ai",
							content: "",
							tool_calls: [
								{
									id: "tc1",
									name: "some_frontend_action",
									args: { foo: "bar" },
								},
							],
						},
					],
				},
			},
		]);

		const toolCallStartIdx = events.findIndex(
			(e) => e.type === "TOOL_CALL_START",
		);
		expect(toolCallStartIdx).toBeGreaterThan(-1);

		// Every "preview N" STATE_SNAPSHOT from the interim (non-terminal)
		// stream, by its position in the full event stream. The terminal
		// "end" snapshot is excluded: it carries the shallow-merged
		// finalState, which still has `document: "preview N"` from whichever
		// preview last set it — that's an unrelated artifact of the terminal
		// snapshot always reflecting the last-known value, not evidence of
		// gate ordering.
		const previewIndexes = events.reduce<number[]>((acc, e, i) => {
			const evt = e as {
				nodeName?: string;
				snapshot?: { document?: string };
			};
			if (
				e.type === "STATE_SNAPSHOT" &&
				evt.nodeName !== "end" &&
				typeof evt.snapshot?.document === "string" &&
				/^preview \d+$/.test(evt.snapshot.document)
			) {
				acc.push(i);
			}
			return acc;
		}, []);

		// Some previews were coalesced away (backpressure actually occurred) —
		// otherwise this test would pass trivially without the gate doing
		// anything.
		expect(previewIndexes.length).toBeGreaterThan(0);
		expect(previewIndexes.length).toBeLessThan(previewBurst.length);

		// The held pending preview is flushed by the barrier immediately
		// before the tool-call sequence — it (and every other surviving
		// preview) must appear strictly BEFORE TOOL_CALL_START, never after.
		expect(Math.max(...previewIndexes)).toBeLessThan(toolCallStartIdx);
	});

	it("flushes a held step-A droppable preview BEFORE STEP_FINISHED(A)/STEP_STARTED(B) on a step boundary", async () => {
		// A step transition is itself derived from event state (transitionStep
		// runs at the top of the loop, ahead of the STATE_SNAPSHOT for that
		// event). If a step-A preview is still held when a step-B event
		// arrives, STEP_FINISHED(A) must not be delivered ahead of it — the
		// consumer would otherwise see the step close before the last state
		// it produced.
		const stepABurst: LangGraphStreamEvent[] = Array.from(
			{ length: 10 },
			(_, i) => ({
				nodeName: "step_a",
				state: { document: `preview ${i}` },
				droppable: true,
			}),
		);

		const events = await runWith([
			...stepABurst,
			{ nodeName: "step_b", state: { document: "DELTA_B" } },
		]);

		const stepFinishedAIdx = events.findIndex(
			(e) => e.type === "STEP_FINISHED" && e.stepName === "step_a",
		);
		const stepStartedBIdx = events.findIndex(
			(e) => e.type === "STEP_STARTED" && e.stepName === "step_b",
		);
		expect(stepFinishedAIdx).toBeGreaterThan(-1);
		expect(stepStartedBIdx).toBeGreaterThan(stepFinishedAIdx);

		// Every surviving "preview N" STATE_SNAPSHOT from the interim stream,
		// excluding the terminal "end" snapshot (same reasoning as the test
		// above — its shallow-merged finalState carries a stale "preview N"
		// document value unrelated to gate ordering).
		const previewIndexes = events.reduce<number[]>((acc, e, i) => {
			const evt = e as {
				nodeName?: string;
				snapshot?: { document?: string };
			};
			if (
				e.type === "STATE_SNAPSHOT" &&
				evt.nodeName !== "end" &&
				typeof evt.snapshot?.document === "string" &&
				/^preview \d+$/.test(evt.snapshot.document)
			) {
				acc.push(i);
			}
			return acc;
		}, []);

		// Backpressure actually coalesced some previews away — otherwise this
		// test proves nothing about the gate.
		expect(previewIndexes.length).toBeGreaterThan(0);
		expect(previewIndexes.length).toBeLessThan(stepABurst.length);

		// The held pending preview is flushed before the step boundary closes
		// step A, never after.
		expect(Math.max(...previewIndexes)).toBeLessThan(stepFinishedAIdx);
	});
});

// =============================================================================
// Empty-response notices must not become conversation history
// =============================================================================

describe("stripEmptyResponseFallbacks", () => {
	it("drops an assistant turn that is only the empty-response notice", () => {
		// The failure this exists for: the client persists whatever the
		// assistant emitted, so the notice returned as a normal assistant turn
		// and was replayed to the model, making each retry likelier to fail the
		// same way. Retrying has to start from a clean history.
		const result = stripEmptyResponseFallbacks([
			{ role: "user", content: "Draft the acceptance criteria" },
			{ role: "assistant", content: EMPTY_RESPONSE_FALLBACK },
			{ role: "user", content: "Try again" },
		]);

		expect(result).toEqual([
			{ role: "user", content: "Draft the acceptance criteria" },
			{ role: "user", content: "Try again" },
		]);
	});

	it("keeps a user turn even when it repeats the notice verbatim", () => {
		// A person quoting the error back is asking a real question, and
		// silently discarding their message would lose the turn entirely.
		const messages = [{ role: "user", content: EMPTY_RESPONSE_FALLBACK }];

		expect(stripEmptyResponseFallbacks(messages)).toEqual(messages);
	});

	it("keeps assistant turns that genuinely answered", () => {
		const messages = [
			{
				role: "assistant",
				content: "Here are the criteria you asked for.",
			},
			{ type: "ai", content: "And the diagram." },
		];

		expect(stripEmptyResponseFallbacks(messages)).toEqual(messages);
	});

	it("drops the notice in LangGraph 'ai' type shape and block content", () => {
		// Threads reach this endpoint in more than one shape; the notice has to
		// be recognised in each, or the poisoning survives in whichever the
		// filter missed.
		const result = stripEmptyResponseFallbacks([
			{ type: "ai", content: EMPTY_RESPONSE_FALLBACK },
			{
				role: "assistant",
				content: [{ type: "text", text: EMPTY_RESPONSE_FALLBACK }],
			},
			{ type: "human", content: "still there?" },
		]);

		expect(result).toEqual([{ type: "human", content: "still there?" }]);
	});

	it("keeps a notice-shaped turn that made tool calls, so its results keep their parent", () => {
		// Dropping a turn that owns tool_calls orphans the tool results that
		// follow it, and providers reject that with a 400 — which would surface
		// as the same silent failure this filter exists to stop.
		const messages = [
			{
				role: "assistant",
				content: EMPTY_RESPONSE_FALLBACK,
				tool_calls: [{ id: "call_1", name: "write_document" }],
			},
			{ role: "tool", tool_call_id: "call_1", content: "ok" },
		];

		expect(stripEmptyResponseFallbacks(messages)).toEqual(messages);
	});

	it("passes through non-object entries untouched", () => {
		const messages = [null, "raw", 42];

		expect(stripEmptyResponseFallbacks(messages)).toEqual(messages);
	});
});
