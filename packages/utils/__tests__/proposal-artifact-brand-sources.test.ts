import { describe, expect, it } from "vitest";
import {
	BRAND_FETCH_JOIN_WINDOW_MS,
	BRAND_FETCH_RUNNING_TTL_MS,
	brandAlternatives,
	effectiveBrandFetchAttempt,
	isBrandWebsite,
	isBrandWebsiteHost,
	isJoinableBrandFetchAttempt,
	isOrganizationFontKey,
	isOrganizationHeroKey,
	isRecipientSuggestedLogoKey,
	neutralizeBrandName,
	organizationBrandAssetId,
	organizationBrandPrefix,
} from "../lib/proposal-artifact/brand-sources";

describe("organization brand keys", () => {
	it("refuses an empty organization id instead of sharing one prefix", () => {
		expect(() => organizationBrandPrefix("")).toThrow();
	});

	it("accepts only the promoted shape of its own kind and organization", () => {
		expect(
			isOrganizationHeroKey(
				"org-1",
				"organization-brand/org-1/hero/abc_1-2.png",
			),
		).toBe(true);
		expect(
			isOrganizationHeroKey(
				"org-1",
				"organization-brand/org-1/hero/abc.jpg",
			),
		).toBe(true);
		expect(
			isOrganizationFontKey(
				"org-1",
				"organization-brand/org-1/fonts/abc.woff2",
			),
		).toBe(true);
		expect(
			isOrganizationFontKey(
				"org-1",
				"organization-brand/org-1/fonts/abc.ttf",
			),
		).toBe(true);

		for (const key of [
			"organization-brand/org-1/pending/abc.png",
			"organization-brand/org-2/hero/abc.png",
			"organization-brand/org-1/hero/nested/abc.png",
			"organization-brand/org-1/hero/../abc.png",
			"organization-brand/org-1/hero/abc.woff2",
			"organization-brand/org-1/hero/.png",
			"organization-brand/org-1/hero/abc.svg",
			"organization-brand/org-1/fonts/abc.otf",
		]) {
			expect(
				isOrganizationHeroKey("org-1", key) ||
					isOrganizationFontKey("org-1", key),
			).toBe(false);
		}
		expect(
			isOrganizationHeroKey("", "organization-brand//hero/a.png"),
		).toBe(false);
		expect(isOrganizationHeroKey("org-1", null)).toBe(false);
	});

	it("names the id inside a key, never the key", () => {
		expect(
			organizationBrandAssetId(
				"org-1",
				"fonts",
				"organization-brand/org-1/fonts/file-id.woff2",
			),
		).toBe("file-id");
	});

	it("pins a suggested recipient logo to its own project", () => {
		expect(
			isRecipientSuggestedLogoKey(
				"p1",
				"project-brand/p1/recipient-brand/suggested/req-1.png",
			),
		).toBe(true);
		expect(
			isRecipientSuggestedLogoKey(
				"p1",
				"project-brand/p2/recipient-brand/suggested/req-1.png",
			),
		).toBe(false);
		expect(
			isRecipientSuggestedLogoKey(
				"p1",
				"project-brand/p1/recipient-brand/current/req-1.png",
			),
		).toBe(false);
	});
});

describe("effectiveBrandFetchAttempt", () => {
	const now = new Date("2026-10-22T12:00:00Z");

	it("reads a long-running attempt as timed out", () => {
		const requestedAt = new Date(
			now.getTime() - BRAND_FETCH_RUNNING_TTL_MS - 1,
		);
		expect(
			effectiveBrandFetchAttempt(
				{ status: "RUNNING", failureCode: null, requestedAt },
				now,
			),
		).toEqual({ status: "FAILED", failureCode: "timed_out" });
	});

	it("keeps a recent RUNNING attempt and a stored failure code", () => {
		expect(
			effectiveBrandFetchAttempt(
				{ status: "RUNNING", failureCode: null, requestedAt: now },
				now,
			),
		).toEqual({ status: "RUNNING", failureCode: null });
		expect(
			effectiveBrandFetchAttempt(
				{ status: "FAILED", failureCode: "blocked", requestedAt: now },
				now,
			),
		).toEqual({ status: "FAILED", failureCode: "blocked" });
	});

	it("never passes through a status or code it does not know", () => {
		expect(
			effectiveBrandFetchAttempt(
				{ status: "WEIRD", failureCode: "<b>", requestedAt: now },
				now,
			),
		).toEqual({ status: "FAILED", failureCode: "failed" });
	});
});

describe("isJoinableBrandFetchAttempt", () => {
	const now = new Date("2026-10-22T12:00:00Z");
	const website = "https://example.com";
	const running = (ageMs: number, overrides: object = {}) => ({
		website,
		status: "RUNNING",
		requestedAt: new Date(now.getTime() - ageMs),
		...overrides,
	});

	it("joins the same website's attempt running inside the window", () => {
		expect(isJoinableBrandFetchAttempt(running(0), website, now)).toBe(
			true,
		);
		expect(
			isJoinableBrandFetchAttempt(
				running(BRAND_FETCH_JOIN_WINDOW_MS - 1),
				website,
				now,
			),
		).toBe(true);
		// One that started a moment after this request's clock still joins.
		expect(isJoinableBrandFetchAttempt(running(-5), website, now)).toBe(
			true,
		);
	});

	it("starts at the window, for another website, after a finish or with none", () => {
		expect(
			isJoinableBrandFetchAttempt(
				running(BRAND_FETCH_JOIN_WINDOW_MS),
				website,
				now,
			),
		).toBe(false);
		expect(
			isJoinableBrandFetchAttempt(
				running(0, { website: "https://example.net" }),
				website,
				now,
			),
		).toBe(false);
		for (const status of ["SUCCEEDED", "FAILED"]) {
			expect(
				isJoinableBrandFetchAttempt(
					running(0, { status }),
					website,
					now,
				),
			).toBe(false);
		}
		expect(isJoinableBrandFetchAttempt(null, website, now)).toBe(false);
	});
});

describe("brand website shape", () => {
	it.each([
		"https://example.com",
		"https://www.example-site.example",
		"https://xn--bcher-kva.example",
	])("accepts %j", (website) => {
		expect(isBrandWebsite(website)).toBe(true);
	});

	it.each([
		"https://my_site.example.com",
		"https://[2001:db8::1]",
		"https://192.0.2.10",
		"https://Example.com",
		"https://example.com/",
		"https://example.com/about",
		"https://example.com:8443",
		"http://example.com",
		"https://bücher.example",
		"https://0x7f.1",
		"",
		null,
	])("refuses %j", (website) => {
		expect(isBrandWebsite(website)).toBe(false);
	});

	it("reads hosts as the URL parser writes them", () => {
		expect(isBrandWebsiteHost("xn--bcher-kva.example")).toBe(true);
		expect(isBrandWebsiteHost("my_site.example.com")).toBe(false);
		expect(isBrandWebsiteHost("[2001:db8::1]")).toBe(false);
		expect(isBrandWebsiteHost("192.0.2.10")).toBe(false);
	});
});

describe("brandAlternatives", () => {
	it("offers nothing when every source agrees or holds nothing", () => {
		expect(
			brandAlternatives({ source: "MANUAL", value: "#1f4e79" }, [
				{ source: "BRAND_KIT", value: "#1f4e79" },
				{ source: "VENDOR_SITE", value: null },
			]),
		).toEqual([]);
	});

	it("offers each differing grounded value once, in precedence order", () => {
		expect(
			brandAlternatives({ source: "MANUAL", value: "#111111" }, [
				{ source: "BRAND_KIT", value: "#1f4e79" },
				{ source: "VENDOR_SITE", value: "#1f4e79" },
				{ source: "DEFAULT", value: "#334155" },
			]),
		).toEqual([
			{ source: "BRAND_KIT", value: "#1f4e79" },
			{ source: "DEFAULT", value: "#334155" },
		]);
	});

	it("treats an empty list as holding nothing", () => {
		expect(
			brandAlternatives({ source: "MANUAL", value: ["#111111"] }, [
				{ source: "BRAND_KIT", value: [] },
			]),
		).toEqual([]);
	});
});

describe("neutralizeBrandName", () => {
	it("removes controls, bidi and zero-width characters and collapses whitespace", () => {
		expect(neutralizeBrandName("  Example‮ Client​\nCo\u0007  ")).toBe(
			"Example Client Co",
		);
	});

	it("caps the length and turns an empty result into null", () => {
		expect(neutralizeBrandName("x".repeat(500))).toHaveLength(200);
		expect(neutralizeBrandName("​ \n")).toBeNull();
		expect(neutralizeBrandName(42)).toBeNull();
	});

	it("caps at 200 UTF-16 units without splitting an astral character", () => {
		const astral = "\u{1F600}";
		// 199 units then a pair: the pair would end at 201, so it goes.
		expect(neutralizeBrandName(`${"x".repeat(199)}${astral}`)).toBe(
			"x".repeat(199),
		);
		// 198 units then a pair: it ends exactly at 200 and stays.
		expect(neutralizeBrandName(`${"x".repeat(198)}${astral}tail`)).toBe(
			`${"x".repeat(198)}${astral}`,
		);
		expect(neutralizeBrandName(astral.repeat(150))).toBe(
			astral.repeat(100),
		);
	});

	it("removes tag characters and variation selectors inside a word", () => {
		const tags = Array.from("hidden", (letter) =>
			String.fromCodePoint(0xe0000 + letter.charCodeAt(0)),
		).join("");
		expect(
			neutralizeBrandName(
				`Exa\u{E0001}${tags}mple\u{E007F} Cli\uFE0Fent\u{E0100} Co\uFE00`,
			),
		).toBe("Example Client Co");
		expect(neutralizeBrandName(`\u{E0001}${tags}\uFE0F`)).toBeNull();
	});

	it("caps at 200 UTF-16 units without splitting an astral character", () => {
		const astral = "\u{1F600}";
		// 199 units then a pair: the pair would end at 201, so it goes.
		expect(neutralizeBrandName(`${"x".repeat(199)}${astral}`)).toBe(
			"x".repeat(199),
		);
		// 198 units then a pair: it ends exactly at 200 and stays.
		expect(neutralizeBrandName(`${"x".repeat(198)}${astral}tail`)).toBe(
			`${"x".repeat(198)}${astral}`,
		);
		const allAstral = neutralizeBrandName(astral.repeat(150)) ?? "";
		expect(allAstral).toHaveLength(200);
		expect(allAstral).toBe(astral.repeat(100));
		expect(allAstral.length).toBeLessThanOrEqual(200);
	});

	it("removes tag characters and variation selectors inside a word", () => {
		const tags = Array.from("hidden", (letter) =>
			String.fromCodePoint(0xe0000 + letter.charCodeAt(0)),
		).join("");
		expect(
			neutralizeBrandName(
				`Exa\u{E0001}${tags}mple\u{E007F} Cli\uFE0Fent\u{E0100} Co\uFE00`,
			),
		).toBe("Example Client Co");
		expect(neutralizeBrandName(`\u{E0001}${tags}\uFE0F`)).toBeNull();
	});
});
