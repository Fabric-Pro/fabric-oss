/**
 * Adversarial tests for the application-log redactor (Fizzy #1234, FR2).
 *
 * The contract under test is a security boundary: nothing matching a secret or
 * PII shape may survive into text handed to an AI model. These tests are
 * written to try to get a secret THROUGH, not to confirm the happy path.
 */
import { describe, expect, it } from "vitest";
import {
	MAX_ENTRY_MESSAGE_CHARS,
	redactLogEntries,
	redactLogEntry,
	redactLogText,
} from "../lib/log-redaction";

const REDACTED = "[REDACTED]";

/** Assert the needle is gone from the output entirely. */
function expectScrubbed(input: string, needle: string) {
	const { text } = redactLogText(input);
	expect(text).not.toContain(needle);
}

describe("redactLogText — credentials", () => {
	it("removes a JWT anywhere in a line", () => {
		// Assembled at runtime rather than written as one literal: a complete
		// JWT-shaped string in source trips the repo's secret scanners, and a
		// test fixture is not a good reason to teach them to ignore the shape.
		const jwt = [
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
			"eyJzdWIiOiJzeW50aGV0aWMtdGVzdC1zdWJqZWN0In0",
			"c3ludGhldGljLXNpZ25hdHVyZS1ub3QtYS1yZWFsLWtleQ",
		].join(".");
		expectScrubbed(`auth failed for ${jwt} on retry`, jwt);
	});

	it("removes an Authorization header value entirely, scheme included", () => {
		const { text } = redactLogText(
			"GET /v1/items Authorization: Bearer sk-abcdef0123456789abcdef",
		);
		expect(text).not.toContain("sk-abcdef0123456789abcdef");
		// The header rule and the key=value rule both fire here. Collapsing
		// leaves ONE placeholder, not a smear that reads as several secrets.
		expect(text.match(/\[REDACTED\]/g)).toHaveLength(1);
		expect(text).toContain("GET /v1/items");
	});

	it("keeps the scheme word when there is no key= prefix to swallow it", () => {
		const { text } = redactLogText(
			"retry with Bearer sk-abcdef0123456789abc",
		);
		expect(text).not.toContain("sk-abcdef0123456789abc");
		expect(text).toContain("Bearer");
	});

	it("removes vendor token shapes", () => {
		expectScrubbed(
			"push rejected token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
			"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
		);
		expectScrubbed(
			"slack call failed xoxb-1234567890-abcdefghij",
			"xoxb-1234567890-abcdefghij",
		);
		expectScrubbed(
			"creds AKIAIOSFODNN7EXAMPLE used",
			"AKIAIOSFODNN7EXAMPLE",
		);
	});

	it("removes a PEM private key block spanning many lines", () => {
		const pem = [
			"-----BEGIN RSA PRIVATE KEY-----",
			"MIIEowIBAAKCAQEAx4fmoJ2s0Zr8kQ3vN1TzL9wYcB7dEfGhIjKlMnOpQrStUvWxYz",
			"AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl",
			"-----END RSA PRIVATE KEY-----",
		].join("\n");
		const { text } = redactLogText(`startup failed:\n${pem}\nretrying`);
		expect(text).not.toContain("MIIEowIBAAKCAQEA");
		expect(text).not.toContain("BEGIN RSA PRIVATE KEY");
		expect(text).toContain("retrying");
	});

	it("removes the secret half of a connection string", () => {
		const { text } = redactLogText(
			"Server=db.internal;Database=app;User Id=svc;Password=S3cr3t!Value;Encrypt=true",
		);
		expect(text).not.toContain("S3cr3t!Value");
		// The non-secret parts stay legible or the log is useless.
		expect(text).toContain("Database=app");
	});

	it("removes the password from a URL but keeps host and user", () => {
		const { text } = redactLogText(
			"connect postgres://svcuser:hunter2pass@db.invalid:5432/app failed",
		);
		expect(text).not.toContain("hunter2pass");
		expect(text).toContain("svcuser");
		expect(text).toContain("db.invalid");
	});

	it("removes a query-string signature", () => {
		expectScrubbed(
			"blob GET /c/f.txt?sv=2021-08-06&sig=aB3dEf5GhI7jKl9mN0pQrS%3D&se=x",
			"aB3dEf5GhI7jKl9mN0pQrS",
		);
	});

	it("removes a JSON-shaped secret", () => {
		expectScrubbed(
			'request body {"clientSecret": "abc123XYZsecretvalue", "id": 7}',
			"abc123XYZsecretvalue",
		);
	});

	// Regression: the first implementation anchored each keyword with
	// `\b(password|token|...)\b`. In JS, `\b` never fires between two word
	// characters, so every COMPOUND identifier — the normal shape of a real
	// env var or field name — slipped through while a bare `password=` was
	// caught. Verified leaking before the fix.
	it.each([
		[
			"AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLE",
			"wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLE",
		],
		["DB_PASSWORD=Cor3ctH0rseBatteryStaple", "Cor3ctH0rseBatteryStaple"],
		["dbPassword=hunter2VerySecret", "hunter2VerySecret"],
		["sessionToken=zk29fjaslkQWE9012", "zk29fjaslkQWE9012"],
		["JWT_SECRET=myapp_signing_key_value", "myapp_signing_key_value"],
		[
			"private_key=MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKc",
			"MIIEvQIBADANBgkqhkiG9w0BAQEF",
		],
		["x-api-key: abcdefSECRET12345", "abcdefSECRET12345"],
		["STRIPE_API_KEY=sk_live_abcdefghijklmnop", "sk_live_abcdefghijklmnop"],
	])("redacts the compound identifier %s", (line, secret) => {
		expectScrubbed(line, secret);
	});

	// Short identifiers that name a secret in full but cannot be denylist
	// SUBSTRINGS, because they occur inside ordinary words (`sig` in
	// "assigned", `auth` in "author", `sas` in "phrases").
	it.each([
		[
			"blob?sv=2021-08-06&sig=aB3dEf5GhI7jKl9mN0pQrS",
			"aB3dEf5GhI7jKl9mN0pQrS",
		],
		["AccountKey=abcdEFGHijkl0123456789", "abcdEFGHijkl0123456789"],
		["pwd=Tr0ub4dor&3xample", "Tr0ub4dor"],
	])("redacts the short secret identifier in %s", (line, secret) => {
		expectScrubbed(line, secret);
	});

	it("leaves an ordinary non-secret assignment alone", () => {
		const { text, redactionCount } = redactLogText(
			"NODE_ENV=production region=eu-west-1 attempt=3",
		);
		expect(text).toBe("NODE_ENV=production region=eu-west-1 attempt=3");
		expect(redactionCount).toBe(0);
	});

	it("does not redact words that merely CONTAIN a short secret name", () => {
		const { text, redactionCount } = redactLogText(
			"assigned=alice design=v2 author=bob phrases=3",
		);
		expect(text).toBe("assigned=alice design=v2 author=bob phrases=3");
		expect(redactionCount).toBe(0);
	});

	it("consumes a quoted secret whole when it contains an escaped quote", () => {
		// The non-escape-aware `"[^"]*"` stopped at the escaped quote and left
		// the tail of the secret in cleartext next to the placeholder.
		const { text } = redactLogText('{"clientSecret":"abc\\"def"}');
		expect(text).not.toContain("def");
	});
});

describe("redactLogText — PII", () => {
	it("removes email addresses", () => {
		expectScrubbed(
			"order failed for buyer.name+tag@example.com retry queued",
			"buyer.name+tag@example.com",
		);
	});

	it("removes a US SSN", () => {
		expectScrubbed("applicant 123-45-6789 rejected", "123-45-6789");
	});

	it("removes a Luhn-valid payment card", () => {
		// Test-vector card number (Visa doc example), not a real account.
		expectScrubbed(
			"charge declined 4111 1111 1111 1111",
			"4111 1111 1111 1111",
		);
	});

	it("leaves a long digit run that is NOT a card alone", () => {
		const { text } = redactLogText("processed 1234567890123456 bytes");
		expect(text).toContain("1234567890123456");
	});

	it("removes a public IP but preserves private and loopback space", () => {
		const { text } = redactLogText(
			"client 203.0.113.42 via gateway 10.1.2.3 and 127.0.0.1 and 192.168.1.7",
		);
		expect(text).not.toContain("203.0.113.42");
		expect(text).toContain("10.1.2.3");
		expect(text).toContain("127.0.0.1");
		expect(text).toContain("192.168.1.7");
	});

	it("does not mistake a version string for an IP", () => {
		const { text } = redactLogText("agent Chrome/120.0.6099.109 connected");
		expect(text).toContain("120.0.6099.109");
	});
});

describe("redactLogText — must not destroy debugging value", () => {
	it("leaves an ordinary stack trace intact", () => {
		const trace = [
			"TypeError: Cannot read properties of undefined (reading 'id')",
			"    at resolveOwner (/app/packages/api/lib/owner.ts:42:17)",
			"    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
		].join("\n");
		const { text, redactionCount } = redactLogText(trace);
		expect(text).toBe(trace);
		expect(redactionCount).toBe(0);
	});

	it("reports zero redactions for benign text", () => {
		const { redactionCount } = redactLogText(
			"cache warm complete in 812ms",
		);
		expect(redactionCount).toBe(0);
	});
});

describe("redactLogEntry", () => {
	it("redacts a sensitive property KEY outright", () => {
		const out = redactLogEntry({
			message: "auth attempt",
			properties: { accessToken: "abc", requestId: "req-1" },
		});
		expect(out?.properties?.accessToken).toBe(REDACTED);
		expect(out?.properties?.requestId).toBe("req-1");
	});

	it("redacts a secret hiding under a benign property key", () => {
		const out = redactLogEntry({
			message: "outbound call",
			properties: { note: "used key AKIAIOSFODNN7EXAMPLE for upload" },
		});
		expect(out?.properties?.note).not.toContain("AKIAIOSFODNN7EXAMPLE");
	});

	it("drops structured property values rather than guessing at them", () => {
		const out = redactLogEntry({
			message: "x",
			properties: { nested: { secret: "s" }, count: 3, ok: true },
		});
		expect(out?.properties).not.toHaveProperty("nested");
		expect(out?.properties?.count).toBe(3);
		expect(out?.properties?.ok).toBe(true);
	});

	it("truncates an oversized message and flags it", () => {
		const out = redactLogEntry({ message: "a".repeat(50_000) });
		expect(out?.message.length).toBe(MAX_ENTRY_MESSAGE_CHARS);
		expect(out?.truncated).toBe(true);
	});

	it("still redacts inside the retained head of a truncated message", () => {
		const out = redactLogEntry({
			message: `token=supersecretvalue123 ${"x".repeat(50_000)}`,
		});
		expect(out?.message).not.toContain("supersecretvalue123");
	});

	it("fails closed on an entry with no string message", () => {
		expect(
			redactLogEntry({ message: undefined as unknown as string }),
		).toBeNull();
		expect(redactLogEntry({ message: 42 as unknown as string })).toBeNull();
	});
});

describe("redactLogEntries", () => {
	it("drops unredactable entries and reports the count rather than hiding it", () => {
		const result = redactLogEntries([
			{ message: "ok one" },
			{ message: null as unknown as string },
			{ message: "ok two" },
		]);
		expect(result.entries).toHaveLength(2);
		expect(result.droppedCount).toBe(1);
	});

	it("totals redactions across the batch", () => {
		const result = redactLogEntries([
			{ message: "mail a@example.com" },
			{ message: "mail b@example.com" },
		]);
		expect(result.redactionCount).toBe(2);
		expect(
			result.entries.every((e) => !e.message.includes("@example.com")),
		).toBe(true);
	});
});
