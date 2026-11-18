import { describe, expect, it } from "vitest";
import {
	legacyWorkItemTypeFor,
	parseWorkItemTypeMapping,
	resolveKindFromPmType,
	resolveWorkItemType,
} from "../lib/work-item-type-mapping";

const FB = "User Story";

describe("resolveWorkItemType", () => {
	it("uses an explicit override before anything else", () => {
		expect(
			resolveWorkItemType("BUG", {
				mapping: { BUG: "Defect" },
				legacyFallback: FB,
			}),
		).toBe("Defect");
	});

	it("returns legacyFallback when no override and no availableTypes", () => {
		expect(resolveWorkItemType("FEATURE", { legacyFallback: FB })).toBe(
			"User Story",
		);
		expect(resolveWorkItemType("BUG", { legacyFallback: "Bug" })).toBe(
			"Bug",
		);
	});

	it("uses the priority chain when availableTypes is supplied", () => {
		expect(
			resolveWorkItemType("FEATURE", {
				availableTypes: ["Feature", "Bug"],
				legacyFallback: FB,
			}),
		).toBe("Feature");
	});

	it("falls back FEATURE -> Epic when Feature absent", () => {
		expect(
			resolveWorkItemType("FEATURE", {
				availableTypes: ["Epic", "User Story"],
				legacyFallback: FB,
			}),
		).toBe("Epic");
	});

	it("returns legacyFallback when availableTypes contains no priority match (no cross-kind)", () => {
		expect(
			resolveWorkItemType("BUG", {
				availableTypes: ["Story", "Task"],
				legacyFallback: "User Story",
			}),
		).toBe("User Story");
	});

	it("matches availableTypes case-insensitively, returns the tool's casing", () => {
		expect(
			resolveWorkItemType("BUG", {
				availableTypes: ["bug"],
				legacyFallback: FB,
			}),
		).toBe("bug");
	});

	it("trims surrounding whitespace from an override", () => {
		expect(
			resolveWorkItemType("BUG", {
				mapping: { BUG: "  Defect  " },
				legacyFallback: FB,
			}),
		).toBe("Defect");
	});

	it("resolves INITIATIVE to Epic when availableTypes contains Epic and Feature", () => {
		expect(
			resolveWorkItemType("INITIATIVE", {
				availableTypes: ["Epic", "Feature"],
				legacyFallback: "X",
			}),
		).toBe("Epic");
	});

	it("resolves INITIATIVE to Initiative when availableTypes has Initiative", () => {
		expect(
			resolveWorkItemType("INITIATIVE", {
				availableTypes: ["Initiative", "Epic"],
				legacyFallback: "X",
			}),
		).toBe("Initiative");
	});

	it("honors an explicit INITIATIVE mapping over availableTypes", () => {
		expect(
			resolveWorkItemType("INITIATIVE", {
				mapping: { INITIATIVE: "Portfolio Epic" },
				availableTypes: ["Initiative"],
				legacyFallback: "X",
			}),
		).toBe("Portfolio Epic");
	});
});

describe("resolveKindFromPmType", () => {
	it("maps Bug/Defect -> BUG, everything else (incl. User Story) -> FEATURE", () => {
		expect(resolveKindFromPmType("Bug")).toBe("BUG");
		expect(resolveKindFromPmType("defect")).toBe("BUG");
		expect(resolveKindFromPmType("Feature")).toBe("FEATURE");
		expect(resolveKindFromPmType("Epic")).toBe("FEATURE");
		expect(resolveKindFromPmType("Issue")).toBe("FEATURE");
		expect(resolveKindFromPmType(null)).toBe("FEATURE");
	});

	// Regression (#1305): the resolver must never emit "USER_STORY". That kind was
	// retired and the Prisma `StoryKind` enum is FEATURE|BUG, so createStory throws
	// on any other value — which broke the ADO pull once the reverse-map went live.
	it("resolves ADO 'User Story' to FEATURE and only ever returns BUG|FEATURE", () => {
		for (const pmType of [
			"User Story",
			"Story",
			"Task",
			"",
			"  ",
			null,
			undefined,
		]) {
			expect(["BUG", "FEATURE"]).toContain(resolveKindFromPmType(pmType));
		}
		expect(resolveKindFromPmType("User Story")).toBe("FEATURE");
	});

	it("honors an inverted stored mapping first", () => {
		expect(resolveKindFromPmType("Anomaly", { BUG: "Anomaly" })).toBe(
			"BUG",
		);
	});

	it("matches an inverted mapping value despite surrounding whitespace", () => {
		expect(resolveKindFromPmType("Anomaly", { BUG: "  Anomaly  " })).toBe(
			"BUG",
		);
	});

	it("resolves Epic with no mapping to FEATURE", () => {
		expect(resolveKindFromPmType("Epic")).toBe("FEATURE");
	});

	it("resolves Initiative with explicit mapping to INITIATIVE", () => {
		expect(
			resolveKindFromPmType("Initiative", { INITIATIVE: "Initiative" }),
		).toBe("INITIATIVE");
	});
});

describe("parseWorkItemTypeMapping", () => {
	it("reads a structured workItemTypeMapping object", () => {
		expect(
			parseWorkItemTypeMapping({
				workItemTypeMapping: { BUG: "Bug", FEATURE: "Epic" },
			}),
		).toEqual({ BUG: "Bug", FEATURE: "Epic" });
	});

	it("keeps the INITIATIVE entry when present", () => {
		expect(
			parseWorkItemTypeMapping({
				workItemTypeMapping: { INITIATIVE: "Epic" },
			}),
		).toEqual({ INITIATIVE: "Epic" });
	});

	it("does NOT seed from legacy single workItemType", () => {
		expect(parseWorkItemTypeMapping({ workItemType: "Task" })).toEqual({});
	});

	it("returns empty for null/garbage", () => {
		expect(parseWorkItemTypeMapping(null)).toEqual({});
		expect(parseWorkItemTypeMapping({ workItemTypeMapping: 5 })).toEqual(
			{},
		);
	});

	it("trims stored mapping values", () => {
		expect(
			parseWorkItemTypeMapping({
				workItemTypeMapping: { BUG: "  Bug  ", FEATURE: "Epic " },
			}),
		).toEqual({ BUG: "Bug", FEATURE: "Epic" });
	});
});

describe("legacyWorkItemTypeFor", () => {
	it("maps INITIATIVE to Epic", () => {
		expect(legacyWorkItemTypeFor("INITIATIVE", "User Story")).toBe("Epic");
	});

	it("keeps the fallback for FEATURE and BUG", () => {
		expect(legacyWorkItemTypeFor("FEATURE", "User Story")).toBe(
			"User Story",
		);
		expect(legacyWorkItemTypeFor("BUG", "Bug")).toBe("Bug");
		expect(legacyWorkItemTypeFor(null, "User Story")).toBe("User Story");
		expect(legacyWorkItemTypeFor(undefined, "User Story")).toBe(
			"User Story",
		);
	});
});
