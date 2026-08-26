/**
 * Validation contract for the shared automation-link inputs.
 *
 * Tested against the schema directly: the procedure handler tests stub the oRPC
 * chain, so `.input(...)` never runs there and these rules would otherwise go
 * unexercised.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { automationInputFields } from "../automation-input";

const schema = z.object(automationInputFields);

describe("automationInputFields", () => {
	it("accepts a full automation link", () => {
		const parsed = schema.parse({
			automationRef: "login.spec.ts > signs in",
			automationFilePath: "apps/web/tests/e2e/login.spec.ts",
			automationExternalUrl: "https://ci.example.com/run/1",
		});
		expect(parsed.automationRef).toBe("login.spec.ts > signs in");
		expect(parsed.automationExternalUrl).toBe(
			"https://ci.example.com/run/1",
		);
	});

	it("accepts an entirely absent link (every field optional)", () => {
		expect(schema.parse({})).toEqual({});
	});

	it("rejects a malformed external URL", () => {
		expect(() =>
			schema.parse({ automationExternalUrl: "not-a-url" }),
		).toThrow();
	});

	// The stored URL is rendered as an `href`. Zod's `.url()` alone defers to the
	// URL parser, which accepts ANY scheme — so these would persist and become a
	// stored-XSS sink. The editor refuses them too, but the client is not the
	// boundary: an API caller reaches this schema directly.
	it.each([
		"javascript:alert(1)",
		"JaVaScRiPt:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"vbscript:msgbox(1)",
		"file:///etc/passwd",
	])("rejects the non-http(s) external URL scheme %s", (url) => {
		expect(() => schema.parse({ automationExternalUrl: url })).toThrow();
	});

	it.each(["http://ci.example.com/run/42", "https://ci.example.com/run/42"])(
		"accepts the http(s) external URL %s",
		(url) => {
			expect(() =>
				schema.parse({ automationExternalUrl: url }),
			).not.toThrow();
		},
	);

	it.each([
		["empty string", ""],
		["explicit null", null],
	])("allows clearing the external URL via %s", (_label, value) => {
		expect(() =>
			schema.parse({ automationExternalUrl: value }),
		).not.toThrow();
	});

	it.each([
		["empty string", ""],
		["explicit null", null],
	])("allows clearing the ref via %s", (_label, value) => {
		expect(() => schema.parse({ automationRef: value })).not.toThrow();
	});

	it("caps ref / file path / URL length", () => {
		expect(() =>
			schema.parse({ automationRef: "a".repeat(501) }),
		).toThrow();
		expect(() =>
			schema.parse({ automationFilePath: "a".repeat(1001) }),
		).toThrow();
		expect(() =>
			schema.parse({
				automationExternalUrl: `https://e.co/${"a".repeat(2000)}`,
			}),
		).toThrow();
	});
});
