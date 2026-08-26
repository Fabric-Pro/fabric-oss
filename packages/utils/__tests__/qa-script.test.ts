import { describe, expect, it } from "vitest";
import {
	normalizeQaPlaywrightScript,
	parseQaPlaywrightScript,
} from "../lib/qa-script";

describe("QA scripted-run action plans", () => {
	it("normalizes the closed action and locator vocabulary", () => {
		const normalized = normalizeQaPlaywrightScript(
			JSON.stringify({
				version: 1,
				steps: [
					{ action: "goto", path: "/sign-in" },
					{
						action: "fill",
						locator: { by: "label", value: "Email" },
						value: "qa@example.com",
					},
					{
						action: "assertVisible",
						locator: {
							by: "role",
							role: "heading",
							name: "Dashboard",
						},
					},
				],
			}),
		);

		expect(parseQaPlaywrightScript(normalized).steps).toHaveLength(3);
		expect(normalized).not.toContain("module.exports");
	});

	it.each([
		'module.exports = () => fetch("https://evil.test")',
		'{"version":1,"steps":[{"action":"evaluate","code":"process.env"}]}',
		'{"version":1,"steps":[{"action":"goto","path":"https://evil.test"}]}',
		'{"version":1,"steps":[{"action":"goto","path":"//evil.test"}]}',
		'{"version":1,"steps":[]}',
	])(
		"rejects executable, unsupported, off-origin, or empty input",
		(value) => {
			expect(() => parseQaPlaywrightScript(value)).toThrow();
		},
	);
});
