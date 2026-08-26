import { CheckIcon, ClockIcon, Loader2Icon, MinusIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
	branchStatusIndicator,
	confidenceLabel,
	confidenceLevel,
	DEFAULT_CONFIDENCE_FLOOR,
	findingGroupKey,
	formatElapsed,
	getFindingScanner,
	isLowConfidence,
	worstSeverity,
} from "../lib";

describe("getFindingScanner", () => {
	it("classifies Semgrep findings by their ruleSource prefix", () => {
		expect(
			getFindingScanner({
				ruleSource: "Semgrep: javascript.express.security.audit.xss",
				category: "SECURITY",
			}),
		).toBe("SEMGREP");
	});

	it("classifies git-history secrets by their ruleSource prefix", () => {
		expect(
			getFindingScanner({
				ruleSource: "Secret history: aws-access-token",
				category: "SECURITY",
			}),
		).toBe("GIT_HISTORY");
	});

	it("classifies LLM security findings as AI security", () => {
		expect(
			getFindingScanner({
				ruleSource: "OWASP Top 10 — A03:2021 Injection",
				category: "SECURITY",
			}),
		).toBe("AI_SECURITY");
	});

	it("classifies LLM accessibility findings as AI accessibility", () => {
		expect(
			getFindingScanner({
				ruleSource: "WCAG 2.1 AA — 1.4.3 Contrast (Minimum)",
				category: "ACCESSIBILITY",
			}),
		).toBe("AI_ACCESSIBILITY");
	});

	it("treats a custom security rule as AI security (not a repo scanner)", () => {
		expect(
			getFindingScanner({
				ruleSource: "Custom: No secrets in client-side config",
				category: "SECURITY",
			}),
		).toBe("AI_SECURITY");
	});

	it("only matches the engine prefix at the START of ruleSource", () => {
		// A custom rule that merely mentions Semgrep mid-string must NOT be
		// misclassified as a Semgrep finding.
		expect(
			getFindingScanner({
				ruleSource: "Custom: Run Semgrep in CI",
				category: "SECURITY",
			}),
		).toBe("AI_SECURITY");
	});

	it("tolerates an empty ruleSource (falls back to category)", () => {
		expect(
			getFindingScanner({ ruleSource: "", category: "SECURITY" }),
		).toBe("AI_SECURITY");
		expect(
			getFindingScanner({ ruleSource: "", category: "ACCESSIBILITY" }),
		).toBe("AI_ACCESSIBILITY");
	});
});

describe("formatElapsed", () => {
	it("formats sub-minute durations as seconds", () => {
		expect(formatElapsed(45_000)).toBe("45s");
	});

	it("formats minutes with zero-padded seconds", () => {
		expect(formatElapsed(125_000)).toBe("2m 05s");
	});

	it("formats hours with zero-padded minutes and seconds", () => {
		expect(formatElapsed(3_785_000)).toBe("1h 03m 05s");
	});

	it("clamps negative input to 0s (clock skew / not-yet-started)", () => {
		expect(formatElapsed(-5_000)).toBe("0s");
	});

	it("floors partial seconds", () => {
		expect(formatElapsed(1_999)).toBe("1s");
	});
});

describe("confidenceLevel", () => {
	it("buckets ≥ 0.8 as High", () => {
		expect(confidenceLevel(0.8)).toBe("HIGH");
		expect(confidenceLevel(0.9)).toBe("HIGH");
		expect(confidenceLevel(1)).toBe("HIGH");
	});

	it("buckets [0.5, 0.8) as Medium", () => {
		expect(confidenceLevel(0.5)).toBe("MEDIUM");
		expect(confidenceLevel(0.6)).toBe("MEDIUM");
		expect(confidenceLevel(0.79)).toBe("MEDIUM");
	});

	it("buckets < 0.5 as Low", () => {
		expect(confidenceLevel(0.49)).toBe("LOW");
		expect(confidenceLevel(0.3)).toBe("LOW");
		expect(confidenceLevel(0)).toBe("LOW");
	});

	it("returns null for missing / NaN confidence (legacy rows)", () => {
		expect(confidenceLevel(null)).toBeNull();
		expect(confidenceLevel(undefined)).toBeNull();
		expect(confidenceLevel(Number.NaN)).toBeNull();
	});
});

describe("DEFAULT_CONFIDENCE_FLOOR", () => {
	it("mirrors the backend floor of 0.5", () => {
		expect(DEFAULT_CONFIDENCE_FLOOR).toBe(0.5);
	});

	it("is the exact boundary confidenceLevel splits Low from Medium on", () => {
		expect(confidenceLevel(DEFAULT_CONFIDENCE_FLOOR)).toBe("MEDIUM");
		expect(confidenceLevel(DEFAULT_CONFIDENCE_FLOOR - 0.01)).toBe("LOW");
	});
});

describe("isLowConfidence", () => {
	it("is true below the floor (collapsed out of the default view)", () => {
		expect(isLowConfidence(0.49)).toBe(true);
		expect(isLowConfidence(0.3)).toBe(true);
		expect(isLowConfidence(0)).toBe(true);
	});

	it("is false at or above the floor (stays in the main view)", () => {
		expect(isLowConfidence(0.5)).toBe(false);
		expect(isLowConfidence(0.6)).toBe(false);
		expect(isLowConfidence(0.8)).toBe(false);
		expect(isLowConfidence(1)).toBe(false);
	});

	it("treats null / undefined / NaN (legacy rows) as NOT low — they stay visible", () => {
		expect(isLowConfidence(null)).toBe(false);
		expect(isLowConfidence(undefined)).toBe(false);
		expect(isLowConfidence(Number.NaN)).toBe(false);
	});

	it("stays consistent with confidenceLevel === 'LOW'", () => {
		for (const v of [0, 0.1, 0.49, 0.5, 0.8, 1, null, undefined]) {
			expect(isLowConfidence(v)).toBe(confidenceLevel(v) === "LOW");
		}
	});
});

describe("confidenceLabel", () => {
	it("appends 'confidence' to the level word", () => {
		expect(confidenceLabel(0.9)).toBe("High confidence");
		expect(confidenceLabel(0.6)).toBe("Medium confidence");
		expect(confidenceLabel(0.2)).toBe("Low confidence");
	});

	it("returns null when there is no confidence to show", () => {
		expect(confidenceLabel(null)).toBeNull();
	});
});

describe("worstSeverity", () => {
	it("returns the highest (worst) severity in the set", () => {
		expect(worstSeverity(["HIGH", "MEDIUM", "LOW"])).toBe("HIGH");
		expect(worstSeverity(["LOW", "CRITICAL"])).toBe("CRITICAL");
		expect(worstSeverity(["MEDIUM", "MEDIUM"])).toBe("MEDIUM");
	});

	it("is order-independent", () => {
		expect(worstSeverity(["LOW", "HIGH", "CRITICAL", "MEDIUM"])).toBe(
			"CRITICAL",
		);
		expect(worstSeverity(["CRITICAL", "LOW"])).toBe("CRITICAL");
	});

	it("defaults to LOW for an empty set", () => {
		expect(worstSeverity([])).toBe("LOW");
	});
});

describe("findingGroupKey", () => {
	it("keys on the linked story identifier when present", () => {
		const gk = findingGroupKey({
			location: "Some place",
			storyId: "story-1",
			story: {
				id: "story-1",
				identifier: "F-12",
			} as never,
		});
		expect(gk.key).toBe("story:story-1");
		expect(gk.label).toBe("F-12");
	});

	it("keys on an embedded feature id when there is no linked story", () => {
		const gk = findingGroupKey({
			location: "Feature F-7 — login form",
			storyId: null,
			story: null,
		});
		expect(gk.key).toBe("feature:F-7");
		expect(gk.label).toBe("F-7");
	});

	it("keys on the raw location for a repo path / region", () => {
		const gk = findingGroupKey({
			location: "src/auth/login.ts:42",
			storyId: null,
			story: null,
		});
		expect(gk.key).toBe("loc:src/auth/login.ts:42");
		expect(gk.label).toBe("src/auth/login.ts:42");
	});

	it("falls back to a single ungrouped bucket with no location", () => {
		const a = findingGroupKey({
			location: null,
			storyId: null,
			story: null,
		});
		const b = findingGroupKey({
			location: "   ",
			storyId: null,
			story: null,
		});
		// Both collapse to the same stable key so they group together.
		expect(a.key).toBe(b.key);
		expect(a.label).toBe("No specific location");
	});
});

describe("branchStatusIndicator", () => {
	it("maps SCANNED to a Check icon in the secondary token", () => {
		expect(branchStatusIndicator("SCANNED")).toMatchObject({
			icon: CheckIcon,
			label: "Scanned",
			className: "text-secondary",
		});
	});

	it("maps STALE to a Clock icon in the highlight token", () => {
		expect(branchStatusIndicator("STALE")).toMatchObject({
			icon: ClockIcon,
			label: "Stale",
			className: "text-highlight",
		});
	});

	it("maps NOT_SCANNED to a Minus/dash icon in the muted token", () => {
		expect(branchStatusIndicator("NOT_SCANNED")).toMatchObject({
			icon: MinusIcon,
			label: "Not scanned",
			className: "text-muted-foreground",
		});
	});

	it("maps SCANNING to a Loader spinner icon in the primary token", () => {
		expect(branchStatusIndicator("SCANNING")).toMatchObject({
			icon: Loader2Icon,
			label: "Scanning",
			className: "text-primary",
		});
	});

	it("uses only design-token color classes — never a hardcoded hex", () => {
		for (const status of [
			"SCANNED",
			"STALE",
			"NOT_SCANNED",
			"SCANNING",
		] as const) {
			expect(branchStatusIndicator(status).className).not.toMatch(/#/);
		}
	});
});
