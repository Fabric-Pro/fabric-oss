import { describe, expect, it } from "vitest";
import { getVisibleStageOptions } from "../types";

describe("getVisibleStageOptions — Feature Maturation V2 stage filtering", () => {
	it("returns all options when hidden list is empty or undefined", () => {
		const result = getVisibleStageOptions([]);
		expect(result).toHaveLength(3);
		expect(result).toEqual(["TO_DO", "DISCOVERY", "DONE"]);
	});

	it("omits hidden stage from returned options list", () => {
		const result = getVisibleStageOptions(["DISCOVERY"]);
		expect(result).toEqual(["TO_DO", "DONE"]);
	});

	it("omits multiple hidden stages from returned options list", () => {
		const result = getVisibleStageOptions(["TO_DO", "DISCOVERY"]);
		expect(result).toEqual(["DONE"]);
	});

	it("preserves currentStage in returned options even when currentStage is in hidden list", () => {
		const result = getVisibleStageOptions(["DISCOVERY"], "DISCOVERY");
		expect(result).toEqual(["TO_DO", "DISCOVERY", "DONE"]);
	});

	it("handles null or undefined currentStage safely", () => {
		const result = getVisibleStageOptions(["DISCOVERY"], null);
		expect(result).toEqual(["TO_DO", "DONE"]);
	});
});
