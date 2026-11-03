import { describe, expect, it } from "vitest";
import {
	decodeTranscriptBytes,
	parsePlainTranscript,
	parseVttTranscript,
} from "../transcript-file-text";

describe("decodeTranscriptBytes", () => {
	it("reads UTF-8 and drops its byte order mark", () => {
		const bytes = Buffer.from("﻿Anna: привет", "utf-8");

		expect(decodeTranscriptBytes(bytes)).toEqual({
			text: "Anna: привет",
			unreadableCharacters: 0,
		});
	});

	it("reads the UTF-16 a Windows export writes", () => {
		const bytes = Buffer.from("﻿Anna: hello", "utf16le");

		expect(decodeTranscriptBytes(bytes).text).toBe("Anna: hello");
	});

	it("counts bytes that are not text, so the upload can say it is incomplete", () => {
		const bytes = Buffer.concat([
			Buffer.from("Anna: hel"),
			Buffer.from([0xff]),
			Buffer.from("lo"),
		]);

		expect(decodeTranscriptBytes(bytes).unreadableCharacters).toBe(1);
	});
});

describe("parseVttTranscript", () => {
	it("reads the speakers Teams writes as voice tags", () => {
		const parsed = parseVttTranscript(
			[
				"WEBVTT",
				"",
				"1a2b/1",
				"00:00:01.000 --> 00:00:04.000",
				"<v Anna Petrenko>Let's start.</v>",
				"",
				"00:00:05.000 --> 00:00:07.000",
				"<v Ben Ortiz>Ready.</v>",
			].join("\n"),
		);

		expect(parsed).toEqual({
			text: "Anna Petrenko: Let's start.\nBen Ortiz: Ready.",
			speakerNames: ["Anna Petrenko", "Ben Ortiz"],
			unreadableLines: 0,
		});
	});

	it("reads a speaker written as a prefix, the way Zoom exports do", () => {
		const parsed = parseVttTranscript(
			"WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nAnna Petrenko: Let's start.\n",
		);

		expect(parsed.text).toBe("Anna Petrenko: Let's start.");
		expect(parsed.speakerNames).toEqual(["Anna Petrenko"]);
	});

	it("accepts the short timing form and Windows line endings", () => {
		const parsed = parseVttTranscript(
			"WEBVTT\r\n\r\n00:01.000 --> 00:04.000\r\nNo speaker here.\r\n",
		);

		expect(parsed.text).toBe("No speaker here.");
		expect(parsed.speakerNames).toEqual([]);
		expect(parsed.unreadableLines).toBe(0);
	});

	it("joins a cue that wraps over several lines and removes markup", () => {
		const parsed = parseVttTranscript(
			"WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Anna>First <i>part</i>\nsecond &amp; last</v>\n",
		);

		expect(parsed.text).toBe("Anna: First part second & last");
	});

	it("skips notes and styles without calling them unreadable", () => {
		const parsed = parseVttTranscript(
			"WEBVTT\n\nNOTE exported by a tool\n\nSTYLE\n::cue { color: red }\n\n00:00:01.000 --> 00:00:04.000\nHello.\n",
		);

		expect(parsed.text).toBe("Hello.");
		expect(parsed.unreadableLines).toBe(0);
	});

	it("keeps what it can read and counts what it cannot", () => {
		const parsed = parseVttTranscript(
			[
				"WEBVTT",
				"",
				"00:00:01.000 --> 00:00:04.000",
				"Readable.",
				"",
				"broken timing line",
				"text with no cue",
				"",
				"00:00:05.000 --> 00:00:07.000",
				"Also readable.",
			].join("\n"),
		);

		expect(parsed.text).toBe("Readable.\nAlso readable.");
		expect(parsed.unreadableLines).toBe(2);
	});
});

describe("parsePlainTranscript", () => {
	it("finds speakers who talk more than once", () => {
		const parsed = parsePlainTranscript(
			"Anna Petrenko: Let's start.\nBen Ortiz: Ready.\nAnna Petrenko: Good.\nBen Ortiz: Next item.\n",
		);

		expect(parsed.speakerNames).toEqual(["Anna Petrenko", "Ben Ortiz"]);
		expect(parsed.unreadableLines).toBe(0);
	});

	it("finds speakers on a line of their own with a time, as Word exports have them", () => {
		const parsed = parsePlainTranscript(
			"Anna Petrenko   0:03\nLet's start.\n\nAnna Petrenko   1:12\nGood.\n",
		);

		expect(parsed.speakerNames).toEqual(["Anna Petrenko"]);
	});

	it("does not take a one-off label for a speaker", () => {
		const parsed = parsePlainTranscript(
			"Agenda: planning\nAnna: Hello.\nAnna: Bye.\n",
		);

		expect(parsed.speakerNames).toEqual(["Anna"]);
	});

	it("does not take a sentence for a speaker", () => {
		const parsed = parsePlainTranscript(
			"The items we still have to close today: two\nThe items we still have to close today: three\n",
		);

		expect(parsed.speakerNames).toEqual([]);
	});

	it("keeps the text as it was written", () => {
		const raw = "Notes from the call.\r\n\r\nSecond paragraph.  ";

		expect(parsePlainTranscript(raw).text).toBe(
			"Notes from the call.\n\nSecond paragraph.",
		);
	});
});
