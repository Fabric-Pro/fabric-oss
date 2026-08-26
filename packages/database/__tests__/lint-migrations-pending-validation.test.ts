import { describe, expect, it } from "vitest";
import {
	findNotValidConstraints,
	findPendingValidationViolations,
} from "../scripts/lint-migrations";

const DECLARED = [{ constraint: "live_table_check", validateBy: "2026-11-30" }];
const TODAY = "2026-08-12";

/**
 * `findPendingValidationViolations` above is a pure function over already-parsed
 * sites, so it never exercises the regex extraction that produces those sites.
 * These tests cover `findNotValidConstraints` itself — the part that actually
 * reads migration SQL — because it has its own way to get this rule wrong: a
 * forward scan that isn't bounded to one statement.
 */
describe("findNotValidConstraints", () => {
	it("does not credit an earlier, unrelated constraint with a later statement's NOT VALID", () => {
		// Regression: the extraction used to search forward from the first ADD
		// CONSTRAINT to the next NOT VALID anywhere later in the file. That
		// attributed this ordinary, validating c1_check to NOT VALID, and never
		// saw c2_check — the actual NOT VALID site — because it was swallowed
		// inside the first match's span.
		const sql = `
ALTER TABLE "a" ADD CONSTRAINT "c1_check" CHECK (x > 0);
ALTER TABLE "b" ADD CONSTRAINT "c2_check" CHECK (y > 0) NOT VALID;
`;
		expect(findNotValidConstraints(sql)).toEqual(["c2_check"]);
	});

	it("attributes NOT VALID to the right constraint when one ALTER TABLE adds several", () => {
		const sql = `ALTER TABLE "t" ADD CONSTRAINT "c1" CHECK ("a" > 0), ADD CONSTRAINT "c2" CHECK ("b" > 0) NOT VALID;`;
		expect(findNotValidConstraints(sql)).toEqual(["c2"]);
	});

	it("still finds a NOT VALID constraint that is the only one in its statement", () => {
		const sql = `ALTER TABLE "user" ADD CONSTRAINT "fk1" FOREIGN KEY ("orgId") REFERENCES "org"("id") NOT VALID;`;
		expect(findNotValidConstraints(sql)).toEqual(["fk1"]);
	});

	it("does not flag a validating constraint that carries no NOT VALID at all", () => {
		const sql = `ALTER TABLE "a" ADD CONSTRAINT "c1_check" CHECK (x > 0);`;
		expect(findNotValidConstraints(sql)).toEqual([]);
	});
});

it("accepts a NOT VALID constraint that is declared as pending, before its deadline", () => {
	const violations = findPendingValidationViolations({
		notValid: [{ constraint: "live_table_check", migration: "20260812_a" }],
		validated: [],
		declared: DECLARED,
		today: TODAY,
	});
	expect(violations).toEqual([]);
});

it("rejects a NOT VALID constraint nobody declared", () => {
	const violations = findPendingValidationViolations({
		notValid: [{ constraint: "surprise_check", migration: "20260812_a" }],
		validated: [],
		declared: DECLARED,
		today: TODAY,
	});
	expect(violations).toHaveLength(1);
	expect(violations[0]).toContain("surprise_check");
});

it("rejects a declared constraint whose deadline has passed", () => {
	// Without this, a declaration is a PERMANENT exemption: never adding the VALIDATE keeps CI
	// green forever and leaves historical rows outside the constraint — the exact failure the
	// entry claims to be tracking.
	const violations = findPendingValidationViolations({
		notValid: [{ constraint: "live_table_check", migration: "20260812_a" }],
		validated: [],
		declared: DECLARED,
		today: "2026-12-01",
	});
	expect(violations).toHaveLength(1);
	expect(violations[0]).toContain("has passed");
});

it.each([
	" ",
	"",
	"soon",
	"2026-13-45",
	"30/11/2026",
	"2026-02-29",
	"2026-11-31",
])("rejects a declaration whose validateBy is unusable (%j)", (validateBy) => {
	// An unparsable deadline is a permanent exemption wearing a deadline's clothes: a rule that
	// only compares strings would accept "soon" forever.
	const violations = findPendingValidationViolations({
		notValid: [{ constraint: "live_table_check", migration: "20260812_a" }],
		validated: [],
		declared: [{ constraint: "live_table_check", validateBy }],
		today: TODAY,
	});
	expect(violations).toHaveLength(1);
	expect(violations[0]).toContain("validateBy");
});

it("rejects a declaration left behind after its VALIDATE landed", () => {
	const violations = findPendingValidationViolations({
		notValid: [{ constraint: "live_table_check", migration: "20260812_a" }],
		validated: [
			{ constraint: "live_table_check", migration: "20260901_b" },
		],
		declared: DECLARED,
		today: TODAY,
	});
	expect(violations).toHaveLength(1);
	expect(violations[0]).toContain("already validated");
});

it("rejects a VALIDATE that precedes its own NOT VALID", () => {
	const violations = findPendingValidationViolations({
		notValid: [{ constraint: "live_table_check", migration: "20260901_b" }],
		validated: [
			{ constraint: "live_table_check", migration: "20260812_a" },
		],
		declared: DECLARED,
		today: TODAY,
	});
	expect(violations).toHaveLength(1);
	expect(violations[0]).toContain("before");
});
