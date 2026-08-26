import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A wiring guard, not a behaviour test — the same shape as the cases table's
 * `display-wiring`.
 *
 * `criterionDisplayText` is unit-tested in `@repo/utils`, and those tests pass
 * whether or not anything calls it. The bug it exists for was at the CALL SITE:
 * the matrix rendered `row.criterion.text` directly, so every Given/When/Then
 * criterion showed its markdown asterisks on screen.
 *
 * Dropping the call back to the raw field is not a type error — both are
 * strings — so nothing else would notice. Verified by reverting the call and
 * watching the maturation suite stay green.
 */
const MATRIX = readFileSync(
	path.resolve(__dirname, "../CoverageMatrixTable.tsx"),
	"utf8",
);

describe("the traceability matrix renders criteria for a reader", () => {
	it("passes criterion text through the display normaliser", () => {
		expect(MATRIX).toContain("criterionDisplayText(row.criterion.text)");
	});

	it("never renders the raw criterion field directly", () => {
		// `{row.criterion.text}` as its own JSX expression is the regression.
		expect(MATRIX).not.toMatch(/\{\s*row\.criterion\.text\s*\}/);
	});
});
