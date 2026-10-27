import { describe, expect, it } from "vitest";
import { describeParlumeProviderFailure } from "../parlume-join-failure";

function couldNotJoin(eventSubType: string | null) {
	return describeParlumeProviderFailure({
		eventType: "could_not_join_meeting",
		eventSubType,
	});
}

describe("describeParlumeProviderFailure", () => {
	it("reports a lobby timeout as not admitted, with the wait in minutes", () => {
		expect(couldNotJoin("waiting_room_timeout_exceeded")).toEqual({
			endReason: "NOT_ADMITTED",
			message:
				"Nobody admitted Parlume from the lobby within 10 minutes.",
		});
	});

	it.each([
		"request_to_join_denied",
		"meeting_not_started_waiting_for_host",
		"meeting_ended_before_bot_joined",
	])("reports %s as not admitted", (subType) => {
		expect(couldNotJoin(subType).endReason).toBe("NOT_ADMITTED");
	});

	it.each([
		["meeting_not_found", "Check the meeting link."],
		["unable_to_connect_to_meeting", "Check the meeting link."],
		["login_required", "Settings → Meeting assistant"],
		["bot_login_attempt_failed", "Attendee dashboard"],
		["blocked_by_captcha", "verification challenge"],
	])("explains %s as a failed start", (subType, words) => {
		const failure = couldNotJoin(subType);
		expect(failure.endReason).toBe("START_FAILED");
		expect(failure.message).toContain(words);
	});

	it("names a join sub type it does not know, and stays generic without one", () => {
		expect(couldNotJoin("zoom_app_cannot_join_anonymously")).toEqual({
			endReason: "START_FAILED",
			message:
				"Parlume could not join the meeting (zoom_app_cannot_join_anonymously).",
		});
		expect(couldNotJoin(null).message).toBe(
			"Parlume could not join the meeting.",
		);
	});

	it("does not resolve a sub type through the object prototype", () => {
		expect(couldNotJoin("constructor")).toEqual({
			endReason: "START_FAILED",
			message: "Parlume could not join the meeting (constructor).",
		});
		expect(
			describeParlumeProviderFailure({
				eventType: "fatal_error",
				eventSubType: "toString",
			}).message,
		).toBe("Parlume meeting bot failed (toString).");
	});

	it("strips anything but a provider code from a stored sub type", () => {
		expect(couldNotJoin(`<b>bad</b> ${"x".repeat(100)}`).message).toMatch(
			/^Parlume could not join the meeting \(bbadbx+\)\.$/,
		);
		expect(
			couldNotJoin(`<b>bad</b> ${"x".repeat(100)}`).message,
		).toHaveLength("Parlume could not join the meeting ().".length + 64);
	});

	it("explains known fatal errors as provider failures", () => {
		expect(
			describeParlumeProviderFailure({
				eventType: "fatal_error",
				eventSubType: "out_of_credits",
			}),
		).toEqual({
			endReason: "PROVIDER_FAILED",
			message: "The Attendee account has run out of credits.",
		});
		expect(
			describeParlumeProviderFailure({
				eventType: "fatal_error",
				eventSubType: null,
			}),
		).toEqual({
			endReason: "PROVIDER_FAILED",
			message: "Parlume meeting bot failed.",
		});
	});
});
