import { describe, expect, it } from "vitest";
import { PublishingTopicPostType } from "../../prisma/generated/client";
import {
	POST_TYPE_LABELS,
	PublishingTopicSuggestionsSchema,
	postTypeLabelToEnum,
} from "../publishing-suite-schema";

describe("Publishing Suite 1B schema", () => {
	it("exposes the post-type enum values", () => {
		// The generated enum, pinned against a hand-written list on purpose: it
		// is the one place a value added to `schema.prisma` without its
		// migration, or vice versa, shows up as a disagreement rather than as a
		// runtime error in whichever environment ran the other half.
		expect(Object.values(PublishingTopicPostType).sort()).toEqual(
			[
				"BLOG_POST",
				"CASE_STUDY",
				"LINKEDIN_POST",
				"NEWSLETTER_BLURB",
				"STAKEHOLDER_EMAIL",
				"TWEET",
				"WEBINAR_SCRIPT",
			].sort(),
		);
	});
});

describe("post-type label <-> enum", () => {
	it("maps every label to a distinct enum value", () => {
		const enums = POST_TYPE_LABELS.map(postTypeLabelToEnum);
		expect(new Set(enums).size).toBe(POST_TYPE_LABELS.length);
		expect(postTypeLabelToEnum("Blog Post")).toBe(
			PublishingTopicPostType.BLOG_POST,
		);
		expect(postTypeLabelToEnum("Stakeholder Email")).toBe(
			PublishingTopicPostType.STAKEHOLDER_EMAIL,
		);
	});

	it("rejects a post-type label outside the whitelist (fail-closed)", () => {
		const bad = PublishingTopicSuggestionsSchema.safeParse({
			topics: [
				{
					title: "t",
					pitch: "p",
					provenance: {},
					suggestedPostTypes: ["LinkedIn"],
				},
			],
		});
		expect(bad.success).toBe(false);
	});

	it("accepts a valid whitelisted post-type array", () => {
		const ok = PublishingTopicSuggestionsSchema.safeParse({
			topics: [
				{
					title: "t",
					pitch: "p",
					provenance: {},
					suggestedPostTypes: ["Tweet", "Case Study"],
				},
			],
		});
		expect(ok.success).toBe(true);
	});
});
