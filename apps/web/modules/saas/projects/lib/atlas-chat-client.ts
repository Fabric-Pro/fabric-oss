import { EventType } from "@ag-ui/client";
import type { AtlasChatTurnNote } from "@repo/api/modules/atlas/chat-turn";
import { collectRequestReplyRun } from "@saas/agents/lib/request-reply-outcome";
import {
	ATLAS_CHAT_AGENT_ID,
	type AtlasChatProps,
	atlasChatNoteOfEvent,
} from "./atlas-chat-runtime-protocol";

/**
 * One Atlas chat turn, over either transport the panel picks
 * (`COPILOTKIT_ATLAS_CHAT`): `atlas.chat`'s event iterator, or the agent
 * runtime's `atlas-chat` agent. Both hand the panel the same two things: the
 * answer's text as it streams, and at most one terminal sentinel. The
 * runtime turn is only ever ended by aborting its request, never by the
 * runtime's `stop`: the engine takes a closed response as the stop.
 */

/**
 * The terminal sentinel a turn may end with:
 *  - "atlas-chat-interrupted": the reply was cut short (provider error,
 *    disconnect) and salvaged server-side as interrupted;
 *  - "atlas-chat-persist-failed": the turn finished but could not be saved.
 */
type ChatStreamSentinel = `atlas-chat-${AtlasChatTurnNote}`;

/**
 * The sentinel an `atlas.chat` event carries. Text deltas are plain strings,
 * so any object event is already out-of-band; the `type` check keeps it
 * precise (unknown objects are ignored).
 */
function chatStreamSentinelOf(value: unknown): ChatStreamSentinel | null {
	if (typeof value !== "object" || value === null || !("type" in value)) {
		return null;
	}
	return value.type === "atlas-chat-interrupted" ||
		value.type === "atlas-chat-persist-failed"
		? value.type
		: null;
}

/** Where a turn's stream goes. */
export interface AtlasChatSink {
	onDelta: (delta: string) => void;
	onSentinel: (sentinel: ChatStreamSentinel) => void;
}

/** `atlas.chat`'s event iterator, until it ends or `signal` aborts. */
export async function consumeAtlasRouteStream(
	iterator: AsyncIterable<unknown>,
	signal: AbortSignal,
	sink: AtlasChatSink,
): Promise<void> {
	for await (const event of iterator) {
		if (signal.aborted) {
			break;
		}
		if (typeof event === "string") {
			sink.onDelta(event);
			continue;
		}
		const sentinel = chatStreamSentinelOf(event);
		if (sentinel) {
			sink.onSentinel(sentinel);
		}
	}
}

/**
 * The agent runtime's `atlas-chat` agent, on the conversation `conversationId`
 * names. Rejects with the message the panel shows: the run's error, the
 * endpoint's own refusal, or a lost reply; an `AbortError` once the panel let
 * go of the turn.
 */
export async function streamAtlasRuntime(
	turn: {
		conversationId: string;
		/** The organization on screen, which the runtime request runs in. */
		organizationId: string | undefined;
		props: AtlasChatProps;
		messages: ReadonlyArray<{
			role: "user" | "assistant";
			content: string;
		}>;
		signal: AbortSignal;
	},
	sink: AtlasChatSink,
): Promise<void> {
	await collectRequestReplyRun({
		agentId: ATLAS_CHAT_AGENT_ID,
		threadId: turn.conversationId,
		messages: turn.messages,
		forwardedProps: turn.props,
		organizationId: turn.organizationId,
		signal: turn.signal,
		onEvent: (event) => {
			if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
				sink.onDelta(event.delta);
			} else if (event.type === EventType.CUSTOM) {
				const note = atlasChatNoteOfEvent(event.name);
				if (note) {
					sink.onSentinel(`atlas-chat-${note}`);
				}
			}
		},
	});
}
