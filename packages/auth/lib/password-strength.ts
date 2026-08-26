/**
 * Password strength enforcement via zxcvbn-ts.
 *
 * Contract:
 *   - Minimum 12 characters (fail-fast before running the full estimator).
 *   - zxcvbn score must be ≥ 3 on a 0–4 scale (score 3 = ~10^8 guesses
 *     offline; score 4 = ~10^10). This excludes common passwords, dictionary
 *     words, and keyboard walks at any length.
 *   - User-supplied context (email, name) is passed as `userInputs` to the
 *     estimator so passwords derived from the user's own identity (e.g.
 *     "johnsmith2026!") are penalised even if they would otherwise score ≥ 3.
 *     Both the full email address and the local-part before "@" are included.
 *
 * Threat model:
 *   zxcvbn estimates the number of guesses an attacker would need using the
 *   best known cracking strategy (dictionary + combinator + brute-force). A
 *   score of 3 corresponds to ~10^8 guesses, which is beyond the reach of an
 *   online attack (rate-limited) and expensive for an offline attack against
 *   bcrypt/argon2 hashes. Score < 3 (passwords like "password1234",
 *   "qwerty2023", or a user's own name) can be cracked in seconds offline and
 *   are rejected here before they ever reach the hash function.
 *
 * Wiring:
 *   - Called inside the Better Auth `hooks.before` middleware in
 *     `packages/auth/auth.ts` for `/sign-up/email`, `/reset-password`, and
 *     `/change-password`. A `PasswordTooWeakError` is translated into an
 *     `APIError("BAD_REQUEST", { code: "PASSWORD_TOO_WEAK", ... })` that the
 *     frontend can inspect and surface as field-level feedback.
 */

import { zxcvbn, zxcvbnOptions } from "@zxcvbn-ts/core";
import * as zxcvbnCommonPackage from "@zxcvbn-ts/language-common";
import * as zxcvbnEnPackage from "@zxcvbn-ts/language-en";

zxcvbnOptions.setOptions({
	translations: zxcvbnEnPackage.translations,
	graphs: zxcvbnCommonPackage.adjacencyGraphs,
	dictionary: {
		...zxcvbnCommonPackage.dictionary,
		...zxcvbnEnPackage.dictionary,
	},
});

const MIN_LENGTH = 12;
const MIN_SCORE = 3;

export class PasswordTooWeakError extends Error {
	suggestions: string[];
	warning: string;
	constructor(warning: string, suggestions: string[]) {
		super(warning || "Password is too weak");
		this.name = "PasswordTooWeakError";
		this.warning = warning;
		this.suggestions = suggestions;
	}
}

export interface StrengthContext {
	email?: string;
	name?: string;
}

export function assertPasswordStrength(
	password: string,
	ctx: StrengthContext,
): void {
	if (password.length < MIN_LENGTH) {
		throw new PasswordTooWeakError(
			`Password must be at least ${MIN_LENGTH} characters.`,
			["Use a passphrase of multiple words."],
		);
	}
	const userInputs: string[] = [];
	if (ctx.email) {
		userInputs.push(ctx.email);
		const localPart = ctx.email.split("@")[0];
		if (localPart) {
			userInputs.push(localPart);
		}
	}
	if (ctx.name) {
		userInputs.push(ctx.name);
	}

	const result = zxcvbn(password, userInputs);
	if (result.score < MIN_SCORE) {
		throw new PasswordTooWeakError(
			result.feedback.warning || "Password is too weak.",
			result.feedback.suggestions ?? [
				"Try adding more words or characters.",
			],
		);
	}
}
