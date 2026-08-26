import { describe, expect, it } from "vitest";
import { DRAFTING_STAGE_META } from "../types";

describe("DRAFTING_STAGE_META.CLOSED — hide vocabulary (C2)", () => {
	it("labels the CLOSED stage as 'Hidden'", () => {
		expect(DRAFTING_STAGE_META.CLOSED.label).toBe("Hidden");
	});

	it("describes it with hide vocabulary, not 'Closed'", () => {
		expect(DRAFTING_STAGE_META.CLOSED.description).not.toMatch(/closed/i);
		expect(DRAFTING_STAGE_META.CLOSED.description).toMatch(/hidden/i);
	});
});
