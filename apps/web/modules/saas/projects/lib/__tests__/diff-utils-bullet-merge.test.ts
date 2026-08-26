/**
 * Tests for mergeOrphanBulletContinuations.
 *
 * The function repairs LLM-emitted markdown that splits a single bullet into
 * multiple lines (orphan paragraph or continuation bullet). The internal
 * `joinSepForSplitMarkup` heuristic decides whether to insert a space when
 * rejoining split bold/inline-code spans — these tests pin the rules for
 * each shape we've seen in production (issue #737).
 */

import { describe, expect, it } from "vitest";
import { mergeOrphanBulletContinuations } from "../diff-utils";

describe("mergeOrphanBulletContinuations", () => {
	describe("basic continuation", () => {
		it("merges a continuation bullet into its parent", () => {
			const input = [
				"- This sentence starts on the first bullet",
				"- and finishes on the second.",
			].join("\n");
			expect(mergeOrphanBulletContinuations(input)).toBe(
				"- This sentence starts on the first bullet and finishes on the second.",
			);
		});

		it("merges an orphan column-0 paragraph into the preceding bullet", () => {
			const input = [
				"- This sentence starts on the bullet",
				"and continues on the next line.",
			].join("\n");
			expect(mergeOrphanBulletContinuations(input)).toBe(
				"- This sentence starts on the bullet and continues on the next line.",
			);
		});

		it("leaves intentional sibling bullets alone", () => {
			const input = [
				"- This sentence ends here.",
				"- This is a separate bullet.",
			].join("\n");
			// First bullet ends with `.`, so the walk stops; second bullet stands.
			expect(mergeOrphanBulletContinuations(input)).toBe(input);
		});

		it("respects the word-count guard for short consecutive bullets", () => {
			// Short lowercase bullets like command lists must NOT be merged.
			const input = ["- npm install", "- yarn add"].join("\n");
			expect(mergeOrphanBulletContinuations(input)).toBe(input);
		});

		it("stops at structural blocks (headings, fences, blockquotes)", () => {
			const heading = ["- Bullet without a period", "## A heading"].join(
				"\n",
			);
			expect(mergeOrphanBulletContinuations(heading)).toBe(heading);

			const blockquote = ["- Bullet without a period", "> a quote"].join(
				"\n",
			);
			expect(mergeOrphanBulletContinuations(blockquote)).toBe(blockquote);

			const fence = ["- Bullet without a period", "```code"].join("\n");
			expect(mergeOrphanBulletContinuations(fence)).toBe(fence);
		});
	});

	describe("diff-marker bail", () => {
		it("returns input unchanged when DIFF_ADD_START is present", () => {
			// Use the actual ZWSP-wrapped marker tokens.
			const ADD_START = "​​ADD_START​ ";
			const ADD_END = " ​ADD_END​​";
			const input = [
				`- Pre-${ADD_START}new${ADD_END}-text bullet without period`,
				"- continuation that would normally merge",
			].join("\n");
			expect(mergeOrphanBulletContinuations(input)).toBe(input);
		});
	});

	describe("split bold span repairs", () => {
		it("rejoins word-boundary bold splits with a space", () => {
			const input = ["- This is **very important", "and urgent**"].join(
				"\n",
			);
			expect(mergeOrphanBulletContinuations(input)).toBe(
				"- This is **very important and urgent**",
			);
		});

		it("rejoins comma-boundary bold splits with a space", () => {
			const input = ["- This is **important,", "and urgent**"].join("\n");
			expect(mergeOrphanBulletContinuations(input)).toBe(
				"- This is **important, and urgent**",
			);
		});

		it("rejoins mid-token bold splits without a space", () => {
			// Body ends with `/` (sticky) — concat preserves the path.
			const input = ["- Owns **scope/", "ACs/priority**"].join("\n");
			expect(mergeOrphanBulletContinuations(input)).toBe(
				"- Owns **scope/ACs/priority**",
			);
		});

		it("rejoins hyphenated bold splits without a space", () => {
			// Body ends with `-` (sticky).
			const input = ["- Mark **half-", "word**"].join("\n");
			expect(mergeOrphanBulletContinuations(input)).toBe(
				"- Mark **half-word**",
			);
		});
	});

	describe("split inline-code span repairs", () => {
		it("concatenates camelCase identifier splits", () => {
			const input = ["- Use `getUser", "ById` here"].join("\n");
			expect(mergeOrphanBulletContinuations(input)).toBe(
				"- Use `getUserById` here",
			);
		});

		it("concatenates digit-suffix identifier splits", () => {
			expect(
				mergeOrphanBulletContinuations(
					["- Hash with `sha", "256` for integrity"].join("\n"),
				),
			).toBe("- Hash with `sha256` for integrity");
			expect(
				mergeOrphanBulletContinuations(
					["- Use the `gpt", "4o` model"].join("\n"),
				),
			).toBe("- Use the `gpt4o` model");
		});

		it("preserves spaces around GNU long CLI flags", () => {
			expect(
				mergeOrphanBulletContinuations(
					["- Run `pnpm", "--filter web` install"].join("\n"),
				),
			).toBe("- Run `pnpm --filter web` install");
			expect(
				mergeOrphanBulletContinuations(
					["- Run `eslint", "--fix` here"].join("\n"),
				),
			).toBe("- Run `eslint --fix` here");
		});

		it("preserves spaces around single-letter short CLI flags", () => {
			expect(
				mergeOrphanBulletContinuations(
					["- Check `node", "-v` first"].join("\n"),
				),
			).toBe("- Check `node -v` first");
			expect(
				mergeOrphanBulletContinuations(
					["- Run `git", "-C repo status` next"].join("\n"),
				),
			).toBe("- Run `git -C repo status` next");
		});

		it("preserves spaces around combined short flags with arguments", () => {
			// `-am msg`, `-rf path` etc. are distinguished from hyphenated
			// package names by having INTERNAL whitespace.
			expect(
				mergeOrphanBulletContinuations(
					["- Run `git", "-am message` to amend"].join("\n"),
				),
			).toBe("- Run `git -am message` to amend");
			expect(
				mergeOrphanBulletContinuations(
					["- Run `rm", "-rf path` carefully"].join("\n"),
				),
			).toBe("- Run `rm -rf path` carefully");
			expect(
				mergeOrphanBulletContinuations(
					["- Run `tar", "-rf archive.tar` here"].join("\n"),
				),
			).toBe("- Run `tar -rf archive.tar` here");
		});

		it("concatenates hyphenated package name splits", () => {
			// Package names like `tailwind-merge` are exact install strings —
			// must not be silently broken with an inserted space.
			expect(
				mergeOrphanBulletContinuations(
					["- Install `tailwind", "-merge` next"].join("\n"),
				),
			).toBe("- Install `tailwind-merge` next");
			expect(
				mergeOrphanBulletContinuations(
					["- Install `date", "-fns` next"].join("\n"),
				),
			).toBe("- Install `date-fns` next");
		});

		it("inserts spaces between multi-word command tokens", () => {
			expect(
				mergeOrphanBulletContinuations(
					["- Run `pnpm", "install` for deps"].join("\n"),
				),
			).toBe("- Run `pnpm install` for deps");
		});

		it("concatenates path-continuation code splits", () => {
			expect(
				mergeOrphanBulletContinuations(
					["- See `path/to", "/file` for details"].join("\n"),
				),
			).toBe("- See `path/to/file` for details");
		});
	});
});
