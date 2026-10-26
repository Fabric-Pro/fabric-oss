import type { orpcClient } from "@shared/lib/orpc-client";
import { PROPOSAL_SOURCE_LABELS } from "../../lib/stories/proposal-source-labels";

export type Range = "7d" | "30d" | "90d" | "all";
export type ReplaySummary = Awaited<
	ReturnType<typeof orpcClient.projects.decisionReplay.getSummary>
>;
export type TimelineEvent = Awaited<
	ReturnType<typeof orpcClient.projects.decisionReplay.getProposalTimeline>
>["events"][number];
export const REPLAY_STALE_TIME = 60_000;
export function isReplayNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "NOT_FOUND"
	);
}
export function duration(seconds: number): string {
	const [value, unit] =
		seconds >= 86400
			? [seconds / 86400, "day"]
			: seconds >= 3600
				? [seconds / 3600, "hour"]
				: seconds >= 60
					? [seconds / 60, "minute"]
					: [seconds, "second"];
	const rounded = Math.round(value * 10) / 10;
	return `${rounded} ${unit}${rounded === 1 ? "" : "s"}`;
}
export function sourceLabel(source: string): string {
	return (
		PROPOSAL_SOURCE_LABELS[source] ??
		source.toLowerCase().replaceAll("_", " ")
	);
}
