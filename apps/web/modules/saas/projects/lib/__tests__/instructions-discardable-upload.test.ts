import { describe, expect, it } from "vitest";
import {
	canDiscardUpload,
	isStalledUpload,
	STALLED_UPLOAD_AFTER_MS,
} from "../instructions-discardable-upload";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
	new Date(NOW - minutes * 60_000).toISOString();

function upload(over: Record<string, unknown> = {}) {
	return {
		status: "RECEIVING",
		source: "UPLOAD",
		proposalStatus: null,
		createdAt: minutesAgo(5),
		...over,
	};
}

describe("canDiscardUpload", () => {
	it("is true for an upload that was begun and never finalized", () => {
		expect(canDiscardUpload(upload())).toBe(true);
	});

	it.each([
		["being checked", upload({ status: "VALIDATING" })],
		["finished", upload({ status: "READY" })],
		["a repository sync's own snapshot", upload({ source: "REPOSITORY" })],
		["a suggestion", upload({ proposalStatus: "PENDING" })],
	])("is false for an upload that is %s", (_label, snapshot) => {
		expect(canDiscardUpload(snapshot)).toBe(false);
	});

	it("reads a snapshot that does not say where it came from as not discardable", () => {
		expect(canDiscardUpload({ status: "RECEIVING" })).toBe(false);
	});
});

describe("isStalledUpload", () => {
	it("is false for an upload still within the hour", () => {
		expect(isStalledUpload(upload(), NOW)).toBe(false);
		expect(
			isStalledUpload(upload({ createdAt: minutesAgo(60) }), NOW),
		).toBe(false);
	});

	it("is true once an unfinished upload is older than an hour", () => {
		expect(
			isStalledUpload(upload({ createdAt: minutesAgo(61) }), NOW),
		).toBe(true);
		expect(STALLED_UPLOAD_AFTER_MS).toBe(60 * 60_000);
	});

	it("is never true for a row being checked, however old", () => {
		expect(
			isStalledUpload(
				upload({ status: "VALIDATING", createdAt: minutesAgo(600) }),
				NOW,
			),
		).toBe(false);
	});

	it("is never true for a sync's or a suggestion's row, however old", () => {
		expect(
			isStalledUpload(
				upload({ source: "REPOSITORY", createdAt: minutesAgo(600) }),
				NOW,
			),
		).toBe(false);
		expect(
			isStalledUpload(
				upload({
					proposalStatus: "PENDING",
					createdAt: minutesAgo(600),
				}),
				NOW,
			),
		).toBe(false);
	});

	it("reads a row with no usable age as not stalled rather than guessing", () => {
		expect(isStalledUpload(upload({ createdAt: null }), NOW)).toBe(false);
		expect(isStalledUpload(upload({ createdAt: "not a date" }), NOW)).toBe(
			false,
		);
	});

	it("takes a Date as well as a string", () => {
		expect(
			isStalledUpload(
				upload({ createdAt: new Date(NOW - 2 * 60 * 60_000) }),
				NOW,
			),
		).toBe(true);
	});
});
