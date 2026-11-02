import { describe, expect, it } from "vitest";
import { coverLetterLabel } from "../lib/proposal-artifact/cover-letter-heading";

describe("coverLetterLabel", () => {
	it.each([
		["Cover letter", "Cover letter"],
		["COVER LETTER", "COVER LETTER"],
		["1. Cover letter:", "Cover letter"],
		["1: Cover letter", "Cover letter"],
		["2) Cover Letter", "Cover Letter"],
		["0.1 Anschreiben.", "Anschreiben"],
		// The editor's escaped number, as a reader of the raw line sees it.
		["1\\. Cover letter", "Cover letter"],
		["  cover letter.  ", "cover letter"],
	])("labels %j as %j", (heading, label) => {
		expect(coverLetterLabel(heading)).toBe(label);
	});

	it.each([
		"Cover letters",
		"Cover letter and terms",
		"Our cover letter",
		"A. Cover letter",
		"IV. Cover letter",
		"Letter",
		"",
	])("is null for %j", (heading) => {
		expect(coverLetterLabel(heading)).toBeNull();
	});
});
