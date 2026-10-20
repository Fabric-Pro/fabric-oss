import { describe, expect, it } from "vitest";
import { action, request } from "../../components/__tests__/fixtures";
import { formatElapsed, initialsOf } from "../parlume-format";
import {
	actionStatus,
	actionSteps,
	joinStepIndex,
	joinTitle,
	matchesKind,
	sessionOutcome,
} from "../parlume-view";

describe("formatElapsed", () => {
	it("pads minutes and seconds", () => {
		expect(formatElapsed(0)).toBe("00:00");
		expect(formatElapsed(9_000)).toBe("00:09");
		expect(formatElapsed((28 * 60 + 14) * 1000)).toBe("28:14");
	});

	it("adds the hour from sixty minutes", () => {
		expect(formatElapsed(3_599_000)).toBe("59:59");
		expect(formatElapsed(3_600_000)).toBe("1:00:00");
		expect(formatElapsed((2 * 3600 + 5 * 60 + 7) * 1000)).toBe("2:05:07");
	});

	it("never goes below zero when the clocks disagree", () => {
		expect(formatElapsed(-5_000)).toBe("00:00");
	});
});

describe("initialsOf", () => {
	it("takes up to two initials", () => {
		expect(initialsOf("Attendee One")).toBe("AO");
		expect(initialsOf("attendee")).toBe("A");
		expect(initialsOf("Attendee Van Two")).toBe("AV");
	});

	it("falls back to a question mark when nobody was identified", () => {
		expect(initialsOf(null)).toBe("?");
		expect(initialsOf("   ")).toBe("?");
	});
});

describe("sessionOutcome", () => {
	it("describes a session that is still going", () => {
		expect(sessionOutcome({ status: "PENDING", endReason: null })).toEqual({
			label: "Joining",
			tone: "warn",
		});
		expect(
			sessionOutcome({ status: "JOINING", endReason: null }).label,
		).toBe("Joining");
		expect(sessionOutcome({ status: "ACTIVE", endReason: null })).toEqual({
			label: "In meeting",
			tone: "good",
		});
		expect(
			sessionOutcome({ status: "LEAVING", endReason: null }).tone,
		).toBe("warn");
		expect(
			sessionOutcome({ status: "STOP_FAILED", endReason: null }),
		).toEqual({ label: "Stop failed", tone: "bad" });
	});

	it("gives a finished session the reason it ended, or a plain word", () => {
		expect(
			sessionOutcome({ status: "ENDED", endReason: "STOPPED" }),
		).toEqual({ label: "Stopped by admin", tone: "neutral" });
		expect(sessionOutcome({ status: "ENDED", endReason: null }).label).toBe(
			"Ended",
		);
		expect(
			sessionOutcome({ status: "FAILED", endReason: "START_FAILED" }),
		).toEqual({ label: "Never joined", tone: "bad" });
		expect(
			sessionOutcome({ status: "FAILED", endReason: null }).label,
		).toBe("Failed");
		expect(
			sessionOutcome({ status: "FINALIZING", endReason: null }).label,
		).toBe("Saving transcript");
	});
});

describe("join progress", () => {
	it("is on the invite until the provider has one, then in the lobby", () => {
		expect(joinStepIndex({ status: "PENDING" })).toBe(0);
		expect(joinStepIndex({ status: "JOINING" })).toBe(1);
		expect(joinTitle({ status: "PENDING" })).toBe("Sending the invite…");
		expect(joinTitle({ status: "JOINING" })).toBe("Waiting in the lobby…");
		expect(joinTitle({ status: "LEAVING" })).toBe("Leaving the meeting…");
	});
});

describe("action status", () => {
	it.each([
		["COMPLETED", "Completed", "good"],
		["FAILED", "Failed", "bad"],
		["OUTCOME_UNKNOWN", "Outcome unknown", "warn"],
		["EXECUTING", "Executing", "warn"],
		["CANCELLED", "Cancelled", "neutral"],
	] as const)("labels %s as %s", (status, label, tone) => {
		expect(actionStatus(action({ status }))).toEqual({ label, tone });
	});
});

describe("actionSteps", () => {
	it("lists requested and finished from the action's own times", () => {
		expect(
			actionSteps(action()).map((step) => [step.label, step.tone]),
		).toEqual([
			["Requested", "neutral"],
			["Finished", "good"],
		]);
	});

	it("calls a failed run failed, not finished", () => {
		const steps = actionSteps(action({ status: "FAILED" }));
		expect(steps.at(-1)).toMatchObject({ label: "Failed", tone: "bad" });
	});

	it("shows only the request while the change is running", () => {
		const steps = actionSteps(
			action({ status: "EXECUTING", completedAt: null }),
		);
		expect(steps.map((step) => step.label)).toEqual(["Requested"]);
	});
});

describe("matchesKind", () => {
	const plain = request({ actions: [] });
	const acting = request({ actions: [action()] });

	it("treats a request with an action as an action, and the rest as questions", () => {
		expect(matchesKind(plain, "question")).toBe(true);
		expect(matchesKind(acting, "question")).toBe(false);
		expect(matchesKind(plain, "action")).toBe(false);
		expect(matchesKind(acting, "action")).toBe(true);
	});

	it("keeps everything under All", () => {
		expect(matchesKind(plain, "all")).toBe(true);
		expect(matchesKind(acting, "all")).toBe(true);
	});
});
