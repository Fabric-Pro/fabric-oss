/**
 * Unit tests for the delivery-preferences shared helpers — the webhook URL
 * validation schema (AC-4) and the signing-secret generator.
 */

import { describe, expect, it } from "vitest";
import {
	generateWebhookSecret,
	WEBHOOK_SECRET_PREFIX,
	webhookUrlSchema,
} from "../delivery-preferences";

describe("webhookUrlSchema (AC-4)", () => {
	it("accepts a valid https URL", () => {
		expect(
			webhookUrlSchema.safeParse("https://example.com/hook").success,
		).toBe(true);
	});

	it("accepts a valid http URL (http is permitted by decision)", () => {
		expect(
			webhookUrlSchema.safeParse("http://localhost:4000/hook").success,
		).toBe(true);
	});

	it("rejects a URL with no scheme", () => {
		expect(webhookUrlSchema.safeParse("example.com/hook").success).toBe(
			false,
		);
	});

	it("rejects a non-http(s) scheme", () => {
		expect(webhookUrlSchema.safeParse("ftp://example.com").success).toBe(
			false,
		);
	});

	it("rejects a malformed string", () => {
		expect(webhookUrlSchema.safeParse("not a url").success).toBe(false);
	});

	it("rejects URLs that embed credentials", () => {
		expect(
			webhookUrlSchema.safeParse("https://user:pass@example.com/hook")
				.success,
		).toBe(false);
	});
});

describe("generateWebhookSecret", () => {
	it("returns a prefixed, non-trivial secret", () => {
		const secret = generateWebhookSecret();
		expect(secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
		expect(secret.length).toBeGreaterThan(
			WEBHOOK_SECRET_PREFIX.length + 20,
		);
	});

	it("returns a different secret each call", () => {
		expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
	});
});
