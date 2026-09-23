import { heartbeat } from "@temporalio/activity";
import type { ActivityHeartbeatDetails } from "../../types";

/**
 * Keeps the Direct chat activity alive between stream parts.
 *
 * The activity's only heartbeats used to come from inside the model-stream
 * loop. A slow MCP tool (its own ceiling is 60 s), a long reasoning step with
 * no deltas, or slow setup before the stream starts all went quiet for longer
 * than the workflow's 30 s `heartbeatTimeout`. Temporal then timed the
 * attempt out and re-ran the whole agentic loop — every tool call, writes
 * included — up to three times (Fizzy #2040, review F23). The Orchestrator
 * solved the same problem with a background ticker; this is Direct's.
 *
 * The ticker re-sends the latest full snapshot rather than a bare phase: the
 * stream route treats the most recent heartbeat's details as the turn's
 * state, so a detail-less beat would read as the text and tool cards
 * disappearing.
 */

export const DIRECT_CHAT_BACKGROUND_HEARTBEAT_MS = 10_000;

export interface BackgroundHeartbeat {
	/** Point the ticker at the live state of the turn once it exists. */
	track: (snapshot: () => ActivityHeartbeatDetails) => void;
	stop: () => void;
}

export function startBackgroundHeartbeat(
	initial: ActivityHeartbeatDetails,
	beat: (details: ActivityHeartbeatDetails) => void = heartbeat,
	intervalMs = DIRECT_CHAT_BACKGROUND_HEARTBEAT_MS,
): BackgroundHeartbeat {
	let snapshot = () => initial;
	const timer = setInterval(() => {
		try {
			beat({ ...snapshot(), timestamp: Date.now() });
		} catch {
			// `heartbeat` throws outside an activity context; nothing to do.
		}
	}, intervalMs);
	return {
		track: (next) => {
			snapshot = next;
		},
		stop: () => clearInterval(timer),
	};
}
