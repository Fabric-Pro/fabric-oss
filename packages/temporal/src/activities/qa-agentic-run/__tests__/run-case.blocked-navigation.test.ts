import { describe, expect, it } from "vitest";
import {
	type BrowserRefusal,
	explainBlockedNavigation,
} from "../browser-driver";

describe("navigation refusal explanations", () => {
	it("has no explanation when no navigation was refused", () => {
		expect(explainBlockedNavigation([])).toBeNull();
		expect(
			explainBlockedNavigation([
				{
					kind: "off-origin",
					url: "https://font.example.com/font.woff2",
					detail: "font",
					isNavigation: false,
				},
			]),
		).toBeNull();
	});
	it.each([
		[
			"off-origin",
			"outside this environment's origin",
			"check the environment's base URL",
		],
		[
			"connection-refused",
			"refused the connection",
			"environment is running",
		],
		["host-not-found", "does not resolve", "environment's base URL"],
		["unsafe-address", "non-public address", "environment configuration"],
		["certificate-invalid", "certificate", "TLS certificate"],
		["tls-failed", "TLS handshake", "TLS configuration"],
		[
			"fetch-failed",
			"environment is down or not reachable",
			"runner's own network",
		],
	] satisfies [BrowserRefusal["kind"], string, string][])(
		"explains %s and names the responsible checks",
		(kind, failure, nextStep) => {
			const explanation = explainBlockedNavigation([
				{
					kind,
					url: "https://app.example.com/",
					detail: "TEST_FAILURE",
					isNavigation: true,
				},
			]);
			expect(explanation).toContain(failure);
			expect(explanation).toContain(nextStep);
		},
	);
	it("uses the latest page navigation rather than a newer resource refusal", () => {
		const explanation = explainBlockedNavigation([
			{
				kind: "connection-refused",
				url: "https://first.example.com/",
				detail: "ECONNREFUSED",
				isNavigation: true,
			},
			{
				kind: "off-origin",
				url: "https://redirect.example.com/next",
				detail: "redirect",
				isNavigation: true,
			},
			{
				kind: "unsafe-address",
				url: "https://font.example.com/font.woff2",
				detail: "font",
				isNavigation: false,
			},
		]);
		expect(explanation).toContain("redirect.example.com");
		expect(explanation).not.toContain("first.example.com");
		expect(explanation).not.toContain("font.example.com");
	});
});
