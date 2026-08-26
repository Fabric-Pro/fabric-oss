import { describe, expect, it } from "vitest";
import { shouldLoadAnalytics } from "./should-load-analytics";

describe("shouldLoadAnalytics", () => {
	it("loads when consented and not an embed", () => {
		expect(shouldLoadAnalytics(true, false)).toBe(true);
	});

	it("never loads on an embed route, even with consent", () => {
		expect(shouldLoadAnalytics(true, true)).toBe(false);
	});

	it("does not load without consent", () => {
		expect(shouldLoadAnalytics(false, false)).toBe(false);
		expect(shouldLoadAnalytics(false, true)).toBe(false);
	});
});
