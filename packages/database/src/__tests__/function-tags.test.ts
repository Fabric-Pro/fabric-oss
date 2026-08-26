import { describe, expect, it } from "vitest";
import {
	FUNCTION_TAG_LABELS,
	FUNCTION_TAG_ORDER,
	FUNCTION_TAG_VALUES,
} from "../function-tags";

describe("function-tags const", () => {
	it("has exactly the eight values", () => {
		expect([...FUNCTION_TAG_VALUES].sort()).toEqual([
			"ARCHITECT",
			"DESIGNER",
			"DEVELOPER",
			"PRODUCT_CONTRIBUTOR",
			"PRODUCT_OWNER",
			"SDET_QA",
			"SME",
			"STAKEHOLDER",
		]);
	});
	it("labels cover every value and order lists every value once", () => {
		for (const v of FUNCTION_TAG_VALUES) {
			expect(FUNCTION_TAG_LABELS[v]).toBeTruthy();
		}
		expect([...FUNCTION_TAG_ORDER].sort()).toEqual(
			[...FUNCTION_TAG_VALUES].sort(),
		);
	});
	it("places DESIGNER after ARCHITECT and before SDET_QA in display order", () => {
		const order = [...FUNCTION_TAG_ORDER];
		expect(order.indexOf("DESIGNER")).toBe(order.indexOf("ARCHITECT") + 1);
		expect(order.indexOf("DESIGNER")).toBeLessThan(
			order.indexOf("SDET_QA"),
		);
	});
	it('labels DESIGNER as "Designer"', () => {
		expect(FUNCTION_TAG_LABELS.DESIGNER).toBe("Designer");
	});
});
