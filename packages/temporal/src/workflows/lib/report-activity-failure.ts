/**
 * The sentence a report's owner reads when a step of the run gave up. Temporal
 * hands the workflow an `ActivityFailure` whose message is only "Activity task
 * failed" or "Activity task timed out", which says neither what stopped nor why.
 *
 * Runs in the workflow sandbox. Reads the failure by name and fields, as
 * `chatgpt-plan-wait` does, so suites that stub the workflow package still work.
 */

import { redactMessage } from "../../activities/template-instance/mcp-diagnostics";

const STEP_NAMES: Record<string, string> = {
	executeAgentDataGatheringLoop: "reading data from the connected tools",
	fetchDataSources: "fetching the report's data sources",
	executeAiAnalysis: "writing the analysis",
	renderInstanceReport: "rendering the report",
	storeInstanceArtifact: "saving the report",
};

const TIMEOUT_MEANINGS: Record<string, string> = {
	HEARTBEAT:
		"it stopped responding, most likely because its worker restarted, so the heartbeat timeout ran out",
	START_TO_CLOSE: "it ran past its time limit",
	SCHEDULE_TO_START: "no worker picked it up in time",
	SCHEDULE_TO_CLOSE: "it ran past its total time limit",
};

/**
 * Returns null for anything that is not an activity failure, so the caller keeps
 * that error's own message.
 */
export function describeReportActivityFailure(error: unknown): string | null {
	const failure = error as {
		name?: unknown;
		activityType?: unknown;
		cause?: { name?: unknown; timeoutType?: unknown; message?: unknown };
	} | null;
	if (
		failure?.name !== "ActivityFailure" ||
		typeof failure.activityType !== "string"
	) {
		return null;
	}
	const { activityType, cause } = failure;
	const step = STEP_NAMES[activityType];
	const named = step ? `${step} (${activityType})` : activityType;
	if (cause?.name === "TimeoutFailure") {
		const timeoutType = String(cause.timeoutType);
		const meaning =
			TIMEOUT_MEANINGS[timeoutType] ??
			`its ${timeoutType} timeout ran out`;
		return `The report stopped while ${named}: ${meaning}, and its retries were used up.`;
	}
	const detail =
		typeof cause?.message === "string" && cause.message
			? `: ${redactMessage(cause.message)}`
			: ".";
	return `The report stopped while ${named}${detail}`;
}
