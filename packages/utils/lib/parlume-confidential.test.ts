import { describe, expect, it } from "vitest";
import {
	PARLUME_UNCONFIRMED_REQUESTER_REPLY,
	parlumeConfidentialNotice,
	parlumeConfidentialReply,
	parseParlumeConfidentialCommand,
	parseParlumeConfidentialRequest,
} from "./parlume-confidential";

describe("parseParlumeConfidentialRequest", () => {
	it.each([
		"confidential",
		"This is confidential.",
		"confidential from now on",
		"Off the record",
		"we're going off the record",
		"please mark this as confidential",
	])("starts the confidential part for %j", (text) => {
		expect(parseParlumeConfidentialRequest(text)).toBe("on");
	});

	it.each([
		"end confidential",
		"stop the confidential part.",
		"confidential over",
		"back on the record",
		"this is no longer confidential",
	])("ends it for %j", (text) => {
		expect(parseParlumeConfidentialRequest(text)).toBe("off");
	});

	it.each([
		"is this confidential?",
		"what did we say off the record yesterday",
		"summarize the confidential pricing discussion",
		"",
	])("changes nothing for %j", (text) => {
		expect(parseParlumeConfidentialRequest(text)).toBeNull();
	});
});

describe("parseParlumeConfidentialCommand", () => {
	it("takes a command addressed to Parlume by name", () => {
		expect(
			parseParlumeConfidentialCommand("Parlume, confidential"),
		).toEqual({ switch: "on", address: "name" });
	});

	it("takes a command after the wake phrase, as transcription spells it", () => {
		expect(
			parseParlumeConfidentialCommand("Hey Parlume, end confidential."),
		).toEqual({ switch: "off", address: "wake" });
		expect(
			parseParlumeConfidentialCommand("A Parlume off the record"),
		).toEqual({ switch: "on", address: "wake" });
	});

	it("ignores a remark that does not address Parlume first", () => {
		expect(
			parseParlumeConfidentialCommand("The pricing is confidential."),
		).toBeNull();
		expect(
			parseParlumeConfidentialCommand("Let's go off the record, Parlume"),
		).toBeNull();
	});

	it("ignores a request to Parlume that only mentions confidentiality", () => {
		expect(
			parseParlumeConfidentialCommand("Parlume, is this confidential?"),
		).toBeNull();
	});
});

describe("what Parlume says about the confidential part", () => {
	it("names who marked it and how to end it", () => {
		const notice = parlumeConfidentialNotice({ switch: "on", by: "Dana" });

		expect(notice).toContain("marked by Dana");
		expect(notice).toContain("Parlume, end confidential");
	});

	it("names a meeting member when the chat gives no name", () => {
		expect(
			parlumeConfidentialNotice({ switch: "off", by: null }),
		).toContain("by a meeting member");
	});

	it("says the part could not end while it still runs after the request", () => {
		expect(
			parlumeConfidentialReply({ switch: "off", open: true }),
		).toContain("can't end the confidential part");
		expect(parlumeConfidentialReply({ switch: "off", open: false })).toBe(
			"This part of the meeting is no longer confidential.",
		);
	});

	it("offers a private route when it cannot tell who asked", () => {
		expect(PARLUME_UNCONFIRMED_REQUESTER_REPLY).toContain(
			"didn't look anything up",
		);
		expect(PARLUME_UNCONFIRMED_REQUESTER_REPLY).toContain(
			"Fabric Agent in Fabric",
		);
	});
});
