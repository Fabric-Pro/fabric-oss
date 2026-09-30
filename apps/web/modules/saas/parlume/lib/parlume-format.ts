import type { orpcClient } from "@shared/lib/orpc-client";

export type ParlumeSession = Awaited<
	ReturnType<typeof orpcClient.projects.parlume.listSessions>
>["sessions"][number];

export type ParlumeUsage = Awaited<
	ReturnType<typeof orpcClient.projects.parlume.usage>
>;

const LIVE_STATUSES: ReadonlySet<string> = new Set([
	"PENDING",
	"JOINING",
	"ACTIVE",
	"LEAVING",
	"STOP_FAILED",
]);

export function isLiveSession(session: Pick<ParlumeSession, "status">) {
	return LIVE_STATUSES.has(session.status);
}

export function modeLabel(toolsReadOnly: boolean): string {
	return toolsReadOnly ? "Read-only" : "Actions with confirmation";
}

export function statusLabel(status: string): string {
	const text = status.toLowerCase().replaceAll("_", " ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export function endReasonLabel(endReason: string | null): string | null {
	switch (endReason) {
		case null:
			return null;
		case "STOPPED":
			return "Stopped by admin";
		case "REMOVED":
			return "Removed from meeting";
		case "IDLE":
			return "Ended after 3 min of silence";
		case "ACCESS_REVOKED":
			return "Inviter lost access";
		case "STREAM_ERROR":
			return "Transcription failed";
		case "MAX_DURATION":
			return "Reached 4-hour limit";
		case "PROVIDER_FAILED":
			return "Provider failed";
		case "START_FAILED":
			return "Never joined";
		default:
			return statusLabel(endReason);
	}
}

export function formatTimestamp(value: Date | string): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}

/** 1 μ$ = $1e-6; four decimals keep single meeting turns visible. */
export function formatCost(costMicroUsd: number): string {
	return `$${(costMicroUsd / 1_000_000).toFixed(4)}`;
}

export function formatDuration(
	start: Date | string | null,
	end: Date | string | number,
): string {
	if (!start) {
		return "—";
	}
	const seconds = Math.max(
		0,
		Math.floor(
			(new Date(end).getTime() - new Date(start).getTime()) / 1000,
		),
	);
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) {
		return `${hours} h ${minutes} min`;
	}
	return minutes > 0 ? `${minutes} min` : `${seconds} s`;
}
