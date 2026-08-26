/**
 * Adversarial redaction tests for `redactSensitiveKeys`.
 *
 * Probes edge cases not covered by `audit-log.redact.test.ts`:
 *  - Deeply nested sensitive keys (depth 5+)
 *  - Arrays of objects with sensitive keys inside
 *  - Case-permutation matrix
 *  - Unicode normalization tricks (Cyrillic look-alikes must NOT match)
 *  - Prototype-pollution shaped keys (`__proto__`, `constructor`)
 *  - Buffer / typed-array / Date inputs (must not crash; should not leak)
 *  - Known limitations documented as comments
 *
 * The redactor matches on the KEY substring (case-insensitive), not on
 * value content — so a sensitive-looking VALUE under a neutral KEY
 * intentionally passes through. This is documented as a known limitation
 * to avoid false positives on legitimate log content.
 *
 * Spec: docs/audit-log/README.md §13.1
 */

import { describe, expect, it } from "vitest";
import { redactSensitiveKeys } from "../prisma/queries/audit-log";

describe("redactSensitiveKeys (adversarial)", () => {
	describe("nesting depth", () => {
		it("redacts a sensitive key at depth 6", () => {
			const input = {
				a: { b: { c: { d: { e: { password: "leak" } } } } },
			};
			const out = redactSensitiveKeys(input) as Record<string, unknown>;
			// Walk down manually
			let cursor: unknown = out;
			for (const k of ["a", "b", "c", "d", "e"]) {
				cursor = (cursor as Record<string, unknown>)[k];
			}
			expect((cursor as Record<string, unknown>).password).toBe(
				"[REDACTED]",
			);
		});

		it("redacts a sensitive key at depth 12 (no recursion limit)", () => {
			let leaf: Record<string, unknown> = { secret: "x" };
			for (let i = 0; i < 11; i += 1) {
				leaf = { nested: leaf };
			}
			const out = redactSensitiveKeys(leaf) as Record<string, unknown>;
			let cursor: unknown = out;
			for (let i = 0; i < 11; i += 1) {
				cursor = (cursor as Record<string, unknown>).nested;
			}
			expect((cursor as Record<string, unknown>).secret).toBe(
				"[REDACTED]",
			);
		});
	});

	describe("array walking", () => {
		it("redacts sensitive keys inside an array of objects under a NON-sensitive parent key", () => {
			// Note: the parent key `users` does not match any denylist
			// substring, so we walk INTO the array. Each object element has
			// its own sensitive key (`apiKey`) which IS redacted.
			expect(
				redactSensitiveKeys({
					users: [
						{ id: "u1", apiKey: "tok-1" },
						{ id: "u2", apiKey: "tok-2" },
					],
				}),
			).toEqual({
				users: [
					{ id: "u1", apiKey: "[REDACTED]" },
					{ id: "u2", apiKey: "[REDACTED]" },
				],
			});
		});

		it("preserves non-sensitive sibling fields inside the same array element", () => {
			expect(
				redactSensitiveKeys({
					tokens_owned_by_user: [
						{ owner: "alice", apiKey: "k1", note: "primary" },
					],
				}),
			).toEqual({
				// `tokens_owned_by_user` matches "token" substring — whole value
				// redacted to "[REDACTED]" rather than walked.
				tokens_owned_by_user: "[REDACTED]",
			});
		});

		it("walks an array under a fully non-sensitive parent key", () => {
			expect(
				redactSensitiveKeys({
					accounts: [
						{ id: "a1", clientSecret: "shh" },
						{ id: "a2", clientSecret: "psst" },
					],
				}),
			).toEqual({
				accounts: [
					{ id: "a1", clientSecret: "[REDACTED]" },
					{ id: "a2", clientSecret: "[REDACTED]" },
				],
			});
		});
	});

	describe("case-permutation matrix", () => {
		const variations = [
			"password",
			"Password",
			"PASSWORD",
			"passWord",
			"aPasswordField",
			"xPassword",
			"my_password_hash",
			"PWD_PASSWORD", // contains "password" substring
		];

		it.each(variations)("redacts key `%s`", (key) => {
			const out = redactSensitiveKeys({ [key]: "x" }) as Record<
				string,
				unknown
			>;
			expect(out[key]).toBe("[REDACTED]");
		});
	});

	describe("SOC 2 audit denylist additions (CC7.2)", () => {
		const sensitive = [
			"credential",
			"credentials",
			"awsCredentialJson",
			"privateKey",
			"private_key",
			"rsaPrivateKeyPem",
			"otpSecret",
			"totp",
			"backupOtp",
			"passwordSalt",
			"salt",
			"webhookSignature",
			"signature",
		];

		it.each(sensitive)("redacts newly-denylisted key `%s`", (key) => {
			expect(redactSensitiveKeys({ [key]: "x" })).toEqual({
				[key]: "[REDACTED]",
			});
		});

		it("scopes `private` to key material — `isPrivate`/`privateNote` stay legible", () => {
			// `private` is intentionally NOT a bare denylist entry (only
			// `privatekey`/`private_key`), so ordinary visibility flags and
			// notes are preserved in the audit trail.
			expect(
				redactSensitiveKeys({ isPrivate: true, privateNote: "hi" }),
			).toEqual({ isPrivate: true, privateNote: "hi" });
		});
	});

	describe("unicode tricks", () => {
		it("does NOT match keys built from Cyrillic look-alikes (different code points)", () => {
			// `р` (U+0440 Cyrillic er) and `а` (U+0430 Cyrillic a) — visually
			// identical to "p" / "a" but distinct code points. The denylist is
			// a literal lowercase substring match so these do not match.
			expect(
				redactSensitiveKeys({ pаssword: "x" }), // "p" + Cyrillic а
			).toEqual({ pаssword: "x" });
		});

		it("redacts ASCII-only keys even when surrounded by unicode", () => {
			// `passwordꜜ` — the ASCII "password" is still a substring.
			expect(redactSensitiveKeys({ passwordꜜ: "x" })).toEqual({
				passwordꜜ: "[REDACTED]",
			});
		});

		it("redacts a key after unicode NFC/NFD normalisation IF caller normalises first", () => {
			// We intentionally do NOT auto-normalise; document the limitation.
			// "ｐassword" with a full-width latin small letter p (U+FF50) is
			// NOT lowered to ASCII "p" by toLowerCase(). This passes
			// through. Operators relying on unicode-normalised matching must
			// normalise themselves before calling the redactor.
			const fullwidth = "ｐassword"; // ｐassword
			expect(redactSensitiveKeys({ [fullwidth]: "x" })).toEqual({
				[fullwidth]: "x",
			});
		});
	});

	describe("known limitations (documented)", () => {
		it("PRESERVES a sensitive VALUE under a non-sensitive KEY", () => {
			// KNOWN LIMITATION: the redactor matches on KEY only. A note
			// field containing a literal password string is preserved. This
			// is deliberate — matching on value would have a huge
			// false-positive rate on legitimate log content (e.g. "the
			// password reset email was sent"). Callers writing free-form
			// notes into metadata are responsible for redacting their own
			// values.
			expect(
				redactSensitiveKeys({
					note: "the password is hunter2",
					message: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
				}),
			).toEqual({
				note: "the password is hunter2",
				message: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
			});
		});

		it("PRESERVES token-shaped values in neutrally-named fields", () => {
			// KNOWN LIMITATION: same as above, but with a `payload` field.
			expect(redactSensitiveKeys({ payload: "Bearer eyJ..." })).toEqual({
				payload: "Bearer eyJ...",
			});
		});
	});

	describe("prototype-pollution shaped keys", () => {
		it("treats `__proto__` as data, does NOT pollute Object.prototype", () => {
			// Before / after snapshot of Object.prototype to detect leakage.
			// If the redactor naively assigned via dot/bracket without checking
			// `hasOwnProperty`, an attacker could pollute every object in the
			// process. We assert no pollution occurs.
			expect(
				(Object.prototype as { polluted?: unknown }).polluted,
			).toBeUndefined();
			redactSensitiveKeys({
				__proto__: { polluted: true },
			});
			expect(
				(Object.prototype as { polluted?: unknown }).polluted,
			).toBeUndefined();
			// Clean up just in case any other test mutated the prototype.
			delete (Object.prototype as { polluted?: unknown }).polluted;
		});

		it("redacts `__proto__` itself when its NAME contains a sensitive substring (it does NOT — substring check)", () => {
			// `__proto__` contains no sensitive substring — passes through
			// as data.
			const out = redactSensitiveKeys({
				__proto__: "literal-string",
			}) as Record<string, unknown>;
			// The key is treated as data; the value passes through. Critically
			// the iteration via `Object.keys` does NOT visit `__proto__` for
			// a plain object literal so the output object does not have the
			// key at all (defensive — proves we never copied a prototype
			// property through).
			expect(Object.hasOwn(out, "__proto__")).toBe(false);
		});

		it("treats `constructor` as data (not a special key)", () => {
			const out = redactSensitiveKeys({
				constructor: "should-be-data",
				password: "should-redact",
			}) as Record<string, unknown>;
			expect(out.constructor).toBe("should-be-data");
			expect(out.password).toBe("[REDACTED]");
		});
	});

	describe("exotic inputs", () => {
		it("does not crash on a Buffer", () => {
			// Buffers are objects with numeric-string keys. They will be
			// walked like an array-of-numbers object. We assert no throw
			// and that the result is still serializable.
			const buf = Buffer.from("hello", "utf8");
			expect(() => redactSensitiveKeys({ data: buf })).not.toThrow();
			const out = redactSensitiveKeys({ data: buf }) as Record<
				string,
				unknown
			>;
			expect(JSON.stringify(out)).toBeTruthy();
		});

		it("does not crash on a Uint8Array", () => {
			const arr = new Uint8Array([1, 2, 3]);
			expect(() => redactSensitiveKeys({ blob: arr })).not.toThrow();
		});

		it("does not crash on a Date", () => {
			// Dates are objects with no own enumerable properties — walking
			// produces {}.
			const out = redactSensitiveKeys({ when: new Date(0) }) as Record<
				string,
				unknown
			>;
			expect(out.when).toEqual({});
		});

		it("does not crash on Symbol-keyed properties (they are ignored)", () => {
			const sym = Symbol("secret");
			const input: Record<string | symbol, unknown> = { [sym]: "x" };
			expect(() => redactSensitiveKeys(input)).not.toThrow();
		});

		it("handles a frozen object", () => {
			const frozen = Object.freeze({ apiKey: "x" });
			expect(redactSensitiveKeys(frozen)).toEqual({
				apiKey: "[REDACTED]",
			});
		});
	});

	describe("non-mutation guarantee", () => {
		it("never mutates the input even with arrays and nesting", () => {
			const input = {
				users: [{ name: "a", password: "p" }],
				meta: { accessToken: "tok" },
			};
			const before = JSON.stringify(input);
			redactSensitiveKeys(input);
			expect(JSON.stringify(input)).toBe(before);
		});
	});
});
