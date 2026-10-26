import type { orpcClient } from "@shared/lib/orpc-client";

export type ParlumeSession = Awaited<
	ReturnType<typeof orpcClient.projects.parlume.listSessions>
>["sessions"][number];

export type ParlumeUsage = Awaited<
	ReturnType<typeof orpcClient.projects.parlume.usage>
>;

export type ParlumeRequest = Awaited<
	ReturnType<typeof orpcClient.projects.parlume.history>
>["items"][number];

export type ParlumeAction = ParlumeRequest["actions"][number];

export type ParlumeAgent = Awaited<
	ReturnType<typeof orpcClient.projects.parlume.listAgents>
>["agents"][number];

export type ParlumeReadiness = Awaited<
	ReturnType<typeof orpcClient.projects.parlume.listAgents>
>["readiness"];

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
	return toolsReadOnly ? "Read-only" : "Actions";
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
		case "NOT_ADMITTED":
			return "Not admitted from the lobby";
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

const USD_FORMAT = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

const MICRO_USD_PER_CENT = 10_000;

export function formatClock(value: Date | string): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(value));
}

export function formatShortDate(value: Date | string): string {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
	}).format(new Date(value));
}

/** 28:14, or 1:02:09 once the meeting passes an hour. */
export function formatElapsed(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const pad = (value: number) => String(value).padStart(2, "0");
	return hours > 0
		? `${hours}:${pad(minutes)}:${pad(seconds % 60)}`
		: `${pad(minutes)}:${pad(seconds % 60)}`;
}

/** Up to two initials; "?" when nobody was identified. */
export function initialsOf(name: string | null): string {
	const letters = (name ?? "")
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((word) => word.charAt(0).toUpperCase());
	return letters.length > 0 ? letters.join("") : "?";
}

/** 1 μ$ = $1e-6; shown in cents, with a floor for spend under one cent. */
export function formatCost(costMicroUsd: number): string {
	if (costMicroUsd <= 0) {
		return USD_FORMAT.format(0);
	}
	if (costMicroUsd < MICRO_USD_PER_CENT) {
		return `< ${USD_FORMAT.format(0.01)}`;
	}
	return USD_FORMAT.format(costMicroUsd / 1_000_000);
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
