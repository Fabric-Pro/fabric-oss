import { PARLUME_LOBBY_WAIT_SECONDS } from "@repo/api/modules/projects/lib/parlume-lobby";
import {
	endReasonLabel,
	type ParlumeAction,
	type ParlumeRequest,
	type ParlumeSession,
} from "./parlume-format";

export type Tone = "good" | "bad" | "warn" | "neutral";

export const TONE_DOT: Record<Tone, string> = {
	good: "bg-success",
	bad: "bg-destructive",
	warn: "bg-highlight",
	neutral: "bg-muted-foreground",
};

export const TONE_TEXT: Record<Tone, string> = {
	good: "text-success",
	bad: "text-destructive",
	warn: "text-highlight-ink",
	neutral: "text-muted-foreground",
};

export const TONE_BADGE: Record<
	Tone,
	"success" | "error" | "warning" | "info"
> = {
	good: "success",
	bad: "error",
	warn: "warning",
	neutral: "info",
};

function assertNever(value: never): never {
	throw new Error(`Unsupported Parlume value: ${value}`);
}

/** What the Outcome column says about a session, live or finished. */
export function sessionOutcome(
	session: Pick<ParlumeSession, "status" | "endReason">,
): { label: string; tone: Tone } {
	switch (session.status) {
		case "PENDING":
		case "JOINING":
			return { label: "Joining", tone: "warn" };
		case "ACTIVE":
			return { label: "In meeting", tone: "good" };
		case "LEAVING":
			return { label: "Leaving", tone: "warn" };
		case "STOP_FAILED":
			return { label: "Stop failed", tone: "bad" };
		case "FINALIZING":
			return { label: "Saving transcript", tone: "neutral" };
		case "FAILED":
			return {
				label: endReasonLabel(session.endReason) ?? "Failed",
				tone: "bad",
			};
		case "ENDED":
			return {
				label: endReasonLabel(session.endReason) ?? "Ended",
				tone: "neutral",
			};
		default:
			return assertNever(session.status);
	}
}

export const JOIN_STEPS = [
	"Invite sent",
	"Waiting in lobby",
	"Listening",
] as const;

/**
 * Which of the join steps a bot that has not started listening is on. The
 * provider reports the lobby only as the time between the invite and the
 * first audio, so everything after the invite is "waiting".
 */
export function joinStepIndex(session: Pick<ParlumeSession, "status">): number {
	return session.status === "PENDING" ? 0 : 1;
}

export function joinTitle(session: Pick<ParlumeSession, "status">): string {
	switch (session.status) {
		case "PENDING":
			return "Sending the invite…";
		case "LEAVING":
			return "Leaving the meeting…";
		default:
			return "Waiting in the lobby…";
	}
}

/**
 * About when the bot stops waiting in the lobby. The provider's wait starts
 * when the bot reaches the lobby, shortly after the invite.
 */
export function lobbyDeadline(
	session: Pick<ParlumeSession, "createdAt">,
): Date {
	return new Date(
		new Date(session.createdAt).getTime() +
			PARLUME_LOBBY_WAIT_SECONDS * 1000,
	);
}

// Only a member's Dismiss sets CANCELLED, so it reads as "Dismissed".
const ACTION_STATUSES: Record<
	ParlumeAction["status"],
	{ label: string; tone: Tone }
> = {
	PROPOSED: { label: "Proposed", tone: "warn" },
	AWAITING_CONFIRMATION: { label: "Awaiting confirmation", tone: "warn" },
	EXECUTING: { label: "Executing", tone: "warn" },
	COMPLETED: { label: "Completed", tone: "good" },
	FAILED: { label: "Failed", tone: "bad" },
	OUTCOME_UNKNOWN: { label: "Outcome unknown", tone: "warn" },
	CANCELLED: { label: "Dismissed", tone: "neutral" },
	EXPIRED: { label: "Expired", tone: "neutral" },
	INVALIDATED: { label: "Invalidated", tone: "neutral" },
};

export function actionStatus(action: Pick<ParlumeAction, "status">): {
	label: string;
	tone: Tone;
} {
	return ACTION_STATUSES[action.status];
}

export interface ActionStep {
	label: string;
	at: Date | string;
	tone: Tone;
}

export function actionSteps(action: ParlumeAction): ActionStep[] {
	const steps: ActionStep[] = [
		{ label: "Requested", at: action.createdAt, tone: "neutral" },
	];
	if (action.completedAt) {
		steps.push({
			label: action.status === "FAILED" ? "Failed" : "Finished",
			at: action.completedAt,
			tone: ACTION_STATUSES[action.status].tone,
		});
	}
	return steps;
}

/**
 * What the action page says about a proposal that can no longer be confirmed
 * or dismissed, naming the member who decided it. Null while it is open.
 */
export function actionDecision(
	action: Pick<ParlumeAction, "status"> & { decidedByName: string | null },
): string | null {
	const member = action.decidedByName ?? "A project member";
	switch (action.status) {
		case "PROPOSED":
			return null;
		case "EXECUTING":
			return `${member} confirmed this change. Fabric is making it now.`;
		case "COMPLETED":
			return `${member} confirmed this change, and Fabric made it.`;
		case "FAILED":
			return `${member} confirmed this change, but Fabric could not make it.`;
		case "OUTCOME_UNKNOWN":
			return `${member} confirmed this change, but Fabric cannot tell whether it was made. Check the project before you ask again.`;
		case "CANCELLED":
			return action.decidedByName
				? `${action.decidedByName} dismissed this proposal. No change was made.`
				: "This proposal was dismissed. No change was made.";
		case "EXPIRED":
			return "This proposal has expired, and no change was made. Ask Parlume again in the meeting.";
		case "AWAITING_CONFIRMATION":
		case "INVALIDATED":
			return "This proposal can no longer be confirmed. No change was made.";
		default:
			return assertNever(action.status);
	}
}

function resultField(result: object, key: string): string | null {
	const value: unknown = Reflect.get(result, key);
	return typeof value === "string" && value.trim() !== ""
		? value.trim()
		: null;
}

function sameSitePath(url: string | null, origin: string): string | null {
	if (!url) {
		return null;
	}
	try {
		const parsed = new URL(url, origin);
		// "//host/…" is a path to the URL parser but another site to a link.
		return parsed.origin === origin && !parsed.pathname.startsWith("//")
			? `${parsed.pathname}${parsed.search}${parsed.hash}`
			: null;
	} catch {
		return null;
	}
}

/**
 * What a finished change's recorded outcome says on the action page. A Fabric
 * tool records its result as JSON: the page shows its error, or, for a change
 * that was made, names the item it touched and links to it only when the
 * address is on this site. Other JSON, and JSON cut short when it was stored,
 * show nothing; the decision line already says what happened. Any other
 * outcome is a sentence and is shown as written.
 */
export function actionResult(
	action: Pick<ParlumeAction, "status" | "outcome">,
	origin: string,
): { text: string; href: string | null } | null {
	const outcome = action.outcome?.trim();
	if (!outcome) {
		return null;
	}
	let result: unknown;
	try {
		result = JSON.parse(outcome);
	} catch {
		return /^[[{]/.test(outcome) ? null : { text: outcome, href: null };
	}
	if (
		typeof result !== "object" ||
		result === null ||
		Array.isArray(result)
	) {
		return null;
	}
	const problem =
		resultField(result, "error") ?? resultField(result, "message");
	if (problem) {
		return { text: problem, href: null };
	}
	if (action.status !== "COMPLETED") {
		return null;
	}
	const kind = resultField(result, "kind")?.toLowerCase() ?? null;
	const identifier = resultField(result, "identifier");
	const item = [
		// A plain-number identifier reads with its kind; F-231 reads as it is.
		kind && identifier && /^\d+$/.test(identifier)
			? `${kind.charAt(0).toUpperCase()}${kind.slice(1)} ${identifier}`
			: identifier,
		resultField(result, "title"),
	]
		.filter(Boolean)
		.join(" · ");
	return item
		? { text: item, href: sameSitePath(resultField(result, "url"), origin) }
		: null;
}

/**
 * Where a suggestion's or a proposal's post went, as the bridge saw it: the
 * meeting chat showed it back, it did not within the confirmation window,
 * or no report has come yet (and none came before reports were stored).
 */
export function chatPostLabel(
	tag: string,
	delivery: "SHOWN" | "NOT_SHOWN" | null,
): string {
	switch (delivery) {
		case "SHOWN":
			return `Posted as ${tag}`;
		case "NOT_SHOWN":
			return `Not shown in the chat (${tag})`;
		case null:
			return `Sent to the chat as ${tag}`;
		default:
			return assertNever(delivery);
	}
}

/** A proposed change's label, with where its post went once that is known. */
export function actionTagLabel(
	action: Pick<ParlumeAction, "chatTag" | "chatDelivery">,
): string {
	if (!action.chatTag) {
		return "Action";
	}
	return action.chatDelivery
		? `Action · ${chatPostLabel(action.chatTag, action.chatDelivery)}`
		: `Action · ${action.chatTag}`;
}

/**
 * Where a request's own posts went: its answer, detail, rest or error line.
 * Null when the chat has reported none.
 */
export function requestPostsLabel(
	request: Pick<ParlumeRequest, "chatTags" | "chatUnshownTags">,
): string | null {
	const shown = request.chatTags.length
		? `Posted as ${request.chatTags.join(", ")}`
		: null;
	const unshown = request.chatUnshownTags.length
		? `Not shown in the chat: ${request.chatUnshownTags.join(", ")}`
		: null;
	return [shown, unshown].filter(Boolean).join(" · ") || null;
}

function stopLabel(cause: NonNullable<ParlumeRequest["stopCause"]>): string {
	switch (cause) {
		case "VOICE":
			return "stopped by voice";
		case "CHAT":
			return "stopped in the chat";
		case "PAGE":
			return "stopped on the Parlume page";
		case "PAUSE":
			return "stopped by a pause";
		default:
			return assertNever(cause);
	}
}

/**
 * The state a request that did not complete shows on its row. A stopped one
 * says how it was stopped and, when the meeting named them, by whom, as the
 * meeting chat's line does.
 */
export function requestStateLabel(
	request: Pick<ParlumeRequest, "status" | "stopCause" | "stoppedBy">,
): string | null {
	if (request.status === "COMPLETED") {
		return null;
	}
	if (request.status !== "STOPPED" || !request.stopCause) {
		return request.status.toLowerCase();
	}
	const by = request.stoppedBy ? ` (${request.stoppedBy})` : "";
	return `${stopLabel(request.stopCause)}${by}`;
}

export type RequestKind = "all" | "question" | "action";

export function matchesKind(
	request: Pick<ParlumeRequest, "actions">,
	kind: RequestKind,
): boolean {
	switch (kind) {
		case "all":
			return true;
		case "action":
			return request.actions.length > 0;
		case "question":
			return request.actions.length === 0;
		default:
			return assertNever(kind);
	}
}
