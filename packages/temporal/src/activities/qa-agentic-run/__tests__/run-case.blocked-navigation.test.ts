/**
 * `net::ERR_BLOCKED_BY_CLIENT` on its own tells a person nothing about which
 * side needs fixing — Fizzy #2232. `blockedNavigationSuffix` is the piece
 * both "Could not open …" sites in `runAgenticCase` share to turn that bare
 * Playwright error into a sentence naming the environment or the runner.
 */

import { describe, expect, it } from "vitest";
import { blockedNavigationSuffix } from "../run-case";

describe("blockedNavigationSuffix", () => {
	it("adds nothing when the failure is not a blocked-by-client one", () => {
		expect(
			blockedNavigationSuffix("net::ERR_CONNECTION_REFUSED", {
				refusals: [
					{
						kind: "off-origin",
						url: "https://other.example.com/",
						detail: "unused",
					},
				],
			}),
		).toBe("");
	});

	it("adds nothing when no refusal was recorded to explain it", () => {
		expect(
			blockedNavigationSuffix(
				"page.goto: net::ERR_BLOCKED_BY_CLIENT at https://app.example.com/",
				{ refusals: [] },
			),
		).toBe("");
	});

	it("names the environment when the most recent refusal is off-origin", () => {
		const suffix = blockedNavigationSuffix(
			"page.goto: net::ERR_BLOCKED_BY_CLIENT at https://app.example.com/",
			{
				refusals: [
					{
						kind: "off-origin",
						url: "https://other.example.com/redirected",
						detail: "unused",
					},
				],
			},
		);
		expect(suffix).toContain("https://other.example.com/redirected");
		expect(suffix).toContain("environment's base URL");
	});

	it("names the runner's own network when the most recent refusal is a fetch failure", () => {
		const suffix = blockedNavigationSuffix(
			"page.goto: net::ERR_BLOCKED_BY_CLIENT at https://app.example.com/",
			{
				refusals: [
					{
						kind: "fetch-failed",
						url: "https://app.example.com/",
						detail: "ECONNRESET",
					},
				],
			},
		);
		expect(suffix).toContain("Fabric's runner could not reach");
		expect(suffix).toContain("not your environment");
	});

	it("uses the LAST refusal when several were recorded", () => {
		const suffix = blockedNavigationSuffix(
			"page.goto: net::ERR_BLOCKED_BY_CLIENT at https://app.example.com/",
			{
				refusals: [
					{
						kind: "off-origin",
						url: "https://first.example.com/",
						detail: "unused",
					},
					{
						kind: "unsafe-address",
						url: "https://app.example.com/",
						detail: "Private network access (10.x.x.x) is not allowed",
					},
				],
			},
		);
		expect(suffix).toContain("non-public address");
		expect(suffix).not.toContain("first.example.com");
	});
});
