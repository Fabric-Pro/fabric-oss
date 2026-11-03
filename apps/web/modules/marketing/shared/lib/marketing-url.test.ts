import { describe, expect, it } from "vitest";
import { marketingUrl } from "./marketing-url";

const BASE = "https://example.com";

describe("marketingUrl", () => {
	it("gives the home page as the bare origin when i18n is off", () => {
		expect(marketingUrl(BASE, "en", "", false)).toBe(
			"https://example.com/",
		);
	});

	it("drops the locale from marketing and legal paths when i18n is off", () => {
		expect(marketingUrl(BASE, "en", "/changelog", false)).toBe(
			"https://example.com/changelog",
		);
		expect(marketingUrl(BASE, "en", "/legal/terms", false)).toBe(
			"https://example.com/legal/terms",
		);
	});

	it("keeps the locale when i18n is on", () => {
		expect(marketingUrl(BASE, "de", "", true)).toBe(
			"https://example.com/de",
		);
		expect(marketingUrl(BASE, "de", "/changelog", true)).toBe(
			"https://example.com/de/changelog",
		);
	});
});
