import { describe, expect, it } from "vitest";
import {
	DOCUMENT_VERSION_CHANGE_DESCRIPTIONS,
	describeDocumentVersionChange,
	documentVersionMaker,
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

describe("documentVersionMaker", () => {
	// A history as the writers leave it: each row holds its version's body,
	// most with the description and time of the change that replaced it.
	const rows = new Map(
		[
			{
				version: 1,
				changeDescription: "Initial version",
				createdAt: "t1",
			},
			{ version: 2, changeDescription: null, createdAt: "t2" },
			{
				version: 3,
				changeDescription: "Pre-regeneration snapshot (auto)",
				createdAt: "t3",
			},
			{
				version: 4,
				changeDescription:
					DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.REGENERATED,
				createdAt: "t4",
			},
			{ version: 5, changeDescription: null, createdAt: "t5" },
			{
				version: 6,
				changeDescription:
					DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.SECTION_REVISED,
				createdAt: "t6",
			},
			{
				version: 7,
				changeDescription: restoredVersionDescription(6),
				createdAt: "t7",
			},
		].map((row) => [row.version, row]),
	);

	it("reads a creation or a regeneration from its own row", () => {
		expect(documentVersionMaker(1, rows)).toEqual({
			description: "Initial version",
			at: "t1",
		});
		expect(documentVersionMaker(4, rows)).toEqual({
			description: DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.REGENERATED,
			at: "t4",
		});
	});

	it("reads any other version's maker from the row before it", () => {
		// v7's body came from the section revision stored on row 6, and the
		// current v8 from the restore stored on row 7.
		expect(documentVersionMaker(7, rows)).toEqual({
			description: DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.SECTION_REVISED,
			at: "t6",
		});
		expect(documentVersionMaker(8, rows)).toEqual({
			description: restoredVersionDescription(6),
			at: "t7",
		});
		// A save that recorded no description still has its time.
		expect(documentVersionMaker(6, rows)).toEqual({
			description: null,
			at: "t5",
		});
	});

	it("knows no maker after a creation, a regeneration or a pre-regeneration snapshot, or without the row before", () => {
		const unknown = { description: null, at: null };
		// The first change after a creation or a regeneration found that
		// row already there and stored nothing.
		expect(documentVersionMaker(2, rows)).toEqual(unknown);
		expect(documentVersionMaker(5, rows)).toEqual(unknown);
		// A rejected regeneration leaves only its snapshot behind.
		expect(
			documentVersionMaker(
				4,
				new Map([
					[
						3,
						rows.get(3) as NonNullable<ReturnType<typeof rows.get>>,
					],
				]),
			),
		).toEqual(unknown);
		expect(documentVersionMaker(12, rows)).toEqual(unknown);
	});

	it("reads version 1 as the creation even without a creation row", () => {
		// An upload, or an empty document its first generation filled: the
		// first edit snapshots v1 with its own description.
		const edited = new Map([
			[
				1,
				{
					version: 1,
					changeDescription:
						DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.CHAT_EDIT,
					createdAt: "t1",
				},
			],
		]);
		expect(documentVersionMaker(1, edited)).toEqual({
			description: "Initial version",
			at: null,
		});
		expect(documentVersionMaker(1, new Map())).toEqual({
			description: "Initial version",
			at: null,
		});
		expect(documentVersionMaker(2, edited)).toEqual({
			description: DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.CHAT_EDIT,
			at: "t1",
		});
	});

	it("reads rows of writers since removed as their own maker", () => {
		for (const description of [
			"Initial version from external source",
			"Initial version from pipeline",
		]) {
			const legacy = new Map([
				[
					1,
					{
						version: 1,
						changeDescription: description,
						createdAt: "t1",
					},
				],
				[2, { version: 2, changeDescription: null, createdAt: "t2" }],
			]);
			expect(documentVersionMaker(1, legacy)).toEqual({
				description,
				at: "t1",
			});
			expect(documentVersionMaker(2, legacy)).toEqual({
				description: null,
				at: null,
			});
		}
	});
});
