/**
 * What a triage shortlist is allowed to claim.
 *
 * The value of this module is entirely in what it leaves OUT. A ranking that
 * returns all 47 changed files, or that puts `pnpm-lock.yaml` above the source
 * file whose name is in the test's own title, has handed the reader back the
 * diff they already had — and handed the root-cause model a lead it will follow
 * confidently in the wrong direction.
 */

import { describe, expect, it } from "vitest";
import { correlateFailureToDiff } from "../correlate-failure-to-diff";

describe("correlateFailureToDiff", () => {
	it("ranks the test's own spec file first, because a changed spec is nearly always the answer", () => {
		const ranked = correlateFailureToDiff({
			testName: "checkout applies the discount",
			classname: "e2e/checkout.spec.ts",
			specFilePath: "e2e/checkout.spec.ts",
			changedFiles: ["src/checkout/discount.ts", "e2e/checkout.spec.ts"],
		});

		expect(ranked[0]?.path).toBe("e2e/checkout.spec.ts");
		expect(ranked[0]?.score).toBe(1);
		expect(ranked[0]?.reason).toContain("own spec file");
	});

	it("recognises the spec file when the diff is repo-relative and the runner's path is not", () => {
		// A monorepo runner reports `e2e/checkout.spec.ts` from inside `apps/web`
		// while git reports the full path. Demanding equality would silently throw
		// away the strongest signal the module has.
		const ranked = correlateFailureToDiff({
			testName: "checkout applies the discount",
			specFilePath: "e2e/checkout.spec.ts",
			changedFiles: ["apps/web/e2e/checkout.spec.ts"],
		});

		expect(ranked[0]?.path).toBe("apps/web/e2e/checkout.spec.ts");
		expect(ranked[0]?.score).toBe(1);
	});

	it("treats a classname as the spec file only when it is a path, not a suite name", () => {
		// `CheckoutSpec` is a JUnit suite, not a file — scoring a changed file
		// called `CheckoutSpec.java` as "the test's own file" would be luck, and
		// the same rule must not fire on `com.acme.CheckoutSpec`.
		const suite = correlateFailureToDiff({
			testName: "applies the discount",
			classname: "com.acme.CheckoutSpec",
			changedFiles: ["src/checkout/discount.ts"],
		});
		expect(suite[0]?.score).toBeLessThan(1);

		const path = correlateFailureToDiff({
			testName: "applies the discount",
			classname: "src/checkout/CheckoutSpec.java",
			changedFiles: ["src/checkout/CheckoutSpec.java"],
		});
		expect(path[0]?.score).toBe(1);
	});

	it("surfaces a source file whose name overlaps the test's words, so triage starts in the right module", () => {
		const ranked = correlateFailureToDiff({
			testName: "checkout applies the discount",
			classname: "CheckoutSpec",
			changedFiles: [
				"src/checkout/discount.ts",
				"src/billing/invoice.ts",
			],
		});

		expect(ranked).toHaveLength(1);
		expect(ranked[0]?.path).toBe("src/checkout/discount.ts");
		expect(ranked[0]?.reason).toContain('"discount"');
		expect(ranked[0]?.reason).toContain('"checkout"');
	});

	it("scores a filename match above a directory-only match, because the file is about the thing under test", () => {
		const ranked = correlateFailureToDiff({
			testName: "checkout applies the discount",
			changedFiles: [
				"src/checkout/discount.ts",
				"src/checkout/session.ts",
			],
		});

		expect(ranked.map((file) => file.path)).toEqual([
			"src/checkout/discount.ts",
			"src/checkout/session.ts",
		]);
		expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
	});

	it("keeps CI and lockfile churn below a real filename match, so useless evidence cannot bury useful evidence", () => {
		// The workflow file echoes both of the test's words, so an unweighted
		// similarity score would rank it FIRST — above the source file that
		// actually implements the behaviour. That inversion is the whole reason
		// churn is demoted.
		const ranked = correlateFailureToDiff({
			testName: "checkout applies the discount",
			changedFiles: [
				".github/workflows/checkout-discount.yml",
				"src/checkout/discount.ts",
			],
		});

		expect(ranked[0]?.path).toBe("src/checkout/discount.ts");
		const churn = ranked.find(
			(file) => file.path === ".github/workflows/checkout-discount.yml",
		);
		expect(churn?.score).toBeLessThan(ranked[0]?.score ?? 0);
		expect(churn?.reason).toContain("Ranked low");
	});

	it("drops lockfiles and manifests that match nothing, so they never pad the shortlist", () => {
		const ranked = correlateFailureToDiff({
			testName: "checkout applies the discount",
			changedFiles: [
				"pnpm-lock.yaml",
				"package.json",
				"README.md",
				"src/checkout/discount.ts",
			],
		});

		expect(ranked.map((file) => file.path)).toEqual([
			"src/checkout/discount.ts",
		]);
	});

	it("drops files unrelated to the test, so 47 changed files do not become 47 suspects", () => {
		const ranked = correlateFailureToDiff({
			testName: "checkout applies the discount",
			changedFiles: [
				"src/auth/session-cookie.ts",
				"src/mail/templates/welcome.ts",
				"infra/terraform/network.tf",
			],
		});

		expect(ranked).toEqual([]);
	});

	it("returns nothing when no files changed, rather than inventing a suspect", () => {
		expect(
			correlateFailureToDiff({
				testName: "checkout applies the discount",
				specFilePath: "e2e/checkout.spec.ts",
				changedFiles: [],
			}),
		).toEqual([]);
	});

	it("never matches on generic path segments alone, or every file in the repo would qualify", () => {
		// `src`, `lib`, `index`, `test`, `utils` appear in every repo, so an
		// overlap on them is not an overlap at all.
		expect(
			correlateFailureToDiff({
				testName: "it should work",
				changedFiles: ["src/lib/index.ts", "src/utils/test-helpers.ts"],
			}),
		).toEqual([]);
	});

	it("splits PascalCase filenames, so a C#/Java/React codebase is not invisible to the match", () => {
		// `DiscountService.cs` case-folded to one word would never overlap
		// "discount" — and PascalCase filenames are the norm in exactly the
		// codebases that report JUnit-style classnames.
		const ranked = correlateFailureToDiff({
			testName: "checkout applies the discount",
			classname: "CheckoutSpec",
			changedFiles: ["src/Checkout/DiscountService.cs"],
		});

		expect(ranked[0]?.path).toBe("src/Checkout/DiscountService.cs");
		expect(ranked[0]?.reason).toContain('"discount"');
	});

	it("caps the list at ten, because a ranked list of everything is not a ranking", () => {
		const changedFiles = Array.from(
			{ length: 20 },
			(_, index) => `src/checkout/discount-${index + 1}.ts`,
		);

		const ranked = correlateFailureToDiff({
			testName: "checkout applies the discount",
			changedFiles,
		});

		expect(ranked).toHaveLength(10);
	});

	it("returns the same ranking for the same input, so two readers see the same evidence", () => {
		// Equal-scoring files are tie-broken on the path rather than left to sort
		// stability, so the shortlist cannot drift between a UI render and the
		// prompt the root-cause model is given.
		const input = {
			testName: "checkout applies the discount",
			classname: "CheckoutSpec",
			specFilePath: "e2e/checkout.spec.ts",
			changedFiles: [
				"src/checkout/discount.ts",
				"src/checkout/session.ts",
				"e2e/checkout.spec.ts",
				"pnpm-lock.yaml",
			],
		};

		expect(correlateFailureToDiff(input)).toEqual(
			correlateFailureToDiff(input),
		);
	});

	it("keeps every score inside 0..1 so the number can be shown as a confidence", () => {
		const ranked = correlateFailureToDiff({
			testName: "checkout discount coupon promotion applies",
			specFilePath: "e2e/checkout.spec.ts",
			changedFiles: [
				"e2e/checkout.spec.ts",
				"src/checkout/discount-coupon-promotion.ts",
				".github/workflows/checkout-discount-coupon.yml",
			],
		});

		expect(ranked.length).toBeGreaterThan(0);
		for (const file of ranked) {
			expect(file.score).toBeGreaterThan(0);
			expect(file.score).toBeLessThanOrEqual(1);
			expect(file.reason.length).toBeGreaterThan(0);
		}
	});
});
