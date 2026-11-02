/**
 * One scripted Sidekick reply, produced twice by the real AI SDK: once as the
 * route sends it (`toUIMessageStream`) and `useChat` keeps it
 * (`readUIMessageStream`), and once as the runtime sends it
 * (`streamTextRunEvents`) and an AG-UI agent keeps it. Both sides come from
 * the same model script and tool, so a test can compare what each would
 * send back as history.
 *
 * The default script: step 1 is text and a `suggest_tools` call (with
 * reasoning first when asked), step 2 is text. `interleavedSteps` writes
 * text after a call inside one step; `failedToolSteps` makes a call whose
 * tool throws.
 */
import {
	AbstractAgent,
	type AGUIEvent,
	type BaseEvent,
	EventType,
	type Message,
} from "@ag-ui/client";
import { streamTextRunEvents } from "@saas/agents/runtime/stream-text-events";
import {
	isStepCount,
	readUIMessageStream,
	tool,
	toUIMessageStream,
	type UIMessage,
} from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { from, type Observable } from "rxjs";
import { vi } from "vitest";
import { z } from "zod";
import { sidekickStreamErrorText } from "../../../../app/api/agents/sidekick/stream/stream-error-text";

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
/** One chunk a mock model's stream sends. */
export type ModelChunk = StreamResult["stream"] extends ReadableStream<
	infer Chunk
>
	? Chunk
	: never;

const USAGE = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** One model step: `chunks` between the stream's start and its finish. */
export function modelStep(
	chunks: ModelChunk[],
	finishReason: "stop" | "tool-calls" = "stop",
): StreamResult {
	return {
		stream: simulateReadableStream({
			chunks: [
				{ type: "stream-start", warnings: [] },
				...chunks,
				{
					type: "finish",
					finishReason: { unified: finishReason, raw: undefined },
					usage: USAGE,
				},
			],
		}),
	};
}

export function textChunks(id: string, text: string): ModelChunk[] {
	return [
		{ type: "text-start", id },
		{ type: "text-delta", id, delta: text },
		{ type: "text-end", id },
	];
}

function reasoningChunks(id: string, text: string): ModelChunk[] {
	return [
		{ type: "reasoning-start", id },
		{ type: "reasoning-delta", id, delta: text },
		{ type: "reasoning-end", id },
	];
}

export function toolCallChunk(
	toolCallId: string,
	toolName: string,
	input: unknown,
): ModelChunk {
	return {
		type: "tool-call",
		toolCallId,
		toolName,
		input: JSON.stringify(input),
	};
}

/** Valid `suggest_tools` input: add one tool. */
export const SUGGEST_TOOLS_INPUT = {
	suggestions: [
		{ action: "add", toolId: "web-search", toolName: "Web search" },
	],
};

/** The scripted reply's two model steps. */
export function scriptedSteps({
	reasoning = false,
}: {
	reasoning?: boolean;
} = {}): StreamResult[] {
	return [
		modelStep(
			[
				...(reasoning
					? reasoningChunks("r1", "Weighing the tools first.")
					: []),
				...textChunks("t1", "Adding a tool."),
				toolCallChunk("call-1", "suggest_tools", SUGGEST_TOOLS_INPUT),
			],
			"tool-calls",
		),
		modelStep(textChunks("t2", "Added web search.")),
	];
}

/** Step 1: text, a call, more text and a second call. Step 2: text. */
export function interleavedSteps(): StreamResult[] {
	return [
		modelStep(
			[
				...textChunks("t1", "Adding a tool."),
				toolCallChunk("call-1", "suggest_tools", SUGGEST_TOOLS_INPUT),
				...textChunks("t2", "And removing one."),
				toolCallChunk("call-2", "suggest_tools", {
					suggestions: [
						{
							action: "remove",
							toolId: "calculator",
							toolName: "Calculator",
						},
					],
				}),
			],
			"tool-calls",
		),
		modelStep(textChunks("t3", "Both changed.")),
	];
}

/** A tool `suggest_tools` fails on, as saving a registered agent's suggestions can. */
const FAILING_TOOL_ID = "unsavable-tool";

/** Step 1: text and a `suggest_tools` call that throws. Step 2: text. */
export function failedToolSteps(): StreamResult[] {
	return [
		modelStep(
			[
				...textChunks("t1", "Adding a tool."),
				toolCallChunk("call-1", "suggest_tools", {
					suggestions: [
						{
							action: "add",
							toolId: FAILING_TOOL_ID,
							toolName: "Unsavable",
						},
					],
				}),
			],
			"tool-calls",
		),
		modelStep(textChunks("t2", "That did not work.")),
	];
}

/** A `suggest_tools`-shaped tool answering as the new-agent path does. */
const suggestTools = tool({
	inputSchema: z.object({
		suggestions: z.array(
			z.object({
				action: z.enum(["add", "remove"]),
				toolId: z.string(),
				toolName: z.string(),
			}),
		),
	}),
	execute: async ({ suggestions }) => {
		if (suggestions.some(({ toolId }) => toolId === FAILING_TOOL_ID)) {
			throw new Error("Could not save the suggestions.");
		}
		return `<sidekick_apply_tools>\n${JSON.stringify(suggestions)}\n</sidekick_apply_tools>\n\nSuggested tool changes.`;
	},
});

const USER_TEXT = "Help me improve this agent";
const THREAD = "thread-example-0001";
const RUN = "run-example-0001";

async function scriptedRun(steps: () => StreamResult[]) {
	// The real `streamText`, as both transports call it.
	const { streamText } = await vi.importActual<typeof import("ai")>("ai");
	return streamText({
		model: new MockLanguageModelV4({ doStream: steps() }),
		messages: [{ role: "user", content: USER_TEXT }],
		tools: { suggest_tools: suggestTools },
		stopWhen: isStepCount(5),
	});
}

/** An AG-UI agent that applies one recorded run. */
class ReplayAgent extends AbstractAgent {
	constructor(
		private readonly events: BaseEvent[],
		initialMessages: Message[],
	) {
		super({ threadId: THREAD, initialMessages });
	}

	run(): Observable<BaseEvent> {
		return from(this.events);
	}
}

export interface ScriptedReply {
	/** What `useChat` holds after the route's reply: the question, then the reply. */
	reference: UIMessage[];
	/** What the runtime's AG-UI agent holds after the same reply. */
	agUi: Message[];
}

/** The reply `steps` script, as each transport keeps it (`scriptedSteps` by default). */
export async function scriptedReply(
	steps: () => StreamResult[] = scriptedSteps,
): Promise<ScriptedReply> {
	const routeRun = await scriptedRun(steps);
	let reply: UIMessage | undefined;
	for await (const message of readUIMessageStream({
		stream: toUIMessageStream({
			stream: routeRun.stream,
			onError: sidekickStreamErrorText,
		}),
	})) {
		reply = message;
	}
	if (!reply) {
		throw new Error("The route's stream carried no reply.");
	}

	const runtimeRun = await scriptedRun(steps);
	const events: AGUIEvent[] = [
		{ type: EventType.RUN_STARTED, threadId: THREAD, runId: RUN },
	];
	for await (const event of streamTextRunEvents(runtimeRun.stream, {
		runId: RUN,
		toolErrorText: sidekickStreamErrorText,
	})) {
		events.push(event);
	}
	events.push({ type: EventType.RUN_FINISHED, threadId: THREAD, runId: RUN });
	const agent = new ReplayAgent(events, [
		{ id: "user-1", role: "user", content: USER_TEXT },
	]);
	await agent.runAgent();

	return {
		reference: [
			{
				id: "user-1",
				role: "user",
				parts: [{ type: "text", text: USER_TEXT }],
			},
			reply,
		],
		agUi: agent.messages,
	};
}
