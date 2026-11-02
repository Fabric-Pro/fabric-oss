/**
 * The research runtime hook's test harness: `fetch` faked to answer each
 * runtime route with a scripted SSE event stream (the transport itself is
 * real), the deep-researcher events those streams carry, and the hook
 * rendered with the page's options. A test file mocks the usage-limit toast
 * before importing this module and calls `installRuntimeFetch()`.
 */

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import {
	type UseResearchRunStreamOptions,
	useResearchRuntimeStream,
} from "../useResearchRuntimeStream";

type RuntimeEvent = Record<string, unknown>;

export interface RuntimeRequest {
	url: string;
	signal?: AbortSignal | null;
	headers: Record<string, string>;
	body: {
		threadId: string;
		runId: string;
		messages: Array<{ id: string; role: string; content: string }>;
		forwardedProps?: Record<string, unknown>;
		resume?: Array<Record<string, unknown>>;
	};
}

/** An SSE response whose events can be pushed while the hook reads it. */
export function liveSse() {
	const encoder = new TextEncoder();
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	return {
		response: new Response(stream, {
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		}),
		push: (...events: RuntimeEvent[]) => {
			for (const event of events) {
				controller?.enqueue(
					encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
				);
			}
		},
		close: () => controller?.close(),
	};
}

export function sse(events: RuntimeEvent[]): Response {
	const live = liveSse();
	live.push(...events);
	live.close();
	return live.response;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
	const headers: Record<string, string> = {};
	new Headers(init?.headers).forEach((value, key) => {
		headers[key] = value;
	});
	return headers;
}

/** Every request the hook sent this test, in order. */
export const requests: RuntimeRequest[] = [];

/** How the faked runtime answers a request (`respond` is set per test). */
export const runtime: {
	respond: (request: RuntimeRequest) => Response | Promise<Response>;
} = { respond: () => sse([]) };

/** Fake `fetch` for every test of the file, recording each request. */
export function installRuntimeFetch() {
	beforeEach(() => {
		requests.length = 0;
		runtime.respond = () => sse([]);
		vi.spyOn(global, "fetch").mockImplementation(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request: RuntimeRequest = {
					url: String(input),
					signal: init?.signal,
					headers: headersOf(init),
					body: JSON.parse(String(init?.body ?? "{}")),
				};
				requests.push(request);
				return runtime.respond(request);
			},
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});
}

export const RUN_URL = "/api/agents/runtime/agent/deep-researcher/run";
export const CONNECT_URL = "/api/agents/runtime/agent/deep-researcher/connect";
export const QUESTION = "How did the market change?";
export const EXECUTION = "wf-user-example-1-deep-researcher-example";
export const PROMPT = "Which market should the research cover?";

export const RESULT = {
	status: "completed",
	result: "The full research text.",
	summary: "A short summary.",
	keyFindings: [{ theme: "Growth", findings: ["It grew."], confidence: 80 }],
	sources: ["https://example.com/market"],
	iterations: 1,
	goalAchieved: true,
	duration: 4200,
};

export const started = (
	threadId: string,
	runId: string,
	question = QUESTION,
) => ({
	type: "RUN_STARTED",
	threadId,
	runId,
	input: {
		threadId,
		runId,
		messages: [{ id: `${runId}:user`, role: "user", content: question }],
		tools: [],
		context: [],
	},
});
export const execution = (executionId = EXECUTION) => [
	{ type: "STATE_SNAPSHOT", snapshot: { executionId, progress: null } },
	{
		type: "CUSTOM",
		name: "fabric.deep-researcher.execution",
		value: { executionId, templateSlug: "deep-researcher" },
	},
];
export const progress = (overrides: Record<string, unknown> = {}) => ({
	type: "STATE_SNAPSHOT",
	snapshot: {
		executionId: EXECUTION,
		progress: {
			executionId: EXECUTION,
			phase: "executing_subagents",
			message: "Researching",
			currentIteration: 1,
			maxIterations: 3,
			subAgentsTotal: 2,
			subAgentsCompleted: 1,
			subAgentsFailed: 0,
			goalAchieved: false,
			timestamp: "2026-01-05T10:00:00.000Z",
			...overrides,
		},
	},
});
export const finished = (
	threadId: string,
	runId: string,
	outcome: Record<string, unknown> = { type: "success" },
	result: Record<string, unknown> = RESULT,
) => ({ type: "RUN_FINISHED", threadId, runId, outcome, result });
export const interrupt = (
	threadId: string,
	runId: string,
	key: string,
	expiresAt: string,
) => ({
	type: "RUN_FINISHED",
	threadId,
	runId,
	outcome: {
		type: "interrupt",
		interrupts: [
			{
				id: `${key}:clarification`,
				reason: "research_clarification",
				message: PROMPT,
				expiresAt,
			},
		],
	},
});
export const reconnect = (runId: string) => ({
	type: "CUSTOM",
	name: "fabric.reconnect",
	value: { executionId: EXECUTION, runId },
});
export const runError = (code: string, message: string) => ({
	type: "RUN_ERROR",
	code,
	message,
});
/** A saved, finished run of a conversation, as a connect's snapshot. */
export const savedRun = (key: string, question: string) => ({
	type: "MESSAGES_SNAPSHOT",
	messages: [
		{ id: `${key}:user`, role: "user", content: question },
		{
			id: `${key}:assistant`,
			role: "assistant",
			content: "The report",
			metadata: {
				fabric: {
					timestamp: "2026-01-05T10:00:00.000Z",
					metadata: {
						research: {
							status: "completed",
							executionId: "wf-saved",
							result: RESULT,
						},
					},
				},
			},
		},
	],
});

export function renderResearch(
	options: Partial<UseResearchRunStreamOptions> = {},
) {
	return renderHook(
		(props: UseResearchRunStreamOptions) => useResearchRuntimeStream(props),
		{
			initialProps: {
				templateSlug: "deep-researcher",
				organizationId: "org_example",
				...options,
			},
		},
	);
}

/** The run request's ids (its thread and the run's key). */
export function runIds() {
	const run = requests.find((request) => request.url === RUN_URL);
	if (!run) {
		throw new Error("no run request");
	}
	return { threadId: run.body.threadId, key: run.body.runId };
}
