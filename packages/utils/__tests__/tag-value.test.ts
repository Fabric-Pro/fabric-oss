import { describe, expect, it } from "vitest";
import {
	MAX_TAG_LENGTH,
	MAX_TAGS_PER_STORY,
	normalizeTagValue,
	tagValueSchema,
} from "../lib/tag-value";

describe("normalizeTagValue", () => {
	it("trims and lowercases", () => {
		expect(normalizeTagValue("  API Gateway  ")).toBe("api gateway");
	});
});

describe("tagValueSchema", () => {
	it("accepts a valid tag and returns it normalized", () => {
		const r = tagValueSchema.safeParse("  Scope-A (v2)/beta  ");
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data).toBe("scope-a (v2)/beta");
		}
	});

	it("rejects empty / whitespace-only", () => {
		expect(tagValueSchema.safeParse("   ").success).toBe(false);
		expect(tagValueSchema.safeParse("").success).toBe(false);
	});

	it("rejects > MAX_TAG_LENGTH chars (after trim)", () => {
		expect(
			tagValueSchema.safeParse("a".repeat(MAX_TAG_LENGTH + 1)).success,
		).toBe(false);
		expect(
			tagValueSchema.safeParse("a".repeat(MAX_TAG_LENGTH)).success,
		).toBe(true);
	});

	it("rejects commas", () => {
		expect(tagValueSchema.safeParse("a,b").success).toBe(false);
	});

	it("rejects characters outside the allowed set", () => {
		expect(tagValueSchema.safeParse("bad#tag").success).toBe(false);
		expect(tagValueSchema.safeParse("bad@tag").success).toBe(false);
	});

	it("exposes the 20-tag cap constant", () => {
		expect(MAX_TAGS_PER_STORY).toBe(20);
	});
});
