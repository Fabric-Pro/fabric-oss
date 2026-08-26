import { describe, expect, it } from "vitest";
import {
	getConsentCookieDomain,
	resolveConsentDecision,
	sanitizeReturnTo,
} from "./consent";

describe("resolveConsentDecision", () => {
	it("maps the analytics decision to the customized state", () => {
		expect(resolveConsentDecision("analytics")).toEqual({
			state: "customized",
			preferences: {
				essential: true,
				analytics: true,
				marketing: false,
			},
		});
	});

	it("maps the decline decision to all optional categories off", () => {
		expect(resolveConsentDecision("decline")).toEqual({
			state: "declined",
			preferences: {
				essential: true,
				analytics: false,
				marketing: false,
			},
		});
	});

	it("treats an unknown decision as a decline", () => {
		expect(resolveConsentDecision("something-else")).toEqual(
			resolveConsentDecision("decline"),
		);
	});
});

describe("sanitizeReturnTo", () => {
	it("keeps a same-site path with its query string", () => {
		expect(sanitizeReturnTo("/app/projects?tab=overview")).toBe(
			"/app/projects?tab=overview",
		);
	});

	it.each([
		["//evil.example", "protocol-relative URL"],
		["https://evil.example/app", "absolute URL"],
		["/\\evil.example", "backslash-escaped authority"],
		["app/projects", "path without a leading slash"],
		["", "empty value"],
		[undefined, "missing value"],
		// URL parsing strips ASCII tab, LF and CR before interpreting the
		// rest, so these parse exactly as "//evil.example" does while every
		// prefix check passes them.
		["/\t/evil.example", "tab-smuggled authority"],
		["/\r/evil.example", "carriage-return-smuggled authority"],
		["/\n\n//evil.example", "newline-smuggled authority"],
	])("rejects %s (%s)", (value) => {
		expect(sanitizeReturnTo(value)).toBeNull();
	});
});

describe("getConsentCookieDomain", () => {
	it("shares consent across the Fabric subdomains only", () => {
		expect(getConsentCookieDomain("docs.fabric.pro")).toBe(".fabric.pro");
		expect(getConsentCookieDomain("fabric.pro")).toBe(".fabric.pro");
		expect(getConsentCookieDomain("localhost")).toBeUndefined();
	});
});
