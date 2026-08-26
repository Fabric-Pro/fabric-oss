import { tagValueSchema } from "@repo/utils/tag-value";
import { describe, expect, it } from "vitest";
import {
	NEEDS_RULE_REVIEW_TAG,
	PREREQUISITE_ACCESS_TAG,
	themeTagValue,
} from "../grouping-tags";

describe("themeTagValue — determinism", () => {
	it("is stable across repeated calls for the same (category, ruleSource)", () => {
		const first = themeTagValue(
			"SECURITY",
			"OWASP Top 10 — A03:2021 Injection",
		);
		const second = themeTagValue(
			"SECURITY",
			"OWASP Top 10 — A03:2021 Injection",
		);
		const third = themeTagValue(
			"SECURITY",
			"OWASP Top 10 — A03:2021 Injection",
		);
		expect(first).toBe(second);
		expect(second).toBe(third);
	});

	it("produces a different tag for a different category with the identical ruleSource", () => {
		const security = themeTagValue("SECURITY", "Some Rule");
		const accessibility = themeTagValue("ACCESSIBILITY", "Some Rule");
		expect(security).not.toBe(accessibility);
	});

	it("produces a different tag for a different ruleSource with the identical category", () => {
		const injection = themeTagValue("SECURITY", "A03:2021 Injection");
		const ssrf = themeTagValue("SECURITY", "A10:2021 SSRF");
		expect(injection).not.toBe(ssrf);
	});
});

describe("themeTagValue — ALLOWED_TAG_PATTERN / MAX_TAG_LENGTH compliance", () => {
	const REALISTIC_RULE_SOURCES: ReadonlyArray<{
		category: "SECURITY" | "ACCESSIBILITY";
		ruleSource: string;
	}> = [
		{
			category: "ACCESSIBILITY",
			ruleSource: "WCAG 2.1 AA — 1.4.3 Contrast (Minimum)",
		},
		{
			category: "SECURITY",
			ruleSource: "OWASP Top 10 — A03:2021 Injection",
		},
		{
			category: "SECURITY",
			ruleSource:
				"Semgrep: javascript.express.security.audit.xss.mustache-escape.mustache-html-escape",
		},
	];

	for (const { category, ruleSource } of REALISTIC_RULE_SOURCES) {
		it(`matches ALLOWED_TAG_PATTERN and stays <= MAX_TAG_LENGTH for "${ruleSource}"`, () => {
			const tag = themeTagValue(category, ruleSource);
			const parsed = tagValueSchema.safeParse(tag);
			expect(parsed.success).toBe(true);
			expect(tag.length).toBeLessThanOrEqual(50);
		});
	}

	it("hits exactly the documented worst-case length (47 chars) for ACCESSIBILITY + an 18+-char slug", () => {
		// "x".repeat(30) slugifies (lowercase, no non-alnum to collapse) to an
		// 18-char-truncated run of "x"s — this exercises the file header's
		// length-budget math precisely: "theme-"(6) + "accessibility"(13) +
		// "-"(1) + slug(18) + "-"(1) + hash(8) = 47.
		const tag = themeTagValue("ACCESSIBILITY", "x".repeat(30));
		expect(tag.length).toBe(47);
		expect(tagValueSchema.safeParse(tag).success).toBe(true);
	});
});

describe("themeTagValue — hash-suffix collision safety", () => {
	it("produces two different tags for two ruleSources sharing an identical 18-char slug prefix", () => {
		// Both strings slugify to the same first 18 characters (18 "a"s), since
		// slugify() truncates to 18 chars BEFORE any hyphen-collapsing from the
		// differing suffix text can affect the shared prefix. Without the hash
		// suffix these two themes would collide onto the identical tag.
		const sharedPrefix = "a".repeat(18);
		const ruleSourceA = `${sharedPrefix}-variant-one-of-the-rule`;
		const ruleSourceB = `${sharedPrefix}-variant-two-of-the-rule`;

		const tagA = themeTagValue("SECURITY", ruleSourceA);
		const tagB = themeTagValue("SECURITY", ruleSourceB);

		// Sanity-check the premise: both tags really do share the identical
		// "theme-security-" + 18-char-slug prefix baked in (not a vacuous pass
		// because the slugs happened to differ already).
		const prefixLength = "theme-security-".length + 18;
		expect(tagA.slice(0, prefixLength)).toBe(tagB.slice(0, prefixLength));

		// The whole point of the hash suffix: despite the identical prefix, the
		// full tag values differ.
		expect(tagA).not.toBe(tagB);
	});
});

describe("fixed tag constants", () => {
	it("PREREQUISITE_ACCESS_TAG is valid per tagValueSchema", () => {
		const parsed = tagValueSchema.safeParse(PREREQUISITE_ACCESS_TAG);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			// tagValueSchema normalizes (trim + lowercase) — a constant that's
			// already normalized must round-trip unchanged.
			expect(parsed.data).toBe(PREREQUISITE_ACCESS_TAG);
		}
	});

	it("NEEDS_RULE_REVIEW_TAG is valid per tagValueSchema", () => {
		const parsed = tagValueSchema.safeParse(NEEDS_RULE_REVIEW_TAG);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data).toBe(NEEDS_RULE_REVIEW_TAG);
		}
	});
});
