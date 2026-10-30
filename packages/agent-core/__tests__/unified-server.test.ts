import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createUnifiedServer,
	EMPTY_RESPONSE_FALLBACK,
	type LangGraphStreamEvent,
	sanitizeStateForCopilotKit,
	stripEmptyResponseFallbacks,
} from "../src/unified-server";
import { convertToSimpleMessages } from "../src/utils/message-converter";

const { modelWireFetch } = vi.hoisted(() => ({ modelWireFetch: vi.fn() }));
vi.mock("undici", async () => ({
	...(await vi.importActual<typeof import("undici")>("undici")),
	fetch: modelWireFetch,
}));

import {
	createProviderModel,
	extractProviderConfig,
} from "../src/services/langchain-models";

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

	it.each([undefined, "caller-thread"])(
		"forwards the AG-UI thread and preserves explicit thread %s",
		async (explicitThread) => {
			const configs: Record<string, unknown>[] = [];
			const { app } = createUnifiedServer(
				{
					name: "example-agent",
					description: "Example",
					baseUrl: "http://localhost:3000",
					port: 3000,
					skills: [],
					supportsStreaming: true,
				},
				async () => ({ response: "ok" }),
				() => ({ response: "ok" }),
				undefined,
				async function* (_messages, config) {
					configs.push(config?.configurable ?? {});
					yield { nodeName: "chat", state: { messages: [] } };
				},
			);
			const response = await app.request("/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					threadId: "t-1",
					messages: [{ role: "user", content: "Hello" }],
					config: { configurable: { thread_id: explicitThread } },
				}),
			});
			await response.text();
			expect(configs[0]?.thread_id).toBe(explicitThread ?? "t-1");
		},
	);

	it("mints distinct reply ids at the same millisecond and overwrites request provenance keys", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1793000000000);
		try {
			const configs: Record<string, unknown>[] = [];
			const app = createUnifiedServer(
				{
					name: "example-agent",
					description: "Example",
					baseUrl: "http://localhost:3000",
					port: 3000,
					skills: [],
					supportsStreaming: true,
				},
				async () => ({ response: "ok" }),
				(output) => ({ response: String(output.response ?? "") }),
				undefined,
				async function* (_messages, config) {
					configs.push(config?.configurable ?? {});
					yield {
						nodeName: "chat_node",
						state: {
							messages: [
								{ type: "ai", content: "Example reply" },
							],
						},
					};
				},
			).app;
			const ids: unknown[] = [];
			for (const bag of [
				"forwardedProps",
				"context",
				"properties",
				"config",
			]) {
				const forged = {
					output_message_id:
						"msg_1793000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				};
				const response = await app.request("/", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						messages: [{ role: "user", content: "Example" }],
						[bag]:
							bag === "config"
								? { configurable: forged }
								: forged,
					}),
				});
				const events = await readAgUiEvents(response);
				const id = events.find(
					(e) => e.type === "TEXT_MESSAGE_START",
				)?.messageId;
				expect(id).toMatch(/^msg_1793000000000_[0-9a-f]{32}$/);
				expect(id).not.toBe(forged.output_message_id);
				expect(configs.at(-1)?.output_message_id).toBe(id);
				for (const e of events.filter((e) =>
					[
						"TEXT_MESSAGE_START",
						"TEXT_MESSAGE_CONTENT",
						"TEXT_MESSAGE_END",
					].includes(String(e.type)),
				)) {
					expect(e.messageId).toBe(id);
				}
				ids.push(id);
			}
			expect(new Set(ids).size).toBe(4);
		} finally {
			vi.restoreAllMocks();
		}
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

	it.each(["chat_node", "enhance_node"])(
		"round-trips confirm arguments for %s",
		async (nodeName) => {
			const draftId =
				"msg_1793200000000_" +
				"a".repeat(32) +
				":00000000-0000-4000-8000-000000000001";
			const events = await runWith([
				{
					nodeName,
					state: {
						messages: [
							{
								type: "ai",
								content: "",
								tool_calls: [
									{
										id: "example-confirm",
										type: "function",
										function: {
											name: "confirm_changes",
											arguments: { draftId },
										},
									},
								],
							},
						],
					},
				},
			]);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "TOOL_CALL_ARGS",
					delta: JSON.stringify({ draftId }),
				}),
			);
		},
	);
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

describe("usage conversation runtime config", () => {
	it.each(["conversation-example", undefined])(
		"passes explicit usage metadata without a thread fallback (%s)",
		async (usageConversationId) => {
			vi.stubEnv("AGENT_API_KEY", "");
			vi.stubEnv("AGENT_API_KEYS", "");
			vi.stubEnv("AGENT_HMAC_SECRET", "");
			let received: Record<string, unknown> | undefined;
			try {
				const { app } = createUnifiedServer(
					{
						name: "example-agent",
						description: "Example",
						baseUrl: "http://localhost:3000",
						port: 3000,
						skills: [],
					},
					async () => ({}),
					() => ({ response: "done" }),
					undefined,
					async function* (_input, config) {
						received = config?.configurable;
						yield {
							nodeName: "end",
							state: {
								messages: [
									{ role: "assistant", content: "done" },
								],
							},
						};
					},
				);
				const response = await app.request("/runs/stream", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						thread_id: "thread-example",
						input: {
							messages: [{ role: "user", content: "hello" }],
							usage_conversation_id: usageConversationId,
							usage_project_id: "origin-project",
							usage_frame_id: "origin-frame",
							usage_feature_key: "chat-agent",
						},
					}),
				});
				await response.text();
				expect(response.status).toBe(200);
				expect(received?.usage_conversation_id).toBe(
					usageConversationId,
				);
				expect(received).toMatchObject({
					usage_project_id: "origin-project",
					usage_frame_id: "origin-frame",
					usage_feature_key: "chat-agent",
				});
			} finally {
				vi.unstubAllEnvs();
			}
		},
	);

	it.each([undefined, "caller-thread"])(
		"forwards the path thread and preserves explicit thread %s",
		async (explicitThread) => {
			vi.stubEnv("AGENT_API_KEY", "");
			vi.stubEnv("AGENT_API_KEYS", "");
			vi.stubEnv("AGENT_HMAC_SECRET", "");
			let received: Record<string, unknown> | undefined;
			try {
				const { app } = createUnifiedServer(
					{
						name: "example-agent",
						description: "Example",
						baseUrl: "http://localhost:3000",
						port: 3000,
						skills: [],
					},
					async () => ({}),
					() => ({ response: "done" }),
					undefined,
					async function* (_input, config) {
						received = config?.configurable;
						yield {
							nodeName: "end",
							state: {
								messages: [
									{ role: "assistant", content: "done" },
								],
							},
						};
					},
				);
				const response = await app.request(
					"/threads/thread-example/runs/stream",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							input: {
								messages: [{ role: "user", content: "hello" }],
							},
							config: {
								configurable: { thread_id: explicitThread },
							},
						}),
					},
				);
				await response.text();
				expect(response.status).toBe(200);
				expect(received?.thread_id).toBe(
					explicitThread ?? "thread-example",
				);
			} finally {
				vi.unstubAllEnvs();
			}
		},
	);
});

describe("invoke model and tenant propagation", () => {
	beforeEach(() => {
		vi.stubEnv("AGENT_API_KEY", "");
		vi.stubEnv("AGENT_API_KEYS", "");
		vi.stubEnv("AGENT_HMAC_SECRET", "");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it.each(["/runs/stream", "/"])(
		"passes exchanged config through %s without a stream executor",
		async (path) => {
			const exchange = await import("../src/services/token-exchange");
			vi.spyOn(exchange, "getAICredentialsFromHeaders").mockResolvedValue(
				{
					apiKey: "test-key",
					model: "example-model",
					provider: "openai",
					baseUrl: "https://example.com",
					deploymentName: "example-deployment",
					expiresIn: 300,
				},
			);
			const invoke = vi.fn().mockResolvedValue({ response: "done" });
			const { app } = createUnifiedServer(
				{
					name: "example-agent",
					description: "Example",
					baseUrl: "http://localhost:3000",
					port: 3000,
					skills: [],
				},
				invoke,
				() => ({ response: "done" }),
			);
			const response = await app.request(path, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AI-Token": "test-token",
					"X-Tenant-User-Id": "example-user",
					"X-Tenant-Organization-Id": "example-org",
				},
				body: JSON.stringify(
					path === "/a2a/send"
						? {
								message: {
									role: "user",
									parts: [{ type: "text", text: "hello" }],
								},
							}
						: path === "/runs/stream"
							? {
									input: {
										messages: [
											{ role: "user", content: "hello" },
										],
									},
								}
							: {
									messages: [
										{ role: "user", content: "hello" },
									],
								},
				),
			});
			await response.text();
			expect(response.status).toBe(200);
			expect(invoke).toHaveBeenCalledTimes(1);
			const expected = {
				ai_api_key: "test-key",
				ai_model: "example-model",
				ai_provider: "openai",
				tenant_user_id: "example-user",
				tenant_organization_id: "example-org",
				ai_token: "test-token",
			};
			expect(invoke.mock.calls[0][1]).toMatchObject({
				configurable: {
					...expected,
					ai_gateway_url: "https://example.com",
				},
			});
		},
	);
});

describe("server-resolved graph configuration", () => {
	const untrusted = {
		tenant_user_id: "other-user",
		tenant_organization_id: "other-org",
		ai_gateway_url: "https://untrusted.example.com",
		ai_base_url: "https://untrusted.example.com",
		ai_deployment_name: "untrusted-deployment",
		ai_canonical_model_name: "untrusted-model",
		ai_billing_mode: "untrusted-mode",
		ai_billing_customer_id: "untrusted-customer",
		ai_plan_source: "untrusted-plan",
		ai_model_pinned: true,
		ai_max_output_tokens: 99999,
		ai_context_window: 99999,
	};
	beforeEach(() => {
		vi.stubEnv("AGENT_API_KEY", "");
		vi.stubEnv("AGENT_API_KEYS", "");
		vi.stubEnv("AGENT_HMAC_SECRET", "");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});
	async function request(
		path: string,
		source: "exchange" | "headers" | "absent" | "key-only",
		platform = false,
		legacyBodyConfig = true,
	) {
		const legacy = [
			"/runs",
			"/threads/example-thread/runs",
			"/run",
			"/invoke",
			"/stream",
		].includes(path);
		const exchange = await import("../src/services/token-exchange");
		const exchangeSpy = vi
			.spyOn(exchange, "getAICredentialsFromHeaders")
			.mockResolvedValue(
				source === "exchange"
					? {
							apiKey: "test-key",
							model: "example-model",
							provider: "openai",
							expiresIn: 300,
							baseUrl: "https://resolved.example.com",
							deploymentName: "resolved-deployment",
							canonicalModelName: "claude-sonnet-5",
							billingMode: "resolved-mode",
							billingCustomerId: "resolved-customer",
							planSource: "resolved-plan",
							modelPinned: true,
							isReasoningModel: false,
							maxOutputTokens: 8192,
							contextWindow: 32768,
						}
					: source === "key-only"
						? {
								apiKey: "test-key",
								model: "example-model",
								provider: "openai",
								expiresIn: 300,
							}
						: null,
			);
		if (legacy) {
			exchangeSpy.mockRejectedValue(new Error("Example expired token"));
		}
		const invoke = vi.fn().mockResolvedValue({ response: "done" });
		let runtime: Record<string, unknown> | undefined;
		const { app } = createUnifiedServer(
			{
				name: "example-agent",
				description: "Example",
				baseUrl: "http://localhost:3000",
				port: 3000,
				skills: [],
			},
			invoke,
			() => ({ response: "done" }),
			undefined,
			platform
				? async function* (_input, config) {
						runtime = config?.configurable;
						yield {
							nodeName: "end",
							state: {
								messages: [
									{ role: "assistant", content: "done" },
								],
							},
						};
					}
				: undefined,
		);
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (source === "exchange" || source === "key-only") {
			headers["X-AI-Token"] = "test-token";
		}
		if (source === "exchange" || source === "headers") {
			headers["X-Tenant-User-ID"] = "example-user";
			headers["X-Tenant-Organization-ID"] = "example-org";
			headers["X-AI-Base-URL"] = "https://header.example.com";
			headers["X-AI-Deployment-Name"] = "header-deployment";
		}
		if (legacy) {
			headers["X-AI-Model"] = "header-model";
			headers["X-AI-Provider"] = "header-provider";
		}
		const poison = {
			...(legacy && legacyBodyConfig
				? {
						ai_api_key: "body-key",
						ai_model: "body-model",
						ai_provider: "body-provider",
						ai_token: "body-token",
					}
				: {}),
			...untrusted,
			...(source === "exchange" && !legacy
				? {
						ai_is_reasoning: true,
						ai_model: "body-model",
						ai_provider: "body-provider",
					}
				: {}),
			fabric_usage: { ...untrusted, ai_token: "untrusted-token" },
			userId: "other-user",
			organizationId: "other-org",
		};
		const messages = [{ role: "user", content: "hello" }];
		const body = path.startsWith("/a2a/")
			? {
					message: {
						role: "user",
						parts: [{ type: "text", text: "hello" }],
						metadata: poison,
					},
					metadata: poison,
				}
			: {
					...poison,
					messages,
					input: { ...poison, messages },
					config: { configurable: poison },
					configurable: poison,
					context: poison,
					forwardedProps: poison,
					properties: poison,
				};
		const response = await app.request(path, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		await response.text();
		if (legacy) {
			expect(exchangeSpy).not.toHaveBeenCalled();
		}
		expect(response.status).toBe(200);
		if (!platform) {
			expect(invoke).toHaveBeenCalledTimes(1);
		}
		const input = invoke.mock.calls[0]?.[0];
		const received = platform
			? runtime
			: path.includes("runs/stream") || path === "/"
				? invoke.mock.calls[0][1]?.configurable
				: input;
		expect(received).toBeDefined();
		const effectiveSource =
			legacy && source === "exchange" ? "headers" : source;
		const resolved =
			effectiveSource === "exchange"
				? "https://resolved.example.com"
				: effectiveSource === "headers"
					? "https://header.example.com"
					: undefined;
		const expected = {
			ai_model_pinned: effectiveSource === "exchange" ? true : undefined,
			ai_canonical_model_name:
				effectiveSource === "exchange"
					? "claude-sonnet-5"
					: !legacy &&
							(source === "key-only" ||
								(source === "absent" &&
									!path.startsWith("/a2a/")))
						? undefined
						: "untrusted-model",
			ai_max_output_tokens:
				effectiveSource === "exchange" ? 8192 : undefined,
			ai_context_window:
				effectiveSource === "exchange" ? 32768 : undefined,
			tenant_user_id:
				effectiveSource === "exchange" || effectiveSource === "headers"
					? "example-user"
					: undefined,
			tenant_organization_id:
				effectiveSource === "exchange" || effectiveSource === "headers"
					? "example-org"
					: undefined,
			ai_gateway_url: resolved,
			ai_base_url: resolved,
			ai_deployment_name:
				effectiveSource === "exchange"
					? "resolved-deployment"
					: effectiveSource === "headers"
						? "header-deployment"
						: undefined,
			ai_billing_mode:
				effectiveSource === "exchange" ? "resolved-mode" : undefined,
			ai_billing_customer_id:
				effectiveSource === "exchange"
					? "resolved-customer"
					: undefined,
			ai_plan_source:
				effectiveSource === "exchange" ? "resolved-plan" : undefined,
		};
		for (const [key, value] of Object.entries(expected)) {
			expect(received?.[key], key).toBe(value);
		}
		expect(received?.fabric_usage).toBeUndefined();
		if (effectiveSource === "exchange") {
			expect(received?.ai_is_reasoning).toBe(false);
			expect(received?.ai_model).toBe("example-model");
			expect(received?.ai_provider).toBe("openai");
		}
		if (legacy) {
			for (const [key, value] of Object.entries({
				ai_api_key: "body-key",
				ai_model: "body-model",
				ai_provider: "body-provider",
				ai_token: "body-token",
			})) {
				expect(input?.[key], key).toBe(
					legacyBodyConfig ? value : undefined,
				);
			}
		}
		// Synchronous callbacks may ignore the optional runtime argument.
		if (input) {
			for (const key of Object.keys(untrusted)) {
				if (
					key === "ai_model_pinned" ||
					key === "ai_canonical_model_name"
				) {
					continue;
				}
				expect(input[key], key).not.toBe(
					untrusted[key as keyof typeof untrusted],
				);
			}
		}
	}
	it.each(
		["/a2a/send", "/a2a/send/stream"].flatMap((path) =>
			(["exchange", "headers", "absent", "key-only"] as const).map(
				(source) => ({ path, source }),
			),
		),
	)(
		"protects reserved body metadata on $path ($source)",
		async ({ path, source }) => {
			await request(path, source);
		},
	);
	it.each(
		["/runs/stream", "/threads/example-thread/runs/stream", "/"].flatMap(
			(path) =>
				(["exchange", "absent", "key-only"] as const).flatMap(
					(source) =>
						[false, true].map((platform) => ({
							path,
							source,
							platform,
						})),
				),
		),
	)(
		"protects runtime config on $path ($source, platform=$platform)",
		async ({ path, source, platform }) => {
			await request(path, source, platform);
		},
	);
	it.each(
		[
			"/runs",
			"/threads/example-thread/runs",
			"/run",
			"/invoke",
			"/stream",
		].flatMap((path) =>
			(["exchange", "absent"] as const).flatMap((source) =>
				[true, false].map((withBody) => ({ path, source, withBody })),
			),
		),
	)(
		"protects legacy invoke without exchange on $path ($source, body=$withBody)",
		async ({ path, source, withBody }) => {
			await request(path, source, false, withBody);
		},
	);
});

describe("A2A graph failures", () => {
	beforeEach(() => {
		vi.stubEnv("AGENT_API_KEY", "");
		vi.stubEnv("AGENT_API_KEYS", "");
		vi.stubEnv("AGENT_HMAC_SECRET", "");
	});
	afterEach(() => vi.unstubAllEnvs());
	it.each(["/a2a/send", "/a2a/send/stream"])(
		"fails a transformed graph error on %s",
		async (path) => {
			const { app } = createUnifiedServer(
				{
					name: "example-agent",
					description: "Example",
					baseUrl: "https://example.com",
					port: 3000,
					skills: [],
				},
				async () => ({}),
				() => ({
					response: "unusable",
					error: "Unable to generate an answer",
				}),
			);
			const response = await app.request(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					message: {
						role: "user",
						parts: [{ type: "text", text: "hello" }],
					},
				}),
			});
			expect(response.status).toBe(200);
			const task = path.endsWith("stream")
				? await (async () => {
						const events = await readAgUiEvents(
							new Response(
								(await response.text()).replace(
									"data: [DONE]",
									"",
								),
							),
						);
						expect(events).toContainEqual(
							expect.objectContaining({
								type: "status",
								status: "failed",
							}),
						);
						const taskId = events.find(
							(e) => typeof e.taskId === "string",
						)?.taskId;
						return (
							await app.request(`/a2a/tasks/${taskId}`)
						).json();
					})()
				: (await response.json()).task;
			expect(task.status).toBe("failed");
			expect(task.metadata.error).toBe("Unable to generate an answer");
		},
	);
	it.each(["/a2a/send", "/a2a/send/stream"])(
		"completes usable output on %s",
		async (path) => {
			const { app } = createUnifiedServer(
				{
					name: "example-agent",
					description: "Example",
					baseUrl: "https://example.com",
					port: 3000,
					skills: [],
				},
				async () => ({}),
				() => ({ response: "usable" }),
			);
			const response = await app.request(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					message: {
						role: "user",
						parts: [{ type: "text", text: "hello" }],
					},
				}),
			});
			if (path.endsWith("stream")) {
				expect(
					await readAgUiEvents(
						new Response(
							(await response.text()).replace("data: [DONE]", ""),
						),
					),
				).toContainEqual(
					expect.objectContaining({
						type: "status",
						status: "completed",
					}),
				);
			} else {
				expect((await response.json()).task.status).toBe("completed");
			}
		},
	);
});

it.each(
	["/a2a/send", "/a2a/send/stream"].flatMap((path) => [
		{
			path,
			message: "Provider failed: api_key=example-secret",
			secret: "example-secret",
			expected: "Provider failed: <redacted>",
		},
		{
			path,
			message:
				"Provider failed: Authorization: Bearer example-session-token",
			secret: "example-session-token",
			expected: "Provider failed: <redacted>",
		},
		{
			path,
			message:
				"Provider failed: 401 Incorrect API key sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
			secret: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
			expected: "Provider failed: 401 Incorrect API key <redacted>",
		},
	]),
)(
	"sanitizes transformed failure text on $path ($message)",
	async ({ path, message, secret, expected }) => {
		vi.stubEnv("AGENT_API_KEY", "");
		vi.stubEnv("AGENT_API_KEYS", "");
		vi.stubEnv("AGENT_HMAC_SECRET", "");
		try {
			const { app } = createUnifiedServer(
				{
					name: "example-agent",
					description: "Example",
					baseUrl: "https://example.com",
					port: 3000,
					skills: [],
				},
				async () => ({}),
				() => ({
					response: "",
					error: message,
				}),
			);
			const response = await app.request(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					message: {
						role: "user",
						parts: [{ type: "text", text: "hello" }],
					},
				}),
			});
			let task: { status: string; metadata: { error?: string } };
			if (path.endsWith("stream")) {
				const events = await readAgUiEvents(
					new Response(
						(await response.text()).replace("data: [DONE]", ""),
					),
				);
				expect(JSON.stringify(events)).not.toContain(secret);
				const taskId = events.find(
					(e) => typeof e.taskId === "string",
				)?.taskId;
				task = await (await app.request(`/a2a/tasks/${taskId}`)).json();
			} else {
				task = (await response.json()).task;
			}
			expect(task.status).toBe("failed");
			expect(task.metadata.error).toBe(expected);
		} finally {
			vi.unstubAllEnvs();
		}
	},
);

describe("converted graph messages for CopilotKit", () => {
	it("converter output keeps the human turn and tool-call links through sanitizeStateForCopilotKit", () => {
		const toolCalls = [
			{ id: "call-example", name: "example_tool", args: {} },
		];
		const messages = [
			new HumanMessage({ content: "Plan this.", id: "human-example" }),
			new AIMessage({
				content: "",
				id: "ai-example",
				tool_calls: toolCalls,
			}),
			new ToolMessage({
				content: "Done.",
				id: "tool-example",
				tool_call_id: "call-example",
			}),
		];
		expect(
			sanitizeStateForCopilotKit({
				messages: convertToSimpleMessages(messages),
			}),
		).toEqual({
			messages: [
				{ type: "human", content: "Plan this.", id: "human-example" },
				{
					type: "ai",
					content: "",
					id: "ai-example",
					tool_calls: toolCalls,
				},
				{
					type: "tool",
					content: "Done.",
					id: "tool-example",
					tool_call_id: "call-example",
				},
			],
		});
	});
});

describe("model hint source selection", () => {
	let requestCounter = 0;
	beforeEach(() => {
		modelWireFetch.mockReset();
		vi.stubEnv("AGENT_API_KEY", "");
		vi.stubEnv("AGENT_API_KEYS", "");
		vi.stubEnv("AGENT_HMAC_SECRET", "");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});
	const routes = [
		["/runs/stream", "sync"],
		["/runs/stream", "platform"],
		["/threads/example-thread/runs/stream", "sync"],
		["/threads/example-thread/runs/stream", "platform"],
		["/", "sync"],
		["/", "basic"],
		["/", "platform"],
		["/a2a/send", "sync"],
		["/a2a/send/stream", "sync"],
		["/a2a/send/stream", "basic"],
		["/runs", "sync"],
		["/threads/example-thread/runs", "sync"],
		["/run", "sync"],
		["/invoke", "sync"],
		["/stream", "sync"],
		["/stream", "basic"],
	] as const;
	it.each(
		routes.flatMap(([path, mode]) =>
			[
				"cache-forward",
				"cache-reverse",
				"reasoning-forward",
				"reasoning-reverse",
			].flatMap((direction) =>
				[
					"body-no-hints",
					"body-stale-hints",
					"body-model-less-hints",
					"body-canonical-only",
					"body-reasoning-only",
					"body-hints",
					"exchange-no-body",
					"exchange-same-body",
					"pinned",
					"no-exchange",
				].map((source) => ({ path, mode, direction, source })),
			),
		),
	)(
		"$path ($mode) selects $source hints in $direction",
		async ({ path, mode, direction, source }) => {
			const exchangeIsClaude = direction === "cache-forward";
			const exchangeIsReasoning = direction === "reasoning-forward";
			const exchangeCanonical = exchangeIsClaude
				? "claude-sonnet-5"
				: exchangeIsReasoning
					? "deepseek-r1"
					: "llama-3-3-70b";
			const bodyCanonical =
				direction === "cache-reverse"
					? "claude-sonnet-5"
					: direction === "reasoning-reverse"
						? "deepseek-r1"
						: "llama-3-3-70b";
			const legacy = [
				"/runs",
				"/threads/example-thread/runs",
				"/run",
				"/invoke",
				"/stream",
			].includes(path);
			const credentials = {
				apiKey: "example-key",
				provider: "DATABRICKS",
				model: "exchange-alias",
				canonicalModelName: exchangeCanonical,
				...(source === "pinned" && {
					modelPinned: true,
					isReasoningModel: exchangeIsReasoning,
				}),
				baseUrl: "https://example.com",
				expiresIn: 300,
			};
			const exchange = vi
				.spyOn(
					await import("../src/services/token-exchange"),
					"getAICredentialsFromHeaders",
				)
				.mockResolvedValue(
					source === "no-exchange" ? null : credentials,
				);
			const captured: Array<Record<string, unknown>> = [];
			const invoke = vi.fn(async (input, config) => {
				captured.push(input, config?.configurable ?? {});
				return { response: "done" };
			});
			const { app } = createUnifiedServer(
				{
					name: "example-agent",
					description: "Example",
					baseUrl: "http://localhost:3000",
					port: 3000,
					skills: [],
				},
				invoke,
				() => ({ response: "done" }),
				mode === "basic"
					? async function* (input) {
							captured.push(input);
							yield { type: "text", content: "done" };
						}
					: undefined,
				mode === "platform"
					? async function* (input, config) {
							captured.push(input, config?.configurable ?? {});
							yield {
								nodeName: "end",
								state: {
									messages: [
										{ role: "assistant", content: "done" },
									],
								},
							};
						}
					: undefined,
			);
			const forwarded = {
				...(source !== "exchange-no-body" && {
					ai_model:
						source === "exchange-same-body"
							? credentials.model
							: source === "body-no-hints"
								? bodyCanonical === "claude-sonnet-5"
									? "databricks-claude-sonnet-5"
									: bodyCanonical === "deepseek-r1"
										? "databricks-deepseek-r1"
										: "databricks-llama"
								: source === "body-model-less-hints"
									? "llama-endpoint"
									: "body-alias",
				}),
				ai_provider: "DATABRICKS",
				ai_api_key: "example-key",
				...([
					"body-hints",
					"pinned",
					"no-exchange",
					"exchange-same-body",
				].includes(source) && {
					ai_canonical_model_name: bodyCanonical,
					ai_is_reasoning: direction === "reasoning-reverse",
				}),
				...(source === "body-canonical-only" && {
					ai_canonical_model_name: bodyCanonical,
				}),
				...(source === "body-reasoning-only" && {
					ai_is_reasoning: direction === "reasoning-reverse",
				}),
			};
			const staleOrForwarded =
				source === "body-stale-hints"
					? {
							...forwarded,
							ai_model: "stale-alias",
							ai_canonical_model_name: exchangeCanonical,
							ai_is_reasoning: exchangeIsReasoning,
						}
					: forwarded;
			const messages = [{ role: "user", content: "hello" }];
			const body = path.startsWith("/a2a/")
				? {
						message: {
							role: "user",
							parts: [{ type: "text", text: "hello" }],
						},
						metadata: forwarded,
					}
				: {
						...forwarded,
						messages,
						input: { ...forwarded, messages },
						config: { configurable: staleOrForwarded },
						configurable: staleOrForwarded,
						context:
							source === "body-model-less-hints"
								? {
										ai_canonical_model_name:
											"claude-sonnet-5",
										ai_is_reasoning: true,
									}
								: forwarded,
						properties: forwarded,
						forwardedProps: forwarded,
					};
			const response = await app.request(path, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AI-Token": "example-token",
					"X-AI-Is-Reasoning": "true",
					"X-Real-IP": `192.0.2.${(++requestCounter % 250) + 1}`,
					"X-AI-Base-URL": "https://example.com",
				},
				body: JSON.stringify(body),
			});
			await response.text();
			expect(response.status).toBe(200);
			const selected = captured.filter(
				(record) => record.ai_api_key === "example-key",
			);
			expect(selected.length).toBeGreaterThan(0);
			const exchangeWins =
				!legacy &&
				source !== "no-exchange" &&
				(source === "pinned" ||
					source === "exchange-no-body" ||
					source === "exchange-same-body" ||
					path.startsWith("/a2a/"));
			const canonical = exchangeWins
				? exchangeCanonical
				: forwarded.ai_canonical_model_name;
			const reasoning = exchangeWins
				? exchangeIsReasoning
				: forwarded.ai_is_reasoning;
			const finalModel = exchangeWins
				? credentials.model
				: forwarded.ai_model;
			for (const record of selected) {
				expect(record.ai_model).toBe(finalModel);
				expect(record.ai_canonical_model_name).toBe(canonical);
				expect(record.ai_is_reasoning).toBe(reasoning);
				if (!finalModel) {
					continue;
				}
				modelWireFetch.mockResolvedValueOnce(
					Response.json({
						choices: [
							{
								message: {
									content: "<think>private</think>visible",
								},
							},
						],
					}),
				);
				const providerConfig = extractProviderConfig({
					configurable: record,
				});
				expect(providerConfig).toBeDefined();
				const builder = createProviderModel(
					providerConfig ?? { apiKey: "", model: "" },
				) as unknown as { clientConfig: { fetch: typeof fetch } };
				const wireResponse = await builder.clientConfig.fetch(
					"https://example.com/serving-endpoints/chat/invocations",
					{
						method: "POST",
						body: JSON.stringify({
							model: finalModel,
							messages: [
								{
									role: "system",
									content: "Stable instructions",
								},
								{ role: "user", content: "hello" },
							],
						}),
					},
				);
				const sent = String(
					modelWireFetch.mock.calls.at(-1)?.[1]?.body,
				);
				expect(sent.includes('"cache_control"')).toBe(
					canonical === "claude-sonnet-5" ||
						(canonical === undefined &&
							finalModel === "databricks-claude-sonnet-5"),
				);
				const wire = await wireResponse.json();
				expect(wire.choices[0].message.content).toBe(
					(reasoning ?? finalModel === "databricks-deepseek-r1")
						? "visible"
						: "<think>private</think>visible",
				);
			}
			expect(exchange).toHaveBeenCalledTimes(legacy ? 0 : 1);
		},
	);
});

// Task Planner and Story Breakdown project the boolean directly into the sync
// model builder, without resolving a task model. Exercise that path on CopilotKit props.
describe("opaque CopilotKit reasoning alias (Bug #1942)", () => {
	beforeEach(() => {
		modelWireFetch.mockReset();
		vi.stubEnv("AGENT_API_KEY", "");
		vi.stubEnv("AGENT_API_KEYS", "");
		vi.stubEnv("AGENT_HMAC_SECRET", "");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});
	it.each(["properties", "header"])(
		"strips think tags with Task Planner style construction for prod-chat (%s)",
		async (hintSource) => {
			vi.spyOn(
				await import("../src/services/token-exchange"),
				"getAICredentialsFromHeaders",
			).mockResolvedValue({
				apiKey: "example-key",
				provider: "DATABRICKS",
				model: "other-model",
				canonicalModelName: "llama-3-3-70b",
				baseUrl: "https://example.com",
				expiresIn: 300,
			});
			modelWireFetch.mockResolvedValueOnce(
				Response.json({
					choices: [
						{
							message: {
								content:
									"<think>private reasoning</think>Public answer",
							},
						},
					],
				}),
			);
			let visible: string | undefined;
			const { app } = createUnifiedServer(
				{
					name: "example-planner",
					description: "Example",
					baseUrl: "http://localhost:3000",
					port: 3000,
					skills: [],
				},
				async (_input, runtime) => {
					const configurable = runtime?.configurable ?? {};
					// Same projection as Task Planner's analyze node; no task config API.
					const model = createProviderModel({
						provider: String(configurable.ai_provider),
						apiKey: String(configurable.ai_api_key),
						model: String(configurable.ai_model),
						baseUrl: String(configurable.ai_gateway_url),
						isReasoningModel:
							typeof configurable.ai_is_reasoning === "boolean"
								? configurable.ai_is_reasoning
								: undefined,
					}) as unknown as { clientConfig: { fetch: typeof fetch } };
					const response = await model.clientConfig.fetch(
						"https://example.com",
						{
							method: "POST",
							body: JSON.stringify({
								model: "prod-chat",
								messages: [
									{ role: "user", content: "Plan this" },
								],
							}),
						},
					);
					visible = (await response.json()).choices[0].message
						.content;
					return { response: visible };
				},
				(output) => ({ response: String(output.response) }),
			);
			const response = await app.request("/runs/stream", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AI-Token": "example-token",
					"X-AI-Model": "prod-chat",
					...(hintSource === "header" && {
						"X-AI-Is-Reasoning": "true",
					}),
					"X-Real-IP": "192.0.2.194",
				},
				body: JSON.stringify({
					input: {
						messages: [{ role: "user", content: "Plan this" }],
					},
					properties: {
						ai_api_key: "example-key",
						ai_provider: "DATABRICKS",
						ai_model: "prod-chat",
						...(hintSource === "properties" && {
							ai_is_reasoning: true,
						}),
						ai_canonical_model_name: "deepseek-r1",
					},
				}),
			});
			await response.text();
			expect(response.status).toBe(200);
			expect(visible).toBe("Public answer");
		},
	);
});

describe("executor input credential boundary", () => {
	beforeEach(() => {
		vi.stubEnv("AGENT_API_KEY", "");
		vi.stubEnv("AGENT_API_KEYS", "");
		vi.stubEnv("AGENT_HMAC_SECRET", "");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});
	const cases = [
		{ path: "/runs/stream", mode: "platform", pinned: false },
		{ path: "/runs/stream", mode: "sync", pinned: false },
		{
			path: "/threads/example-thread/runs/stream",
			mode: "platform",
			pinned: false,
		},
		{
			path: "/threads/example-thread/runs/stream",
			mode: "sync",
			pinned: false,
		},
		{ path: "/", mode: "platform", pinned: false },
		{ path: "/", mode: "basic", pinned: false },
		{ path: "/", mode: "sync", pinned: false },
		{ path: "/runs/stream", mode: "platform", pinned: true },
		{
			path: "/threads/example-thread/runs/stream",
			mode: "platform",
			pinned: true,
		},
		{ path: "/", mode: "platform", pinned: true },
	];
	it.each(cases)(
		"keeps the exchanged key out of executor input on $path ($mode, pinned=$pinned)",
		async ({ path, mode, pinned }) => {
			vi.spyOn(
				await import("../src/services/token-exchange"),
				"getAICredentialsFromHeaders",
			).mockResolvedValue({
				apiKey: "example-decrypted-key",
				provider: "DATABRICKS",
				model: "prod-chat",
				canonicalModelName: "deepseek-r1",
				baseUrl: "https://example.com",
				expiresIn: 300,
				...(pinned && { modelPinned: true, isReasoningModel: true }),
			});
			let executorInput: Record<string, unknown> | undefined;
			let runtime: Record<string, unknown> | undefined;
			const { app } = createUnifiedServer(
				{
					name: "example-secret-boundary",
					description: "Example",
					baseUrl: "http://localhost:3000",
					port: 3000,
					skills: [],
				},
				async (input, config) => {
					executorInput = input;
					runtime = config?.configurable;
					return { response: "done" };
				},
				() => ({ response: "done" }),
				mode === "basic"
					? async function* (input) {
							executorInput = input;
							yield { type: "text", content: "done" };
						}
					: undefined,
				mode === "platform"
					? async function* (input, config) {
							executorInput = input;
							runtime = config?.configurable;
							yield {
								nodeName: "end",
								state: {
									messages: [
										{ role: "assistant", content: "done" },
									],
								},
							};
						}
					: undefined,
			);
			const messages = [{ role: "user", content: "hello" }];
			const response = await app.request(path, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AI-Token": "example-server-token",
					"X-Real-IP": "192.0.2.250",
				},
				body: JSON.stringify({
					messages,
					input: { messages },
					config: {
						configurable: {
							runtime_only_secret: "example-runtime-secret",
						},
					},
				}),
			});
			await response.text();
			expect(response.status).toBe(200);
			expect(executorInput).toBeDefined();
			expect(executorInput).not.toHaveProperty("ai_api_key");
			expect(JSON.stringify(executorInput)).not.toContain(
				"example-decrypted-key",
			);
			expect(executorInput).not.toHaveProperty("runtime_only_secret");
			expect(executorInput).toMatchObject({
				ai_model: "prod-chat",
				ai_canonical_model_name: "deepseek-r1",
				ai_is_reasoning: true,
			});
			if (mode === "platform") {
				// ad8539063 platform inputs had body fields rather than transport secrets.
				expect(executorInput).not.toHaveProperty("ai_token");
			} else {
				expect(executorInput?.ai_token).toBe("example-server-token");
			}
			if (mode !== "basic") {
				expect(runtime?.ai_api_key).toBe("example-decrypted-key");
				expect(runtime?.runtime_only_secret).toBe(
					"example-runtime-secret",
				);
			}
		},
	);
});
