import { describe, expect, it } from "vitest";
import {
	describeQaScriptStep,
	expectedForQaScriptStep,
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

/**
 * A `goto`/`assertUrl` step's authored label must never show more than the
 * scripted runner's OWN masking already shows for the runtime URL it reports
 * back (`urlForAssertion` in `run-scripted-case.ts`) — an OAuth/SSO callback
 * routinely puts a live token right in the query.
 */
describe("QA scripted-run step labels — query and fragment masking", () => {
	it("masks goto's query values, keeping the parameter names", () => {
		expect(
			describeQaScriptStep({
				action: "goto",
				path: "/?code=live-secret-2235&state=qa003",
			}),
		).toBe("Go to /?code=…&state=…");
	});

	it("masks assertUrl's query values in both the action and expected labels", () => {
		const step = {
			action: "assertUrl" as const,
			path: "/callback?token=abc123",
		};
		expect(describeQaScriptStep(step)).toBe(
			"Assert URL is /callback?token=…",
		);
		expect(expectedForQaScriptStep(step)).toBe(
			"The page URL is /callback?token=…",
		);
	});

	it("masks a fragment as #…", () => {
		expect(
			describeQaScriptStep({ action: "goto", path: "/docs#section-1" }),
		).toBe("Go to /docs#…");
	});

	it("masks both a query and a fragment on the same path", () => {
		expect(
			describeQaScriptStep({
				action: "goto",
				path: "/callback?code=abc#state",
			}),
		).toBe("Go to /callback?code=…#…");
	});

	it("leaves a path with no query or fragment unchanged", () => {
		expect(
			describeQaScriptStep({ action: "goto", path: "/docs/features" }),
		).toBe("Go to /docs/features");
	});

	it("preserves repeated and multiple parameter names, masking every value", () => {
		expect(
			describeQaScriptStep({
				action: "goto",
				path: "/search?tag=a&tag=b&q=secret",
			}),
		).toBe("Go to /search?tag=…&tag=…&q=…");
	});
});
