import { describe, expect, it } from "vitest";
import { defaultProjectTabForProfile } from "../default-project-tab";

const TABS = [
	"overview",
	"documents",
	"stories",
	"kanban",
	"settings",
] as const;

describe("defaultProjectTabForProfile", () => {
	it("lands EXPLORE projects on the backlog chat tab", () => {
		expect(defaultProjectTabForProfile("EXPLORE", TABS)).toBe("stories");
	});

	it("lands every other profile (and unknown) on the overview", () => {
		expect(defaultProjectTabForProfile("PROPOSAL", TABS)).toBe("overview");
		expect(defaultProjectTabForProfile("GOVERNED", TABS)).toBe("overview");
		expect(defaultProjectTabForProfile("DELEGATED", TABS)).toBe("overview");
		expect(defaultProjectTabForProfile(null, TABS)).toBe("overview");
		expect(defaultProjectTabForProfile(undefined, TABS)).toBe("overview");
	});

	it("never returns a tab the page does not have", () => {
		expect(defaultProjectTabForProfile("EXPLORE", ["overview"])).toBe(
			"overview",
		);
	});
});
