import {
	endReasonLabel,
	type ParlumeAction,
	type ParlumeRequest,
	type ParlumeSession,
	statusLabel,
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

const ACTION_TONES: Record<ParlumeAction["status"], Tone> = {
	PROPOSED: "warn",
	AWAITING_CONFIRMATION: "warn",
	EXECUTING: "warn",
	COMPLETED: "good",
	FAILED: "bad",
	OUTCOME_UNKNOWN: "warn",
	CANCELLED: "neutral",
	EXPIRED: "neutral",
	INVALIDATED: "neutral",
};

export function actionStatus(action: ParlumeAction): {
	label: string;
	tone: Tone;
} {
	return {
		label: statusLabel(action.status),
		tone: ACTION_TONES[action.status],
	};
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
			tone: ACTION_TONES[action.status],
		});
	}
	return steps;
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
