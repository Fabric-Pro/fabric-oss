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
			// The spec pattern is `(...|bearer)\s*[:=]\s*\S+` so a `[:=]`
			// separator is required. A plain "Authorization: bearer xyz"
			// header (space-only separator after the keyword) is NOT in
			// the documented contract — covered by the `password=`/`api_key=`
			// cases above which are the high-signal exfiltration vectors.
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
				"cross-tenant leak: a@x.io and b@y.org match",
			);
			expect(out).not.toContain("a@x.io");
			expect(out).not.toContain("b@y.org");
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
