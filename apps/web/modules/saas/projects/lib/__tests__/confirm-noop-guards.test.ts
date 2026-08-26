/**
 * Unit tests for the confirm/accept no-op guards. These pure predicates gate
 * whether an actionable Confirm affordance is presented (a normalized no-op
 * must never reach Confirm) and whether a failed markdown extraction is allowed
 * to be saved (it must never wipe the document). Extracting them keeps the
 * decisions testable without mounting the full DocumentEditor.
 */

import { describe, expect, it } from "vitest";
import {
	isEmptyExtractionAgainstBaseline,
	isNoOpProposedContent,
} from "../confirm-noop-guards";

describe("isNoOpProposedContent", () => {
	it("treats a byte-identical proposal as a no-op", () => {
		const doc = "# Title\n\nSome body text.";
		expect(isNoOpProposedContent(doc, doc)).toBe(true);
	});

	it("treats a trailing-whitespace-only difference as a no-op (canonical comparator)", () => {
		const baseline = "# Title\n\nSome body text.";
		const proposed = "# Title  \n\nSome body text.   ";
		expect(isNoOpProposedContent(proposed, baseline)).toBe(true);
	});

	it("treats a CRLF-vs-LF-only difference as a no-op", () => {
		const baseline = "line one\nline two";
		const proposed = "line one\r\nline two";
		expect(isNoOpProposedContent(proposed, baseline)).toBe(true);
	});

	it("treats extra blank lines (3+ collapsed to 2) as a no-op", () => {
		const baseline = "para one\n\npara two";
		const proposed = "para one\n\n\n\npara two";
		expect(isNoOpProposedContent(proposed, baseline)).toBe(true);
	});

	it("reports a real content change as NOT a no-op", () => {
		const baseline = "# Title\n\nSome body text.";
		const proposed =
			"# Title\n\nSome body text. Now with an added sentence.";
		expect(isNoOpProposedContent(proposed, baseline)).toBe(false);
	});

	it("treats null / undefined proposed content as a no-op against an empty baseline", () => {
		expect(isNoOpProposedContent(null, "")).toBe(true);
		expect(isNoOpProposedContent(undefined, "")).toBe(true);
	});

	it("reports null proposed content against a non-empty baseline as NOT a no-op", () => {
		expect(isNoOpProposedContent(null, "# real content")).toBe(false);
	});
});

describe("isEmptyExtractionAgainstBaseline", () => {
	it("flags an empty extraction against a non-empty baseline", () => {
		expect(
			isEmptyExtractionAgainstBaseline("", "# existing document"),
		).toBe(true);
	});

	it("does not flag an empty extraction against an empty baseline (legitimately empty doc)", () => {
		expect(isEmptyExtractionAgainstBaseline("", "")).toBe(false);
	});

	it("does not flag a non-empty extraction", () => {
		expect(
			isEmptyExtractionAgainstBaseline("# content", "# existing"),
		).toBe(false);
	});
});
