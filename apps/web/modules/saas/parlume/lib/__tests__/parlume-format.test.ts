import { describe, expect, it } from "vitest";
import { formatCost } from "../parlume-format";

describe("formatCost", () => {
	it("shows exactly zero as $0.00", () => {
		expect(formatCost(0)).toBe("$0.00");
	});

	it("never shows a negative amount", () => {
		expect(formatCost(-250)).toBe("$0.00");
	});

	it("floors anything above zero and below a cent at < $0.01", () => {
		expect(formatCost(1)).toBe("< $0.01");
		expect(formatCost(5_000)).toBe("< $0.01");
		expect(formatCost(9_999)).toBe("< $0.01");
	});

	it("shows a whole cent from one cent up", () => {
		expect(formatCost(10_000)).toBe("$0.01");
		expect(formatCost(12_300)).toBe("$0.01");
	});

	it("rounds to the nearest cent", () => {
		expect(formatCost(14_900)).toBe("$0.01");
		expect(formatCost(15_000)).toBe("$0.02");
		expect(formatCost(2_345_678)).toBe("$2.35");
		expect(formatCost(4_996_000)).toBe("$5.00");
	});

	it("separates thousands", () => {
		expect(formatCost(1_234_567_890)).toBe("$1,234.57");
	});
});
