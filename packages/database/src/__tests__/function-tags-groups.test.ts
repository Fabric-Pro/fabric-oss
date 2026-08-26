import { describe, expect, it } from "vitest";
import {
	FUNCTION_TAG_GROUP_LABELS,
	FUNCTION_TAG_GROUP_SLUGS,
	FUNCTION_TAG_VALUES,
	GROUP_SLUG_TO_TAG,
	isFunctionTag,
} from "../function-tags";

describe("function-tag group constants", () => {
	it("has a label and a slug for every tag", () => {
		for (const tag of FUNCTION_TAG_VALUES) {
			expect(FUNCTION_TAG_GROUP_LABELS[tag]).toBeTruthy();
			expect(FUNCTION_TAG_GROUP_SLUGS[tag]).toMatch(/^[a-z][a-z0-9-]*$/);
		}
	});
	it("round-trips slug → tag for every tag", () => {
		for (const tag of FUNCTION_TAG_VALUES) {
			expect(GROUP_SLUG_TO_TAG[FUNCTION_TAG_GROUP_SLUGS[tag]]).toBe(tag);
		}
	});
	it("slugs are unique", () => {
		const slugs = Object.values(FUNCTION_TAG_GROUP_SLUGS);
		expect(new Set(slugs).size).toBe(slugs.length);
	});
	it("isFunctionTag guards unknown values", () => {
		expect(isFunctionTag("DEVELOPER")).toBe(true);
		expect(isFunctionTag("NOT_A_TAG")).toBe(false);
	});
});
