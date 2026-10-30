/**
 * Unit tests for `sanitizeMcpErrorMessage`.
 *
 * Pure-function utility — no DB, no IO, no clock. Each rule (secret
 * redaction, email redaction, length cap, benign-text preservation) is
 * asserted independently. Located at
 * `packages/agent-core/__tests__/sanitize-error.test.ts` next to the
 * existing reflection/unified-server suites which the package's
 * vitest config picks up (`include: __tests__/**\/*.test.ts`).
 */

import { describe, expect, it } from "vitest";
import { sanitizeMcpErrorMessage } from "../src/utils/sanitize-error";

describe("sanitizeMcpErrorMessage", () => {
	// -----------------------------------------------------------------------
	// Coercion contract — the helper is total and never throws.
	// -----------------------------------------------------------------------

	describe("input coercion", () => {
		it("turns null into the literal 'unknown error'", () => {
			expect(sanitizeMcpErrorMessage(null)).toBe("unknown error");
		});

		it("turns undefined into the literal 'unknown error'", () => {
			expect(sanitizeMcpErrorMessage(undefined)).toBe("unknown error");
		});

		it("prefixes Error instances with the error name", () => {
			const err = new TypeError("upstream timeout");
			expect(sanitizeMcpErrorMessage(err)).toBe(
				"TypeError: upstream timeout",
			);
		});

		it("returns plain strings unchanged when they contain no sensitive patterns", () => {
			expect(sanitizeMcpErrorMessage("MCP service unreachable")).toBe(
				"MCP service unreachable",
			);
		});

		it("serializes plain objects via JSON.stringify", () => {
			expect(
				sanitizeMcpErrorMessage({ status: 503, reason: "down" }),
			).toBe('{"status":503,"reason":"down"}');
		});

		it("returns 'unknown error' for unserializable inputs (circular refs)", () => {
			const cyclic: Record<string, unknown> = {};
			cyclic.self = cyclic;
			expect(sanitizeMcpErrorMessage(cyclic)).toBe("unknown error");
		});
	});

	// -----------------------------------------------------------------------
	// Rule 1 — strip secrets.
	// -----------------------------------------------------------------------

	describe("secret redaction (rule 1)", () => {
		it("strips `api_key=...` patterns case-insensitively", () => {
			const out = sanitizeMcpErrorMessage(
				new Error("call failed: api_key=sk-abc123 was rejected"),
			);
			expect(out).not.toContain("sk-abc123");
			expect(out).toContain("<redacted>");
		});

		it("strips `API-KEY: ...` (hyphen + colon form, uppercase)", () => {
			const out = sanitizeMcpErrorMessage(
				"upstream said: API-KEY: prod-secret-9z denied",
			);
			expect(out).not.toContain("prod-secret-9z");
			expect(out).toContain("<redacted>");
		});

		it("strips `token=...` patterns", () => {
			expect(
				sanitizeMcpErrorMessage("auth header: token=ghp_rotateme123"),
			).not.toContain("ghp_rotateme123");
		});

		it("strips `secret=...` patterns", () => {
			expect(
				sanitizeMcpErrorMessage("config: secret=shh-supersecret"),
			).not.toContain("shh-supersecret");
		});

		it("strips `password=...` patterns", () => {
			expect(
				sanitizeMcpErrorMessage("db error: password=hunter2 invalid"),
			).not.toContain("hunter2");
		});

		it("strips `bearer:` and `bearer=` token patterns", () => {
			expect(
				sanitizeMcpErrorMessage("auth: bearer=eyJraw.jwt.token denied"),
			).not.toContain("eyJraw.jwt.token");
			expect(
				sanitizeMcpErrorMessage("auth: bearer:eyJraw.jwt.token denied"),
			).not.toContain("eyJraw.jwt.token");
		});

		it("preserves the surrounding error context (replaces the matched span only)", () => {
			const out = sanitizeMcpErrorMessage(
				"connection failed: api_key=AKIA-zzz upstream rejected",
			);
			// Surrounding context kept so a reviewer sees what the failure was.
			expect(out).toContain("connection failed");
			expect(out).toContain("upstream rejected");
			expect(out).toContain("<redacted>");
		});
	});

	// -----------------------------------------------------------------------
	// Rule 2 — strip emails.
	// -----------------------------------------------------------------------

	describe("email redaction (rule 2)", () => {
		it("strips a plain email address", () => {
			const out = sanitizeMcpErrorMessage(
				"user test-user@example.com not found",
			);
			expect(out).not.toContain("test-user@example.com");
			expect(out).toContain("<redacted>");
		});

		it("strips emails inside an Error message", () => {
			const out = sanitizeMcpErrorMessage(
				new Error(
					"permission denied for alice@example.com on resource X",
				),
			);
			expect(out).not.toContain("alice@example.com");
			expect(out).toContain("permission denied for <redacted>");
		});

		it("strips multiple emails in one message", () => {
			const out = sanitizeMcpErrorMessage(
				"cross-tenant leak: a@example.org and b@example.net match",
			);
			expect(out).not.toContain("a@example.org");
			expect(out).not.toContain("b@example.net");
		});
	});

	// -----------------------------------------------------------------------
	// Rule 3 — 500-char cap with ellipsis.
	// -----------------------------------------------------------------------

	describe("length cap (rule 3)", () => {
		it("returns inputs <= 500 chars unchanged", () => {
			const text = "a".repeat(500);
			const out = sanitizeMcpErrorMessage(text);
			expect(out.length).toBe(500);
			expect(out).toBe(text);
		});

		it("caps inputs > 500 chars and appends an ellipsis", () => {
			const text = "x".repeat(1000);
			const out = sanitizeMcpErrorMessage(text);
			// Total length never exceeds the cap.
			expect(out.length).toBeLessThanOrEqual(500);
			// Final char is the single-char ellipsis so downstream readers can
			// tell the message was truncated.
			expect(out.endsWith("…")).toBe(true);
		});

		it("the cap is applied AFTER redaction, not before", () => {
			// 600 chars: the api_key span is at the start and the secret is
			// long enough that, if the cap ran first, the redaction would
			// never fire. The implementation redacts first.
			const text = `api_key=${"S".repeat(550)} trailing text`;
			const out = sanitizeMcpErrorMessage(text);
			expect(out).toContain("<redacted>");
			expect(out).not.toMatch(/SS{5,}/);
		});
	});

	// -----------------------------------------------------------------------
	// Benign-text preservation ("preserves benign error text").
	// -----------------------------------------------------------------------

	describe("benign-text preservation", () => {
		it("does not redact words that merely contain 'key' or 'secret' as substrings", () => {
			// The pattern is anchored to `(api[_-]?key|token|secret|password|bearer)
			// \s*[:=]\s*\S+` — words like "monkey" or "asbestos" do not match.
			expect(sanitizeMcpErrorMessage("the monkey escaped")).toBe(
				"the monkey escaped",
			);
			expect(sanitizeMcpErrorMessage("hiding asbestos in the wall")).toBe(
				"hiding asbestos in the wall",
			);
		});

		it("preserves benign technical messages", () => {
			expect(sanitizeMcpErrorMessage("ECONNRESET socket hang up")).toBe(
				"ECONNRESET socket hang up",
			);
		});
	});
});

describe("provider credential formats", () => {
	it.each([
		[
			"Authorization: Bearer sk-proj-abcdefghijklmnopqrstuvwx",
			"sk-proj-abcdefghijklmnopqrstuvwx",
		],
		[
			"401 Incorrect API key sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
			"sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
		],
		['{"apiKey": "abc12345678"}', "abc12345678"],
		[
			"Authorization: Bearer example-session-token",
			"example-session-token",
		],
		["Rejected sk-abcdefghijklmnopqrstuvwx", "sk-abcdefghijklmnopqrstuvwx"],
		[
			"Rejected sk-proj-abcdefghijklmnopqrstuvwx",
			"sk-proj-abcdefghijklmnopqrstuvwx",
		],
		[
			"Authorization: Basic ZXhhbXBsZTpleGFtcGxlLXNlY3JldA==",
			"ZXhhbXBsZTpleGFtcGxlLXNlY3JldA==",
		],
		[
			"Authorization: eyJhbGciOiJIUzI1NiJ9.e30.example",
			"eyJhbGciOiJIUzI1NiJ9.e30.example",
		],
		[
			'{"authorization": "Basic ZXhhbXBsZTpzZWNyZXQ="}',
			"ZXhhbXBsZTpzZWNyZXQ=",
		],
		[
			'Authorization: Digest username="example", nonce="example-nonce", response="example-response"',
			"example-response",
		],
		[
			'Authorization: Digest username="example", nonce="example-nonce", response="example-response"',
			"example-nonce",
		],
		[
			JSON.stringify({
				authorization:
					'Digest username="example", nonce="example-nonce", response="example-response"',
			}),
			"example-response",
		],
		['{"token": "example-token"}', "example-token"],
		['{"key": "example-key-value"}', "example-key-value"],
		[
			"{'secret': 'example secret with spaces'}",
			"example secret with spaces",
		],
		[
			'{"password": "example password with spaces"}',
			"example password with spaces",
		],
	])("redacts %s", (message, credential) => {
		const result = sanitizeMcpErrorMessage(message);
		expect(result).not.toContain(credential);
		expect(result).toContain("<redacted>");
	});
	it("fully removes a long quoted credential before applying the output cap", () => {
		const result = sanitizeMcpErrorMessage(
			`Provider failed: "password": "${"example-secret ".repeat(2000)}" retry later`,
		);
		expect(result).toBe("Provider failed: <redacted> retry later");
	});
});

it("removes escaped quotes within a quoted credential", () => {
	const message = JSON.stringify({ password: 'example "quoted" secret' });
	expect(sanitizeMcpErrorMessage(message)).toBe("{<redacted>}");
});

it("ends an Authorization redaction at the line break", () => {
	expect(
		sanitizeMcpErrorMessage(
			"Authorization: Basic ZXhhbXBsZTpzZWNyZXQ=\nRequest rejected with 401",
		),
	).toBe("<redacted>\nRequest rejected with 401");
});

it("bounds email matching on large near misses", () => {
	expect(sanitizeMcpErrorMessage(`a${"!@".repeat(50_000)}`)).toHaveLength(
		500,
	);
});

describe("linear email redaction", () => {
	it("matches the former regex on 20,000 seeded random inputs", () => {
		const alphabet = [
			"a",
			"Z",
			"0",
			"_",
			"@",
			".",
			"-",
			"!",
			" ",
			"\t",
			"\n",
			"\u00a0",
		];
		let state = 0x12345678;
		const random = () => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state >>> 8;
		};
		for (let sample = 0; sample < 20_000; sample++) {
			const length = random() % 25;
			let input = "";
			for (let i = 0; i < length; i++) {
				input += alphabet[random() % alphabet.length];
			}
			expect(sanitizeMcpErrorMessage(input), JSON.stringify(input)).toBe(
				input.replace(/\b\S+@\S+\.\S+\b/g, "<redacted>"),
			);
		}
	});
	it.each([
		"a@".repeat(1000),
		"a@".repeat(50_000),
		`a${"@.".repeat(50_000)}`,
	])("handles a worst-case non-match in linear time", (input) => {
		const start = performance.now();
		const result = sanitizeMcpErrorMessage(input);
		const elapsed = performance.now() - start;
		expect(result).toBe(`${input.slice(0, 499)}…`);
		expect(elapsed).toBeLessThan(250);
	});
	it("redacts a match whose final word boundary is beyond the former input cap", () => {
		expect(sanitizeMcpErrorMessage(`a@${".".repeat(5000)}z`)).toBe(
			"<redacted>",
		);
	});
	it.each([
		"!a@b.c!",
		"a@.b",
		"a@@.b",
		"a@b.c!d@e.f!",
		"éa@b.cé",
		"😀a@b.c😀",
		"a@b.c\u2028d@e.f",
		"a@b.c\ufeffd@e.f",
		"a@b.c\u200bd@e.f",
		"a@b.c\r\nv@w.x",
	])("preserves boundaries and whitespace for %j", (input) => {
		expect(sanitizeMcpErrorMessage(input)).toBe(
			input.replace(/\b\S+@\S+\.\S+\b/g, "<redacted>"),
		);
	});
});
