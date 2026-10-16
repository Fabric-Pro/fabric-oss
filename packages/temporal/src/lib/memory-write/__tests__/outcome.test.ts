/**
 * The typed outcome of a Living Memory write (ADR-022): one variant per
 * settled status, strict, so a receipt that holds an outcome the API hands
 * back holds exactly the vocabulary clients are told about.
 */
import { describe, expect, it } from "vitest";
import {
	isConflictVerdict,
	MEMORY_WRITE_PATH_VERDICT_CODES,
	MEMORY_WRITE_SETTLED_STATUSES,
	memoryWriteOutcomeSchema,
} from "../outcome";

const SHA = "a".repeat(40);

const valid = [
	{ status: "COMMITTED", sha: SHA, ref: "main", fileCount: 2 },
	{
		status: "PULL_REQUEST",
		sha: SHA,
		ref: "main",
		branch: "fabric/memory/cmemwrite00000001",
		url: "https://example.com/pull/1",
		externalId: "1",
		reason: "protected",
		fileCount: 1,
	},
	{
		status: "CONFLICT",
		paths: [
			{ path: "docs/a.md", code: "IF_MATCH_MISMATCH", currentOid: SHA },
			{ path: "docs/b.md", code: "PATH_MISSING", currentOid: null },
		],
	},
	{ status: "REFUSED", code: "READ_ONLY_MODE" },
	{
		status: "REFUSED",
		code: "PATH_REFUSED",
		paths: [{ path: "docs/a.md", code: "PATH_EXCLUDED" }],
	},
	{ status: "FAILED", code: "BRANCH_BUSY", retryable: true },
	{ status: "FAILED", code: "SETTLE_FAILED", retryable: true, sha: SHA },
] as const;

describe("memoryWriteOutcomeSchema", () => {
	it.each(valid.map((outcome) => [outcome.status, outcome] as const))(
		"accepts a %s outcome",
		(_status, outcome) => {
			expect(memoryWriteOutcomeSchema.parse(outcome)).toEqual(outcome);
		},
	);

	it("has a variant for every settled status", () => {
		expect(new Set(valid.map((outcome) => outcome.status))).toEqual(
			new Set(MEMORY_WRITE_SETTLED_STATUSES),
		);
	});

	it.each([
		["a status that is not settled", { status: "PENDING" }],
		[
			"a commit whose id is not an object id",
			{ status: "COMMITTED", sha: "nope", ref: "main", fileCount: 1 },
		],
		[
			"a refusal with a code of no vocabulary",
			{ status: "REFUSED", code: "BECAUSE" },
		],
		[
			"a verdict with a code of no vocabulary",
			{ status: "CONFLICT", paths: [{ path: "a", code: "NOPE" }] },
		],
		[
			"a field the variant does not have",
			{
				status: "FAILED",
				code: "X",
				retryable: false,
				text: "free text",
			},
		],
		["a failure with no retry verdict", { status: "FAILED", code: "X" }],
	])("rejects %s", (_name, outcome) => {
		expect(memoryWriteOutcomeSchema.safeParse(outcome).success).toBe(false);
	});
});

describe("isConflictVerdict", () => {
	it("calls a path that changed under the caller a conflict, and a path the repository rules out a refusal", () => {
		expect(
			MEMORY_WRITE_PATH_VERDICT_CODES.filter(isConflictVerdict),
		).toEqual(["PATH_EXISTS", "PATH_MISSING", "IF_MATCH_MISMATCH"]);
	});
});
