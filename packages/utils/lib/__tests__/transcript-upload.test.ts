import { describe, expect, it } from "vitest";
import {
	TRANSCRIPT_UPLOAD_ACCEPT_ATTR,
	TRANSCRIPT_UPLOAD_FORMAT_LIST,
	TRANSCRIPT_UPLOAD_MAX_BYTES,
	transcriptUploadFormatOf,
} from "../transcript-upload";

describe("transcriptUploadFormatOf", () => {
	it.each([
		["standup.txt", "txt"],
		["standup.vtt", "vtt"],
		["standup.docx", "docx"],
		["Q3 planning.final.DOCX", "docx"],
	])("reads %s as %s", (filename, format) => {
		expect(transcriptUploadFormatOf(filename)).toBe(format);
	});

	it.each([
		"standup.pdf",
		"standup.doc",
		"standup",
		".txt",
		"vtt",
		"",
		"standup.constructor",
		"standup.__proto__",
		"standup.toString",
	])("refuses %j", (filename) => {
		expect(transcriptUploadFormatOf(filename)).toBeNull();
	});
});

describe("what a surface tells the user", () => {
	it("derives the picker and the message from one list", () => {
		expect(TRANSCRIPT_UPLOAD_FORMAT_LIST).toBe(".txt, .vtt, .docx");
		expect(TRANSCRIPT_UPLOAD_ACCEPT_ATTR).toBe(".txt,.vtt,.docx");
	});

	it("allows 25 MB", () => {
		expect(TRANSCRIPT_UPLOAD_MAX_BYTES).toBe(25 * 1024 * 1024);
	});
});
