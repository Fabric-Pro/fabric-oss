/**
 * Which stood-down documents can be made canonical again.
 *
 * The predicate has to be at least as wide as whatever makes documents
 * inactive, and that happens at any status — so anything that can end up
 * inactive must be restorable. It used to require COMPLETE, which left an
 * inactive draft stranded, found on a deployed environment where two drafts
 * were inactive and neither card offered the action.
 */

import { describe, expect, it } from "vitest";
import { canBeMadeActive } from "../DocumentsList";

describe("canBeMadeActive", () => {
	it.each(["DRAFT", "IN_PROGRESS", "REVIEW", "COMPLETE"])(
		"offers the way back for a %s document",
		(status) => {
			expect(canBeMadeActive(status)).toBe(true);
		},
	);

	/**
	 * The two with no body to be canonical with: one still being written, one
	 * whose run failed. Making either the active document would point retrieval
	 * at nothing.
	 */
	it.each(["GENERATING", "FAILED"])(
		"withholds it from a %s document",
		(status) => {
			expect(canBeMadeActive(status)).toBe(false);
		},
	);

	it("treats a missing status as restorable rather than stranded", () => {
		expect(canBeMadeActive(undefined)).toBe(true);
		expect(canBeMadeActive(null)).toBe(true);
	});
});
