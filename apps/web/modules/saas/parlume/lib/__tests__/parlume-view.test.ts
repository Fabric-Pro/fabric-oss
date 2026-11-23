import { describe, expect, it } from "vitest";
import { action, request } from "../../components/__tests__/fixtures";
import { formatElapsed, initialsOf } from "../parlume-format";
import {
	actionDecision,
	actionResult,
	actionStatus,
	actionSteps,
	joinStepIndex,
	joinTitle,
	lobbyDeadline,
	matchesKind,
	requestStateLabel,
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

	it("stops waiting in the lobby five minutes after the invite", () => {
		expect(
			lobbyDeadline({ createdAt: new Date("2026-11-21T10:00:00Z") }),
		).toEqual(new Date("2026-11-21T10:05:00Z"));
	});
});

describe("action status", () => {
	it.each([
		["COMPLETED", "Completed", "good"],
		["FAILED", "Failed", "bad"],
		["OUTCOME_UNKNOWN", "Outcome unknown", "warn"],
		["EXECUTING", "Executing", "warn"],
		["CANCELLED", "Dismissed", "neutral"],
		["PROPOSED", "Proposed", "warn"],
		["EXPIRED", "Expired", "neutral"],
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

describe("actionDecision", () => {
	it("leaves an open proposal undecided", () => {
		expect(
			actionDecision({ status: "PROPOSED", decidedByName: null }),
		).toBeNull();
	});

	it("names the member who confirmed or dismissed the change", () => {
		expect(
			actionDecision({ status: "COMPLETED", decidedByName: "Maya" }),
		).toBe("Maya confirmed this change, and Fabric made it.");
		expect(
			actionDecision({ status: "CANCELLED", decidedByName: "Maya" }),
		).toBe("Maya dismissed this proposal. No change was made.");
	});

	it("says an expired proposal made no change", () => {
		expect(
			actionDecision({ status: "EXPIRED", decidedByName: null }),
		).toMatch(/expired, and no change was made/);
	});
});

describe("actionResult", () => {
	const origin = "https://fabric.example.com";
	const made = (outcome: string) => ({
		status: "COMPLETED" as const,
		outcome,
	});

	it("names the item a Fabric tool returned and keeps only a same-site path", () => {
		expect(
			actionResult(
				made(
					JSON.stringify({
						identifier: "3",
						title: "Export to CSV",
						kind: "FEATURE",
						url: `${origin}/app/example-org/projects/p/stories/s?tab=spec`,
					}),
				),
				origin,
			),
		).toEqual({
			text: "Feature 3 · Export to CSV",
			href: "/app/example-org/projects/p/stories/s?tab=spec",
		});
	});

	it("drops an address on another site, or one that is not a URL", () => {
		for (const url of [
			"https://example.com/x",
			"javascript:alert(1)",
			`${origin}//example.com/x`,
			`${origin}/\\example.com/x`,
			"//example.com/x",
		]) {
			expect(
				actionResult(
					made(JSON.stringify({ title: "Export", url })),
					origin,
				),
			).toEqual({ text: "Export", href: null });
		}
	});

	it("keeps a prefixed identifier as it is", () => {
		expect(
			actionResult(
				made(JSON.stringify({ identifier: "F-231", kind: "FEATURE" })),
				origin,
			),
		).toEqual({ text: "F-231", href: null });
	});

	it("shows a failed change's error, never a made change", () => {
		expect(
			actionResult(
				made(
					JSON.stringify({
						error: "Titles must be unique.",
						title: "Export",
					}),
				),
				origin,
			),
		).toEqual({ text: "Titles must be unique.", href: null });
	});

	it("never names or links an item for a change that was not made", () => {
		const outcome = JSON.stringify({
			success: false,
			identifier: "3",
			title: "Export",
			kind: "FEATURE",
			url: `${origin}/app/example-org/projects/p/stories/s`,
		});
		for (const status of ["FAILED", "OUTCOME_UNKNOWN"] as const) {
			expect(actionResult({ status, outcome }, origin)).toBeNull();
		}
	});

	it("shows a sentence outcome as written, and never raw or cut-short JSON", () => {
		expect(
			actionResult(
				made("Dismissed in Fabric. No change was made."),
				origin,
			),
		).toEqual({
			text: "Dismissed in Fabric. No change was made.",
			href: null,
		});
		expect(
			actionResult(made(JSON.stringify({ ok: true })), origin),
		).toBeNull();
		expect(actionResult(made("[1,2]"), origin)).toBeNull();
		expect(
			actionResult(made('{"identifier":"3","title":"Export to'), origin),
		).toBeNull();
		expect(
			actionResult({ status: "COMPLETED", outcome: null }, origin),
		).toBeNull();
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

describe("requestStateLabel", () => {
	const stopped = (
		stopCause: "VOICE" | "CHAT" | "PAGE" | "PAUSE" | null,
		stoppedBy: string | null = "Dev Example",
	) =>
		requestStateLabel(request({ status: "STOPPED", stopCause, stoppedBy }));

	it("says how a request was stopped and who stopped it", () => {
		expect(stopped("VOICE")).toBe("stopped by voice (Dev Example)");
		expect(stopped("CHAT")).toBe("stopped in the chat (Dev Example)");
		expect(stopped("PAGE")).toBe(
			"stopped on the Parlume page (Dev Example)",
		);
		expect(stopped("PAUSE")).toBe("stopped by a pause (Dev Example)");
	});

	it("leaves out a stopper the meeting did not name, and a cause it did not record", () => {
		expect(stopped("VOICE", null)).toBe("stopped by voice");
		expect(stopped(null)).toBe("stopped");
	});

	it("says nothing for a completed request, and the state of any other", () => {
		expect(requestStateLabel(request())).toBeNull();
		expect(requestStateLabel(request({ status: "FAILED" }))).toBe("failed");
	});
});
