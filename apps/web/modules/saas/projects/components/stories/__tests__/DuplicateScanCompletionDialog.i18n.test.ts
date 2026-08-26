/**
 * Locks the i18n contract for the duplicate-scan completion dialog.
 *
 * The dialog reads `projects.stories.duplicates` in both locales (the
 * namespace is fully translated, so en/de key parity is required), uses the
 * `scanCompleteItems` ICU-plural key for the found-variant item-count line
 * (the flagged-item count matching the roadmap filter) and the existing
 * `scanNoneDescription` key for the zero variant, and renders
 * product-confirmed button copy. The scan-failure toast key (`scanFailed`,
 * rendered by the owning hook) is guarded alongside. next-intl resolves a
 * missing key to the key itself at runtime with no TypeScript signal, so key
 * presence, parity, the `{count}` interpolation tokens and the exact CTA
 * labels are pinned here.
 */
import { describe, expect, it } from "vitest";
import de from "../../../../../../../../packages/i18n/translations/de.json";
import en from "../../../../../../../../packages/i18n/translations/en.json";

const DIALOG_KEYS = [
	"scanCompleteTitle",
	"scanCompleteItems",
	"scanCompleteTagged",
	"scanNoneTitle",
	"scanNoneTagged",
	"scanFailed",
	"viewDuplicates",
	"done",
	"viewDuplicatesAria",
	"doneAria",
] as const;

const locales = [
	["en", en.projects.stories.duplicates],
	["de", de.projects.stories.duplicates],
] as const;

describe("duplicate-scan completion dialog i18n", () => {
	describe.each(locales)("%s locale", (_locale, namespace) => {
		it.each(DIALOG_KEYS)("declares `%s` as a non-empty string", (key) => {
			const value = namespace[key];
			expect(typeof value).toBe("string");
			expect(value.length).toBeGreaterThan(0);
		});

		it("keeps the {count} interpolation on the count-line keys", () => {
			expect(namespace.scanCompleteItems).toContain("{count");
			expect(namespace.scanNoneDescription).toContain("{count");
			// `scanFound` is not rendered anywhere anymore; it stays declared
			// so existing translations remain valid, and this guard is its
			// only remaining reference. While declared, keep it ICU-valid.
			expect(namespace.scanFound).toContain("{count");
		});

		it("tone — no exclamation marks in the dialog strings", () => {
			for (const key of DIALOG_KEYS) {
				expect(
					namespace[key],
					`"${key}" must not contain an exclamation mark`,
				).not.toContain("!");
			}
		});

		// Voice-control users speak the visible label; WCAG 2.5.3 (Label in
		// Name) requires the accessible name to contain that visible text, so
		// each aria string must start with its button's label.
		it("button aria labels start with their visible labels", () => {
			expect(
				namespace.viewDuplicatesAria.startsWith(
					namespace.viewDuplicates,
				),
			).toBe(true);
			expect(namespace.doneAria.startsWith(namespace.done)).toBe(true);
		});
	});

	// The CTA labels are product-confirmed copy, including the title case of
	// "View Duplicates" — do not normalize them to sentence case.
	it("uses the confirmed en button copy verbatim", () => {
		expect(en.projects.stories.duplicates.viewDuplicates).toBe(
			"View Duplicates",
		);
		expect(en.projects.stories.duplicates.done).toBe("Done");
	});
});
