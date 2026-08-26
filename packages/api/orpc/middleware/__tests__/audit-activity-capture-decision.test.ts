/**
 * The capture decision — the single rule that determines audit-log volume.
 *
 * The original rule was "not GET". A repository scan found **75** read
 * procedures declaring `POST` because they take a request body (a stats window,
 * a typeahead term) rather than because they change anything, so that rule
 * over-captured badly; the sharpest case found in staging was the audit-log
 * page's own reads landing in the ledger, so it accumulated rows about people
 * reading it.
 *
 * These tests pin the decision in both directions, because getting it wrong is
 * expensive each way: an excess row is noise, a missing row cannot be recovered.
 * The read-name pattern itself is checked separately and repository-wide by
 * `audit-activity-read-name-ratchet.test.ts` — that is what makes it safe to
 * drop a row on a name at all.
 */

import { describe, expect, it } from "vitest";
import {
	hasReadShapedName,
	readActivityCaptureMeta,
	shouldCapture,
} from "../audit-activity-middleware";

const POST = "POST";

function decide(over: Partial<Parameters<typeof shouldCapture>[0]> = {}) {
	return shouldCapture({ method: POST, readShapedName: false, ...over });
}

describe("shouldCapture", () => {
	it("never captures a GET", () => {
		expect(decide({ method: "GET" })).toBe(false);
		expect(decide({ method: "get" })).toBe(false);
	});

	it("drops a read-named call — the 75-procedure case", () => {
		expect(decide({ readShapedName: true })).toBe(false);
	});

	it("captures anything not named like a read", () => {
		// The load-bearing asymmetry: a missing record cannot be recovered, an
		// excess one can be filtered, so uncertainty captures.
		expect(decide({ readShapedName: false })).toBe(true);
	});

	it("treats an undeclared method as capturable", () => {
		// oRPC defaults to POST.
		expect(decide({ method: undefined })).toBe(true);
	});

	describe("explicit meta overrides the inference", () => {
		it('"never" suppresses a call that would otherwise be captured', () => {
			expect(
				decide({ readShapedName: false, metaOverride: "never" }),
			).toBe(false);
		});

		it('"always" captures a read-named call', () => {
			// The documented remedy for a read-named procedure that really does
			// write, and the escape hatch the ratchet accepts.
			expect(
				decide({ readShapedName: true, metaOverride: "always" }),
			).toBe(true);
		});

		it('"always" wins over GET', () => {
			expect(decide({ method: "GET", metaOverride: "always" })).toBe(
				true,
			);
		});
	});
});

describe("hasReadShapedName", () => {
	it.each([
		[["projects", "list"], true],
		[["audit", "stats"], true],
		[["audit", "searchMembers"], true],
		[["reports", "export"], true],
		[["documents", "getById"], true],
		[["testCases", "countByStatus"], true],
		[["projects", "create"], false],
		[["stories", "update"], false],
		[["org", "removeMember"], false],
		[["reports", "generate"], false],
		[["scans", "start"], false],
		// The regression that forced the camelCase boundary: as bare prefixes,
		// `can`/`is`/`has` match real mutations. An untightened pattern classified
		// four cancel* procedures as reads.
		[["weave", "cancelExecution"], false],
		[["organizations", "cancelInvitation"], false],
		[["tokens", "issueToken"], false],
		[["files", "hashUpload"], false],
		// ...while the genuine short-prefix reads still match.
		[["permissions", "canEdit"], true],
		[["flags", "isEnabled"], true],
		[["members", "hasAccess"], true],
		// `resolve` is deliberately NOT a read prefix: resolveContentDrift writes.
		[["projects", "resolveContentDrift"], false],
	])("%s -> %s", (path, expected) => {
		expect(hasReadShapedName(path as string[])).toBe(expected);
	});

	it("reads only the LEAF segment", () => {
		// A `list` namespace containing a mutation must not be dropped.
		expect(hasReadShapedName(["list", "create"])).toBe(false);
	});

	it("is safe on an empty path", () => {
		expect(hasReadShapedName([])).toBe(false);
	});
});

describe("readActivityCaptureMeta", () => {
	it("reads the declaration off the procedure", () => {
		expect(
			readActivityCaptureMeta({
				"~orpc": { meta: { auditActivity: "never" } },
			}),
		).toBe("never");
		expect(
			readActivityCaptureMeta({
				"~orpc": { meta: { auditActivity: "always" } },
			}),
		).toBe("always");
	});

	it.each([
		["no meta", { "~orpc": {} }],
		["no ~orpc", {}],
		["unknown value", { "~orpc": { meta: { auditActivity: "maybe" } } }],
		["null", null],
		["undefined", undefined],
	])("returns undefined for %s", (_label, procedure) => {
		expect(readActivityCaptureMeta(procedure)).toBeUndefined();
	});
});
