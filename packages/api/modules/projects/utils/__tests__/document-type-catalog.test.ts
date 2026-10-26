/**
 * The catalog's job is to be the only place a project document type's display
 * name lives. These tests guard the two ways that fails: a type in the schema
 * with no entry here, and an entry here for a type the schema does not have.
 *
 * The keyed `Record<ProjectDocumentType, …>` already makes the first a compile
 * error. This asserts it at runtime too, because the compile-time guarantee is
 * only as good as the type import staying wired to the generated schema — and
 * a test that fails loudly beats a type error someone silences with a cast.
 */

import { ProjectDocumentTypeSchema } from "@repo/database/prisma/zod";
import {
	DOCUMENT_TYPE_CATALOG,
	DOCUMENT_TYPE_OPTIONS,
	documentTypeLabel,
	isCreatableDocumentType,
	isDeprecatedDocumentType,
} from "@repo/utils/document-type-catalog";
import { describe, expect, it } from "vitest";

describe("document type catalog", () => {
	it("covers every type the schema declares", () => {
		const missing = ProjectDocumentTypeSchema.options.filter(
			(type) => !(type in DOCUMENT_TYPE_CATALOG),
		);
		expect(missing).toEqual([]);
	});

	it("declares no type the schema does not have", () => {
		const known = new Set<string>(ProjectDocumentTypeSchema.options);
		const extra = Object.keys(DOCUMENT_TYPE_CATALOG).filter(
			(type) => !known.has(type),
		);
		expect(extra).toEqual([]);
	});

	it("gives every type a non-empty label and icon", () => {
		for (const type of ProjectDocumentTypeSchema.options) {
			const entry = DOCUMENT_TYPE_CATALOG[type];
			expect(entry.label.trim(), `label for ${type}`).not.toBe("");
			expect(entry.icon.trim(), `icon for ${type}`).not.toBe("");
		}
	});

	it("never falls back to the de-underscored value for a known type", () => {
		// The fallback exists for rows written before a type was retired. A
		// known type reaching it would mean the catalog silently lost an entry.
		for (const type of ProjectDocumentTypeSchema.options) {
			expect(documentTypeLabel(type)).not.toBe(type.replace(/_/g, " "));
		}
	});

	it("falls back readably for a type it does not know", () => {
		expect(documentTypeLabel("SOME_RETIRED_TYPE")).toBe(
			"SOME RETIRED TYPE",
		);
	});

	it("exposes the creatable types as an ordered option list", () => {
		expect(DOCUMENT_TYPE_OPTIONS.map((o) => o.value)).toEqual(
			Object.keys(DOCUMENT_TYPE_CATALOG).filter(
				(type) => !isDeprecatedDocumentType(type),
			),
		);
		expect(DOCUMENT_TYPE_OPTIONS[0]?.value).toBe("GENERAL");
	});

	describe("deprecation", () => {
		it("marks Features (USER_STORY) and nothing else", () => {
			const deprecated = ProjectDocumentTypeSchema.options.filter(
				(type) => isDeprecatedDocumentType(type),
			);
			expect(deprecated).toEqual(["USER_STORY"]);
		});

		it("keeps the Features label unmarked, because it is also the default title", () => {
			expect(documentTypeLabel("USER_STORY")).toBe("Features");
		});

		it("leaves Features out of the create flow's options", () => {
			expect(DOCUMENT_TYPE_OPTIONS.map((o) => o.value)).not.toContain(
				"USER_STORY",
			);
		});

		it("does not treat an unknown type as deprecated", () => {
			expect(isDeprecatedDocumentType("SOME_RETIRED_TYPE")).toBe(false);
		});
	});

	describe("isCreatableDocumentType", () => {
		it("refuses Features and allows every other schema type", () => {
			const notCreatable = ProjectDocumentTypeSchema.options.filter(
				(type) => !isCreatableDocumentType(type),
			);
			expect(notCreatable).toEqual(["USER_STORY"]);
		});

		it("refuses a type the catalog does not know", () => {
			expect(isCreatableDocumentType("SOME_RETIRED_TYPE")).toBe(false);
			expect(isCreatableDocumentType("constructor")).toBe(false);
		});
	});
});
