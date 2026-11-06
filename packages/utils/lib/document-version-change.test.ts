import { describe, expect, it } from "vitest";
import {
	DOCUMENT_VERSION_CHANGE_DESCRIPTIONS,
	describeDocumentVersionChange,
	restoredVersionDescription,
} from "./document-version-change";

describe("describeDocumentVersionChange", () => {
	it("names each writer's stored description", () => {
		expect(
			describeDocumentVersionChange(
				DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.CHAT_EDIT,
			),
		).toEqual({ kind: "chatEdit" });
		expect(
			describeDocumentVersionChange(
				DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.EDIT_WITH_INSTRUCTIONS,
			),
		).toEqual({ kind: "editWithInstructions" });
		expect(
			describeDocumentVersionChange(
				DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.RECOMMENDATION_APPLIED,
			),
		).toEqual({ kind: "recommendationApplied" });
		expect(
			describeDocumentVersionChange(
				DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.SECTION_REVISED,
			),
		).toEqual({ kind: "sectionRevised" });
		expect(
			describeDocumentVersionChange(
				DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.UPDATED_FROM_CONTEXT,
			),
		).toEqual({ kind: "updatedFromContext" });
		expect(
			describeDocumentVersionChange(
				DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.REGENERATED,
			),
		).toEqual({ kind: "regenerated" });
		expect(
			describeDocumentVersionChange(restoredVersionDescription(12)),
		).toEqual({ kind: "restored", version: 12 });
	});

	it("keeps the stored text of the writers it does not name", () => {
		expect(describeDocumentVersionChange("Assistant edit")).toBeNull();
		expect(describeDocumentVersionChange("Tightened the scope")).toBeNull();
		expect(describeDocumentVersionChange("Initial version")).toBeNull();
		expect(
			describeDocumentVersionChange("Restored to version 3 by hand"),
		).toBeNull();
		expect(describeDocumentVersionChange("")).toBeNull();
		expect(describeDocumentVersionChange(null)).toBeNull();
	});

	it("names no writer for a description that spells an object member", () => {
		for (const description of [
			"constructor",
			"__proto__",
			"toString",
			"hasOwnProperty",
			"valueOf",
		]) {
			expect(describeDocumentVersionChange(description)).toBeNull();
		}
	});

	it("stores the descriptions the writers have always stored", () => {
		// Stored rows already carry these, and the regeneration run looks its
		// own row up by "Regenerated version": a rename would split them.
		expect(DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.REGENERATED).toBe(
			"Regenerated version",
		);
		expect(DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.UPDATED_FROM_CONTEXT).toBe(
			"Updated with latest context",
		);
		expect(
			DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.RECOMMENDATION_APPLIED,
		).toBe("Applied a review recommendation");
		expect(restoredVersionDescription(4)).toBe("Restored to version 4");
	});
});
