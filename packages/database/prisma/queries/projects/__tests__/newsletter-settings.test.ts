import { describe, expect, it } from "vitest";
import { newsletterSettingsDefaults } from "../newsletter";

describe("newsletterSettingsDefaults", () => {
	it("defaults requireApproval to false", () => {
		expect(newsletterSettingsDefaults("proj_1").requireApproval).toBe(
			false,
		);
	});
});
