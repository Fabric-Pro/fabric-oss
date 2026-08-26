/**
 * What a downloaded piece of run evidence is called on disk.
 *
 * Two things are being protected. The obvious one is usefulness: without a name
 * the browser saves the storage key, so a folder of evidence from one run is a
 * pile of UUIDs. The less obvious one is that this string is interpolated into
 * a `Content-Disposition` header, which makes an unescaped quote or newline a
 * response-splitting bug rather than a cosmetic one.
 */

import { describe, expect, it } from "vitest";
import { evidenceFileName } from "../runs";

describe("evidenceFileName", () => {
	it("names the file after the case and the step", () => {
		expect(
			evidenceFileName({
				identifier: "TC-014",
				testCaseId: "case-abc",
				stepNumber: 3,
				key: "org-1/runs/run-9/8f3a.png",
			}),
		).toBe("TC-014-step-3.png");
	});

	it("keeps the stored file's own extension", () => {
		expect(
			evidenceFileName({
				identifier: "TC-1",
				testCaseId: "case-abc",
				stepNumber: 1,
				key: "org-1/runs/run-9/8f3a.jpeg",
			}),
		).toBe("TC-1-step-1.jpeg");
	});

	it("falls back to png when the key carries no extension", () => {
		expect(
			evidenceFileName({
				identifier: "TC-1",
				testCaseId: "case-abc",
				stepNumber: 2,
				key: "org-1/runs/run-9/8f3a",
			}),
		).toBe("TC-1-step-2.png");
	});

	it("falls back to the case id when there is no identifier", () => {
		// A case drafted but never given an identifier still has to produce a
		// distinguishable file rather than "-step-1.png".
		expect(
			evidenceFileName({
				identifier: null,
				testCaseId: "case-abc",
				stepNumber: 1,
				key: "k.png",
			}),
		).toBe("case-abc-step-1.png");
	});

	it("treats a blank identifier as absent", () => {
		expect(
			evidenceFileName({
				identifier: "   ",
				testCaseId: "case-abc",
				stepNumber: 1,
				key: "k.png",
			}),
		).toBe("case-abc-step-1.png");
	});

	it("strips anything that could break out of the header", () => {
		const name = evidenceFileName({
			identifier: 'TC-1" ; drop\r\nX-Injected: 1',
			testCaseId: "case-abc",
			stepNumber: 1,
			key: "k.png",
		});
		// The guarantee that matters is the character class, not the arithmetic:
		// nothing that can terminate or extend a header value survives.
		expect(name).not.toMatch(/["\r\n;]/);
		expect(name).toBe("TC-1----drop--X-Injected--1-step-1.png");
	});

	it("strips a path separator so the name cannot suggest a directory", () => {
		expect(
			evidenceFileName({
				identifier: "../../etc/passwd",
				testCaseId: "case-abc",
				stepNumber: 1,
				key: "k.png",
			}),
		).toBe("..-..-etc-passwd-step-1.png");
	});
});
