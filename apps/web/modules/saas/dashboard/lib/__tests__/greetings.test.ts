import { describe, expect, it } from "vitest";
import { DASHBOARD_GREETING_COUNT, getDashboardGreeting } from "../greetings";

describe("getDashboardGreeting", () => {
	it("uses the first name and rotates through greeting variants", () => {
		expect(getDashboardGreeting("Dev Example", 0)).toBe("Hello, Dev! 👋");
		expect(getDashboardGreeting("Dev Example", 1)).toBe("Hey, Dev! 🙋");
		expect(getDashboardGreeting("Dev Example", 17)).toBe(
			"Namaste, Dev! 🪷",
		);
		expect(
			getDashboardGreeting("Dev Example", DASHBOARD_GREETING_COUNT),
		).toBe("Hello, Dev! 👋");
	});

	it("uses a different emoji for every greeting", () => {
		const emojis = Array.from(
			{ length: DASHBOARD_GREETING_COUNT },
			(_, index) => getDashboardGreeting("Dev", index).split(" ").at(-1),
		);
		expect(new Set(emojis).size).toBe(DASHBOARD_GREETING_COUNT);
	});

	it("handles missing and blank names", () => {
		expect(getDashboardGreeting(undefined, 0)).toBe("Hello, there! 👋");
		expect(getDashboardGreeting("   ", 0)).toBe("Hello, there! 👋");
	});
});
