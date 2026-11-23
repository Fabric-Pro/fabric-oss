import { describe, expect, it } from "vitest";
import {
	decodeTranscriptBytes,
	parseMarkdownTranscript,
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

describe("parseMarkdownTranscript", () => {
	it.each([
		["bold label with the colon inside", "**Alice:** hi\n**Alice:** again"],
		[
			"bold label with the colon outside",
			"**Alice**: hi\n**Alice**: again",
		],
		["underscore bold label", "__Alice__: hi\n__Alice__: again"],
		[
			"bold italic label, colon inside",
			"***Alice:*** hi\n***Alice:*** again",
		],
		[
			"bold italic label, colon outside",
			"***Alice***: hi\n***Alice***: again",
		],
		["italic label", "*Alice:* hi\n*Alice:* again"],
		[
			"bulleted bold name with a time",
			"- **Alice** (00:01:02)\n- **Alice** (00:02:03)",
		],
		[
			"heading with a time",
			"### Alice 00:01:02\nhi\n### Alice 00:02:03\nagain",
		],
		["numbered list", "1. Alice: hi\n2. Alice: again"],
		["blockquote", "> Alice: hi\n> Alice: again"],
		["plain label", "Alice: hi\nAlice: again"],
	])("finds a speaker written as %s", (_name, raw) => {
		expect(parseMarkdownTranscript(raw).speakerNames).toEqual(["Alice"]);
	});

	it("does not count a name mentioned once", () => {
		expect(
			parseMarkdownTranscript(
				"**Alice:** hi\n**Bob:** hello\n**Alice:** bye",
			).speakerNames,
		).toEqual(["Alice"]);
	});

	it("keeps the Markdown in the text", () => {
		const raw =
			"## Standup\r\n\r\n**Alice:** hi\r\n- **Bob** (00:01:02)\r\n  ";

		expect(parseMarkdownTranscript(raw).text).toBe(
			"## Standup\n\n**Alice:** hi\n- **Bob** (00:01:02)",
		);
	});

	it("does not take a heading or a bold note for a speaker", () => {
		const parsed = parseMarkdownTranscript(
			"## Agenda: planning\n**Notes:** the budget\n**Alice:** hi\n**Alice:** bye",
		);

		expect(parsed.speakerNames).toEqual(["Alice"]);
		expect(
			parseMarkdownTranscript(
				"## Agenda: planning\n**Notes:** the budget",
			).speakerNames,
		).toEqual([]);
	});

	it("ignores lines inside a fenced code block, but keeps them in the text", () => {
		const raw =
			"**Alice:** hi\n```\n**Notes:** x\n**Notes:** y\n```\n~~~\n**Notes:** z\n**Notes:** w\n~~~\n**Alice:** bye";

		const parsed = parseMarkdownTranscript(raw);

		expect(parsed.speakerNames).toEqual(["Alice"]);
		expect(parsed.text).toBe(raw);
	});

	it("does not close a backtick fence on a line that has an info string", () => {
		const parsed = parseMarkdownTranscript(
			"```\n```example\n**Notes:** x\n**Notes:** y\n```\n**Alice:** a\n**Alice:** b",
		);

		expect(parsed.speakerNames).toEqual(["Alice"]);
	});

	it("ignores a fenced example inside a blockquote", () => {
		const parsed = parseMarkdownTranscript(
			"> ```\n> **Notes:** x\n> **Notes:** y\n> ```\n**Alice:** a\n**Alice:** b",
		);

		expect(parsed.speakerNames).toEqual(["Alice"]);
	});

	it("reads speakers again after a fence closes", () => {
		const parsed = parseMarkdownTranscript(
			"```\n**Bob:** x\n```\n**Bob:** a\n**Bob:** b",
		);

		expect(parsed.speakerNames).toEqual(["Bob"]);
	});

	it("ends a quoted fence with no closer when the blockquote ends", () => {
		const parsed = parseMarkdownTranscript(
			"> ```\n> **Notes:** x\n> **Notes:** y\n\n**Alice:** a\n**Alice:** b",
		);

		expect(parsed.speakerNames).toEqual(["Alice"]);
	});

	it("treats a quoted fence line inside a top-level fence as code", () => {
		const parsed = parseMarkdownTranscript(
			"```\n> ```\n**Notes:** x\n**Notes:** y\n```\n**Alice:** a\n**Alice:** b",
		);

		expect(parsed.speakerNames).toEqual(["Alice"]);
	});

	it("ignores a tilde-fenced block", () => {
		const parsed = parseMarkdownTranscript(
			"**Alice:** a\n~~~\n**Notes:** x\n**Notes:** y\n~~~\n**Alice:** b",
		);

		expect(parsed.speakerNames).toEqual(["Alice"]);
	});

	it("counts repeated labels in an indented block, which is not excluded", () => {
		const raw =
			"**Alice:** a\n\n    **Notes:** x\n    **Notes:** y\n\n\t**Tabbed:** x\n\t**Tabbed:** y\n\n**Alice:** b";

		const parsed = parseMarkdownTranscript(raw);

		expect(parsed.speakerNames).toEqual(["Alice", "Notes", "Tabbed"]);
		expect(parsed.text).toBe(raw);
	});

	it("reads a long list quickly and still skips a fence at the start", () => {
		const items = Array.from({ length: 200_000 }, () => "- item").join(
			"\n",
		);
		const raw = `\`\`\`\n**Notes:** x\n**Notes:** y\n\`\`\`\n${items}\n**Alice:** a\n**Alice:** b`;

		const parsed = parseMarkdownTranscript(raw);

		expect(parsed.speakerNames).toEqual(["Alice"]);
		expect(parsed.text).toBe(raw);
	});

	it("keeps a fence open past a quoted closer at a different depth", () => {
		const parsed = parseMarkdownTranscript(
			"> ```\n> > ```\n> **Notes:** x\n> **Notes:** y\n> ```\n**Alice:** a\n**Alice:** b",
		);

		expect(parsed.speakerNames).toEqual(["Alice"]);
	});

	it("does not close a fence on a closer-like line with trailing text", () => {
		const parsed = parseMarkdownTranscript(
			"```\n``` trailing\n**Notes:** x\n**Notes:** y\n```\n**Alice:** a\n**Alice:** b",
		);

		expect(parsed.speakerNames).toEqual(["Alice"]);
	});

	it("does not open a backtick fence whose info string has a backtick", () => {
		const parsed = parseMarkdownTranscript(
			"``` a`b\n**Alice:** a\n**Alice:** b",
		);

		expect(parsed.speakerNames).toEqual(["Alice"]);
	});

	it("does not close a fence on a shorter run", () => {
		const parsed = parseMarkdownTranscript(
			"````\n```\n**Notes:** x\n**Notes:** y\n````\n**Alice:** a\n**Alice:** b",
		);

		expect(parsed.speakerNames).toEqual(["Alice"]);
	});

	it("ignores a fenced block inside a list item", () => {
		const parsed = parseMarkdownTranscript(
			"**Alice:** a\n- item\n  ```\n  **Notes:** x\n  **Notes:** y\n  ```\n**Alice:** b",
		);

		expect(parsed.speakerNames).toEqual(["Alice"]);
	});

	it.each(["- ```js", "1. ```js", "1) ```js"])(
		"ignores a fence opened on a list item's own line (%s)",
		(opener) => {
			const parsed = parseMarkdownTranscript(
				`${opener}\n**Notes:** x\n**Notes:** y\n\`\`\`\n**Alice:** a\n**Alice:** b`,
			);

			expect(parsed.speakerNames).toEqual(["Alice"]);
		},
	);

	it("does not read a ten-digit number as a list marker before a fence", () => {
		// A list number has at most nine digits; this line is a paragraph.
		const parsed = parseMarkdownTranscript(
			"1234567890. ```\n**Alice:** a\n**Alice:** b",
		);

		expect(parsed.speakerNames).toEqual(["Alice"]);
	});

	it("reads a long fence-like run followed by a line separator quickly", () => {
		// A regex here retried every split of the run (quadratic): at this length
		// that ran for tens of seconds, past the test timeout.
		const lineSeparator = String.fromCharCode(0x2028);
		const parsed = parseMarkdownTranscript(
			`**Alice:** a\n**Alice:** b\n${"`".repeat(200_000)}${lineSeparator}x\n**Notes:** x\n**Notes:** y`,
		);

		expect(parsed.speakerNames).toEqual(["Alice"]);
	});

	it("leaves plain-file detection alone", () => {
		expect(
			parsePlainTranscript("**Alice:** hi\n**Alice:** again")
				.speakerNames,
		).toEqual([]);
	});
});
