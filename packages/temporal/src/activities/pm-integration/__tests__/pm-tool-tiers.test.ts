import { describe, expect, it } from "vitest";
import {
	getPmToolTier,
	PM_TOOL_TIERS,
	type PmToolTier,
} from "../pm-tool-tiers";

const VALID_TIERS: PmToolTier[] = ["T1", "T2", "T3"];

describe("PM_TOOL_TIERS", () => {
	it("records ADO (azure-devops) as T1", () => {
		expect(PM_TOOL_TIERS["azure-devops"]).toBe("T1");
	});

	it("records GitLab as not T1 (it is a T2 happy-path tool)", () => {
		expect(PM_TOOL_TIERS.gitlab).not.toBe("T1");
		expect(PM_TOOL_TIERS.gitlab).toBe("T2");
	});

	it("classifies azure-devops as the only T1 tool", () => {
		const t1Tools = Object.entries(PM_TOOL_TIERS)
			.filter(([, tier]) => tier === "T1")
			.map(([tool]) => tool);
		expect(t1Tools).toEqual(["azure-devops"]);
	});

	it("classifies the taskGet tools (T2) per the spike evidence", () => {
		const t2Tools = Object.entries(PM_TOOL_TIERS)
			.filter(([, tier]) => tier === "T2")
			.map(([tool]) => tool)
			.sort();
		expect(t2Tools).toEqual(
			["clickup", "fizzy", "gitlab", "jira", "linear", "trello"].sort(),
		);
	});

	it("has a valid tier value for every entry", () => {
		for (const tier of Object.values(PM_TOOL_TIERS)) {
			expect(VALID_TIERS).toContain(tier);
		}
	});

	it("covers the spec's supported tool set", () => {
		const supported = [
			"azure-devops",
			"fizzy",
			"gitlab",
			"jira",
			"linear",
			"clickup",
			"trello",
		];
		for (const tool of supported) {
			expect(PM_TOOL_TIERS).toHaveProperty(tool);
		}
	});
});

describe("getPmToolTier", () => {
	it("resolves a known tool's tier", () => {
		expect(getPmToolTier("azure-devops")).toBe("T1");
		expect(getPmToolTier("fizzy")).toBe("T2");
	});

	it("returns undefined for an unverified / unknown tool", () => {
		expect(getPmToolTier("github")).toBeUndefined();
		expect(getPmToolTier("notion")).toBeUndefined();
		expect(getPmToolTier("does-not-exist")).toBeUndefined();
	});
});
