import { describe, expect, it } from "vitest";
import { describeReportActivityFailure } from "../lib/report-activity-failure";

// Shaped as Temporal hands a workflow the failure of an activity that gave up.
const activityFailure = (activityType: string, cause: object) =>
	Object.assign(new Error("Activity task failed"), {
		name: "ActivityFailure",
		activityType,
		cause,
	});

describe("describeReportActivityFailure", () => {
	it("names the step and the timeout after a worker restart", () => {
		const message = describeReportActivityFailure(
			activityFailure("executeAgentDataGatheringLoop", {
				name: "TimeoutFailure",
				timeoutType: "HEARTBEAT",
				message: "activity Heartbeat timeout",
			}),
		);

		expect(message).toContain("reading data from the connected tools");
		expect(message).toContain("executeAgentDataGatheringLoop");
		expect(message).toContain("heartbeat timeout");
		expect(message).not.toContain("Activity task");
	});

	it("says a run went past its time limit", () => {
		expect(
			describeReportActivityFailure(
				activityFailure("executeAiAnalysis", {
					name: "TimeoutFailure",
					timeoutType: "START_TO_CLOSE",
				}),
			),
		).toContain("writing the analysis (executeAiAnalysis): it ran past");
	});

	it("carries the cause's message for a failure that is not a timeout", () => {
		expect(
			describeReportActivityFailure(
				activityFailure("executeAgentDataGatheringLoop", {
					name: "ApplicationFailure",
					message: "rate limit exceeded (429)",
				}),
			),
		).toContain(": rate limit exceeded (429)");
	});

	it("redacts a secret in the cause's message", () => {
		const message = describeReportActivityFailure(
			activityFailure("fetchDataSources", {
				name: "ApplicationFailure",
				message: "request failed with token=example-value",
			}),
		);

		expect(message).not.toContain("example-value");
	});

	it("still names an activity it has no plain name for", () => {
		expect(
			describeReportActivityFailure(
				activityFailure("someOtherActivity", {
					name: "TimeoutFailure",
					timeoutType: "SOMETHING_NEW",
				}),
			),
		).toContain("someOtherActivity: its SOMETHING_NEW timeout ran out");
	});

	it("leaves every other error to its own message", () => {
		expect(
			describeReportActivityFailure(new Error("All data sources failed")),
		).toBeNull();
		expect(describeReportActivityFailure(null)).toBeNull();
		expect(describeReportActivityFailure("text")).toBeNull();
	});
});
