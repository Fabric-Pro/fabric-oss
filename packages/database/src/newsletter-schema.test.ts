import { describe, expect, it } from "vitest";
import {
	coerceDeliveryDestination,
	coerceDetailLevel,
	DEFAULT_NEWSLETTER_DELIVERY_DESTINATION,
	DEFAULT_NEWSLETTER_DETAIL_LEVEL,
	NEWSLETTER_CHAT_PLATFORMS,
	NEWSLETTER_DELIVERY_DESTINATIONS,
	NEWSLETTER_DETAIL_LEVELS,
	NEWSLETTER_SCHEMA_VERSION,
	NEWSLETTER_SKIP_REASONS,
	newsletterChatChannelSchema,
	newsletterContentSchema,
	newsletterHighlightSchema,
} from "./newsletter-schema";

describe("newsletterContentSchema", () => {
	it("exposes schema version 1", () => {
		expect(NEWSLETTER_SCHEMA_VERSION).toBe(1);
	});

	it("accepts a curated payload with highlights", () => {
		const parsed = newsletterContentSchema.safeParse({
			schemaVersion: 1,
			headline: "June product update",
			intro: "Here is what shipped.",
			hasMajorFeatures: true,
			highlights: [
				{
					title: "New dashboard",
					description: "Redesigned home.",
					prUrl: "https://x/pr/1",
				},
			],
		});
		expect(parsed.success).toBe(true);
	});

	it("accepts an empty (skipped) payload", () => {
		const parsed = newsletterContentSchema.safeParse({
			schemaVersion: 1,
			headline: "",
			intro: "",
			hasMajorFeatures: false,
			highlights: [],
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects an unknown schemaVersion", () => {
		const parsed = newsletterContentSchema.safeParse({
			schemaVersion: 2,
			headline: "x",
			intro: "y",
			hasMajorFeatures: true,
			highlights: [],
		});
		expect(parsed.success).toBe(false);
	});
});

it("accepts optional releaseTag and repoFullName", () => {
	const parsed = newsletterHighlightSchema.parse({
		title: "Feature",
		description: "Did a thing",
		prUrl: "https://github.com/acme/web/releases/tag/v1.2.0",
		releaseTag: "v1.2.0",
		repoFullName: "acme/web",
	});
	expect(parsed.releaseTag).toBe("v1.2.0");
	expect(parsed.repoFullName).toBe("acme/web");
});

it("still parses legacy highlights without release metadata", () => {
	const parsed = newsletterHighlightSchema.parse({
		title: "Feature",
		description: "Did a thing",
	});
	expect(parsed.releaseTag).toBeUndefined();
	expect(parsed.repoFullName).toBeUndefined();
});

describe("newsletter detail level", () => {
	it("default is STANDARD and is a member of the tier list", () => {
		expect(DEFAULT_NEWSLETTER_DETAIL_LEVEL).toBe("STANDARD");
		expect(NEWSLETTER_DETAIL_LEVELS).toContain("STANDARD");
	});

	it("coerceDetailLevel passes through valid tiers", () => {
		expect(coerceDetailLevel("BRIEF")).toBe("BRIEF");
		expect(coerceDetailLevel("STANDARD")).toBe("STANDARD");
		expect(coerceDetailLevel("DETAILED")).toBe("DETAILED");
	});

	it("coerceDetailLevel maps unknown/invalid/nullish to the default", () => {
		expect(coerceDetailLevel(undefined)).toBe("STANDARD");
		expect(coerceDetailLevel(null)).toBe("STANDARD");
		expect(coerceDetailLevel("")).toBe("STANDARD");
		expect(coerceDetailLevel("brief")).toBe("STANDARD"); // case-sensitive
		expect(coerceDetailLevel("VERBOSE")).toBe("STANDARD");
		expect(coerceDetailLevel(42)).toBe("STANDARD");
	});
});

describe("newsletter delivery destination", () => {
	it("default is EMAIL and is a member of the destination list", () => {
		expect(DEFAULT_NEWSLETTER_DELIVERY_DESTINATION).toBe("EMAIL");
		expect(NEWSLETTER_DELIVERY_DESTINATIONS).toContain("EMAIL");
		expect(NEWSLETTER_DELIVERY_DESTINATIONS).toEqual([
			"EMAIL",
			"CHAT",
			"BOTH",
		]);
	});

	it("coerceDeliveryDestination passes through valid values", () => {
		expect(coerceDeliveryDestination("EMAIL")).toBe("EMAIL");
		expect(coerceDeliveryDestination("CHAT")).toBe("CHAT");
		expect(coerceDeliveryDestination("BOTH")).toBe("BOTH");
	});

	it("coerceDeliveryDestination maps unknown/nullish to EMAIL", () => {
		expect(coerceDeliveryDestination(undefined)).toBe("EMAIL");
		expect(coerceDeliveryDestination(null)).toBe("EMAIL");
		expect(coerceDeliveryDestination("")).toBe("EMAIL");
		expect(coerceDeliveryDestination("chat")).toBe("EMAIL"); // case-sensitive
		expect(coerceDeliveryDestination("SMS")).toBe("EMAIL");
		expect(coerceDeliveryDestination(7)).toBe("EMAIL");
	});

	it("NO_CHAT_TARGETS is a valid skip reason", () => {
		expect(NEWSLETTER_SKIP_REASONS).toContain("NO_CHAT_TARGETS");
	});
});

describe("newsletterChatChannelSchema", () => {
	it("accepts a valid Teams/Slack target", () => {
		const r = newsletterChatChannelSchema.parse({
			platform: "TEAMS",
			teamId: "t1",
			channelId: "c1",
			channelName: "General",
		});
		expect(r.platform).toBe("TEAMS");
		expect(NEWSLETTER_CHAT_PLATFORMS).toContain(r.platform);
	});
	it("rejects an unknown platform", () => {
		expect(() =>
			newsletterChatChannelSchema.parse({
				platform: "DISCORD",
				teamId: "t1",
				channelId: "c1",
			}),
		).toThrow();
	});
	it("rejects empty ids", () => {
		expect(() =>
			newsletterChatChannelSchema.parse({
				platform: "SLACK",
				teamId: "",
				channelId: "c1",
			}),
		).toThrow();
	});
});
