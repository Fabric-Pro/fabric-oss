import type { ParlumeActionContext } from "./parlume-actions";
import { parlumeActivityLog } from "./parlume-log";
import { postParlumeHeldChange } from "./parlume-voice";

/** The bridge keeps a held request for `go` up to this length. */
const MAX_HELD_REQUEST_CHARS = 2_000;
const MAX_TITLE_CHARS = 80;
const TITLE_KEYS = ["title", "name", "subject", "summary"] as const;

/**
 * The change a tool call would have made, as the verb phrase that follows
 * "I did not": the tool's words in the product's own terms (a story is a
 * feature), and the title it was given when it has one ("create feature
 * “Export to CSV”"). No other argument is shown.
 */
export function heldChangeAction(
	toolName: string,
	args: Record<string, unknown>,
): string {
	const action = toolName
		.replace(/^fabric_/, "")
		.replace(/[_-]+/g, " ")
		.trim()
		.toLowerCase()
		.replace(/\bstor(y|ies)\b/g, (_, ending: string) =>
			ending === "y" ? "feature" : "features",
		);
	const title = TITLE_KEYS.map((key) => args[key]).find(
		(value): value is string =>
			typeof value === "string" && value.trim() !== "",
	);
	if (!title) {
		return action;
	}
	const trimmed = title.trim();
	return `${action} “${trimmed.length > MAX_TITLE_CHARS ? `${trimmed.slice(0, MAX_TITLE_CHARS - 1)}…` : trimmed}”`;
}

/**
 * Someone spoke over Parlume before this change ran, so it is not made.
 * The meeting chat is told, with a `go` handle that asks for it again, and
 * the agent is told it did not happen.
 */
export async function offerHeldChange(
	context: Pick<ParlumeActionContext, "sessionId" | "turnId" | "requestText">,
	toolName: string,
	args: Record<string, unknown>,
) {
	const request = context.requestText.trim();
	const offered =
		request.length > 0 && request.length <= MAX_HELD_REQUEST_CHARS
			? await postParlumeHeldChange({
					sessionId: context.sessionId,
					turnId: context.turnId,
					action: heldChangeAction(toolName, args),
					request,
				})
			: ({ sent: false, reason: "failed" } as const);
	parlumeActivityLog(offered.sent ? "info" : "warn", "action.held", {
		sessionId: context.sessionId,
		turnId: context.turnId,
		toolName,
		offered: offered.sent,
		tag: offered.sent ? offered.tag : null,
	});
	return {
		held: true,
		changed: false,
		instruction: offered.sent
			? `Someone spoke over you before this change ran, so it was not made. The meeting chat was told, and can reply "go ${offered.tag}" to make it. Do not call this tool again in this turn.`
			: "Someone spoke over you before this change ran, so it was not made. Say so in one sentence and ask them to repeat the request if they still want it. Do not call this tool again in this turn.",
	};
}
