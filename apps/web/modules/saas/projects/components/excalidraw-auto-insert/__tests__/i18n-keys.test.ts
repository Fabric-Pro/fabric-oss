/**
 * Locks the i18n keys + interpolation tokens added by D5.
 *
 * Locking rationale: the strings themselves are subject to copy review
 * and can change, but the **keys** + the **interpolation tokens** are
 * load-bearing across the button (D2), banner (D6), picker (E1), toast
 * helpers (D4), and the E2E suite (G6). A silent rename or a missing
 * `{docName}` interpolation breaks the user-visible UI without any
 * TypeScript signal — next-intl resolves an unknown key to the key
 * itself at runtime.
 *
 * The test imports `en.json` directly via the same `@repo/i18n/translations/en.json`
 * path as the existing `tooltips-namespace.test.ts` precedent in this
 * package, so the i18n package's source remains the source of truth.
 *
 * Note: the spec listed this test as
 * `packages/i18n/__tests__/excalidraw-auto-insert.test.ts`. The
 * `@repo/i18n` package does not run a test runner of its own (see
 * `packages/i18n/package.json`), so the assertions live here under
 * `apps/web` where vitest discovers them. The import path is still
 * `@repo/i18n/translations/en.json` -- so a future move of the test
 * file is a zero-edit relocation.
 */
import en from "@repo/i18n/translations/en.json";
import { describe, expect, it } from "vitest";

describe("i18n -- tooltips.diagrams (D5 / spec § 14.7)", () => {
	const ns = en.tooltips.diagrams;

	it.each([
		["insertCrossProject"],
		["insertNoPermission"],
		["insertNoCreatePermission"],
		["insertNotReady"],
		["copyEmbedCode"],
	] as const)("declares key `%s` as a non-empty string", (key) => {
		const value = ns[key as keyof typeof ns];
		expect(typeof value).toBe("string");
		expect((value as string).length).toBeGreaterThan(0);
	});

	it("`insertCrossProject` carries the {projectName} interpolation token", () => {
		expect(ns.insertCrossProject).toContain("{projectName}");
	});

	it("`insertNoPermission` carries the {docName} interpolation token", () => {
		expect(ns.insertNoPermission).toContain("{docName}");
	});
});

describe("i18n -- diagrams.autoInsert (D5 / spec § 14.7)", () => {
	const ns = en.diagrams.autoInsert;

	it.each([
		["insertButton"],
		["openPickerButton"],
		["insertedButton"],
		["saveToDiagramsButton"],
		["copyEmbedCodeButton"],
		["pickerTitle"],
		["pickerDescription"],
		["pickerTabDocuments"],
		["pickerTabFeatures"],
		["pickerEmpty"],
		["toastSuccess"],
		["toastSuccessAction"],
		["toastErrorDb"],
		["toastErrorForbidden"],
		["toastCopyFailed"],
		["bannerEditorFailure"],
		["bannerEditorFailureRetry"],
	] as const)("declares key `%s` as a non-empty string", (key) => {
		const value = ns[key as keyof typeof ns];
		expect(typeof value).toBe("string");
		expect((value as string).length).toBeGreaterThan(0);
	});

	it("`insertButton` carries the {docName} interpolation token", () => {
		expect(ns.insertButton).toContain("{docName}");
	});

	it("`insertedButton` carries the {docName} interpolation token", () => {
		expect(ns.insertedButton).toContain("{docName}");
	});

	it("`pickerDescription` carries the {projectName} interpolation token", () => {
		expect(ns.pickerDescription).toContain("{projectName}");
	});

	it("`toastSuccess` carries the {docName} interpolation token", () => {
		expect(ns.toastSuccess).toContain("{docName}");
	});

	it("`bannerEditorFailure` carries the {projectName} AND {docName} interpolation tokens", () => {
		expect(ns.bannerEditorFailure).toContain("{projectName}");
		expect(ns.bannerEditorFailure).toContain("{docName}");
	});

	it("tone -- no exclamation marks in any auto-insert string (calm/advisory)", () => {
		const allValues = Object.values(ns);
		for (const value of allValues) {
			if (typeof value === "string") {
				expect(
					value,
					`string "${value}" must not contain an exclamation mark`,
				).not.toContain("!");
			}
		}
	});
});
