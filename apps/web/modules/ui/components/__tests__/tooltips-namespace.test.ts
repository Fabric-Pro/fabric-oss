import en from "@repo/i18n/translations/en.json";
import { describe, expect, it } from "vitest";
import type { DestructiveTooltipCopy } from "../destructive-tooltip";

type TooltipValue = string | DestructiveTooltipCopy;

function isDestructive(value: unknown): value is DestructiveTooltipCopy {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		"label" in value &&
		"warning" in value
	);
}

type TooltipEntry = {
	path: string;
	value: TooltipValue;
};

function collectTooltipEntries(
	node: unknown,
	prefix: string,
	out: TooltipEntry[],
): void {
	if (typeof node !== "object" || node === null) {
		return;
	}
	if (isDestructive(node)) {
		out.push({ path: prefix, value: node });
		return;
	}
	for (const [key, child] of Object.entries(node)) {
		const path = `${prefix}.${key}`;
		if (typeof child === "string") {
			out.push({ path, value: child });
		} else if (typeof child === "object" && child !== null) {
			collectTooltipEntries(child, path, out);
		}
	}
}

const tooltipEntries: TooltipEntry[] = (() => {
	const out: TooltipEntry[] = [];
	collectTooltipEntries(en.tooltips, "tooltips", out);
	return out;
})();

describe("tooltips.* namespace (en.json)", () => {
	it("namespace exists and has at least one bucket", () => {
		expect(en).toHaveProperty("tooltips");
		expect(Object.keys(en.tooltips).length).toBeGreaterThan(0);
	});

	it("collects at least one entry", () => {
		expect(tooltipEntries.length).toBeGreaterThan(0);
	});

	describe("destructive entries", () => {
		const destructive = tooltipEntries.filter(
			(entry): entry is { path: string; value: DestructiveTooltipCopy } =>
				isDestructive(entry.value),
		);

		it("has at least one destructive entry", () => {
			expect(destructive.length).toBeGreaterThan(0);
		});

		it.each(destructive)(
			"%s has a non-empty string `label`",
			({ value }) => {
				expect(typeof value.label).toBe("string");
				expect(value.label.length).toBeGreaterThan(0);
			},
		);

		it.each(destructive)(
			"%s has a non-empty string `warning`",
			({ value }) => {
				expect(typeof value.warning).toBe("string");
				expect(value.warning.length).toBeGreaterThan(0);
			},
		);

		it.each(destructive)(
			'%s `warning` starts with "Warning: "',
			({ value }) => {
				expect(value.warning.startsWith("Warning: ")).toBe(true);
			},
		);
	});

	describe("informational entries", () => {
		const informational = tooltipEntries.filter(
			(entry): entry is { path: string; value: string } =>
				typeof entry.value === "string",
		);

		it("has at least one informational entry", () => {
			expect(informational.length).toBeGreaterThan(0);
		});

		it.each(informational)("%s is a non-empty string", ({ value }) => {
			expect(typeof value).toBe("string");
			expect(value.length).toBeGreaterThan(0);
		});
	});
});
