import { DOCUMENT_SAVE_BASE_REQUIRED } from "@repo/utils/document-save-base";
import { describe, expect, it } from "vitest";
import {
	buildDocumentSaveInput,
	isSaveBaseRequiredRefusal,
} from "../document-save-input";

const SAVE = {
	projectId: "proj_1",
	documentId: "doc_1",
	content: "# Design\n\nWritten by hand.",
};

describe("buildDocumentSaveInput", () => {
	it("asks the server to complete a draft on an explicit Save", () => {
		expect(buildDocumentSaveInput({ ...SAVE, isManualSave: true })).toEqual(
			{
				projectId: "proj_1",
				id: "doc_1",
				content: SAVE.content,
				completeDraft: true,
			},
		);
	});

	it("does not ask on an autosave, so a document is not completed while it is being typed", () => {
		const input = buildDocumentSaveInput({ ...SAVE, isManualSave: false });

		expect(input).toEqual({
			projectId: "proj_1",
			id: "doc_1",
			content: SAVE.content,
		});
		expect(input).not.toHaveProperty("completeDraft");
	});

	describe("the base a save names (Fizzy #2946)", () => {
		const base = { version: 8, contentHash: "hash-of-the-saved-body" };

		it("carries the base whole on an autosave, an explicit Save and the Reject fallback", () => {
			expect(
				buildDocumentSaveInput({ ...SAVE, isManualSave: false, base }),
			).toMatchObject({
				expectedVersion: 8,
				expectedContentHash: base.contentHash,
			});
			expect(
				buildDocumentSaveInput({ ...SAVE, isManualSave: true, base }),
			).toMatchObject({
				completeDraft: true,
				expectedVersion: 8,
				expectedContentHash: base.contentHash,
			});
			expect(
				buildDocumentSaveInput({
					...SAVE,
					isManualSave: false,
					base,
					skipVersionBump: true,
					organizationId: "org-example",
				}),
			).toEqual({
				projectId: "proj_1",
				id: "doc_1",
				content: SAVE.content,
				expectedVersion: 8,
				expectedContentHash: base.contentHash,
				skipVersionBump: true,
				organizationId: "org-example",
			});
		});

		it("lets the base supersede the version-only guard of an accepted proposal", () => {
			expect(
				buildDocumentSaveInput({
					...SAVE,
					isManualSave: false,
					base,
					expectedVersion: 3,
				}),
			).toMatchObject({
				expectedVersion: 8,
				expectedContentHash: base.contentHash,
			});
		});

		it("keeps the version-only guard when there is no base", () => {
			const input = buildDocumentSaveInput({
				...SAVE,
				isManualSave: false,
				base: null,
				expectedVersion: 3,
			});
			expect(input).toMatchObject({ expectedVersion: 3 });
			expect(input).not.toHaveProperty("expectedContentHash");
		});

		it("names no base when none is given, as before", () => {
			const input = buildDocumentSaveInput({
				...SAVE,
				isManualSave: false,
			});
			expect(input).not.toHaveProperty("expectedVersion");
			expect(input).not.toHaveProperty("expectedContentHash");
		});
	});
});

describe("the AI accept descriptor (Fizzy #2946)", () => {
	const base = { version: 8, contentHash: "hash-of-the-saved-body" };

	it("passes a chat accept's descriptor through with its base", () => {
		const aiReview = {
			kind: "CHAT" as const,
			patchedSectionKeys: ["p1:scope#0", "p1:scope/detail#0"],
		};

		expect(
			buildDocumentSaveInput({
				...SAVE,
				isManualSave: false,
				base,
				aiReview,
			}),
		).toEqual({
			projectId: "proj_1",
			id: "doc_1",
			content: SAVE.content,
			expectedVersion: 8,
			expectedContentHash: "hash-of-the-saved-body",
			aiReview,
		});
	});

	it("passes a finding-driven revision's descriptor through unchanged", () => {
		const aiReview = {
			kind: "FINDING" as const,
			runId: "run_1",
			findingId: "finding_1",
			revisionToken: "signed.token",
		};

		expect(
			buildDocumentSaveInput({
				...SAVE,
				isManualSave: true,
				base,
				aiReview,
			}).aiReview,
		).toBe(aiReview);
	});

	it("sends none when not given", () => {
		expect(
			buildDocumentSaveInput({ ...SAVE, isManualSave: false, base }),
		).not.toHaveProperty("aiReview");
	});
});

describe("isSaveBaseRequiredRefusal", () => {
	it("recognizes the refusal of a save that named no base", () => {
		expect(
			isSaveBaseRequiredRefusal({
				code: "PRECONDITION_FAILED",
				data: { code: DOCUMENT_SAVE_BASE_REQUIRED },
			}),
		).toBe(true);
	});

	it("leaves every other failure to the caller", () => {
		expect(isSaveBaseRequiredRefusal({ code: "CONFLICT" })).toBe(false);
		expect(
			isSaveBaseRequiredRefusal({
				code: "PRECONDITION_FAILED",
				data: { code: "SOMETHING_ELSE" },
			}),
		).toBe(false);
		expect(isSaveBaseRequiredRefusal({ code: "PRECONDITION_FAILED" })).toBe(
			false,
		);
		expect(isSaveBaseRequiredRefusal(null)).toBe(false);
		expect(isSaveBaseRequiredRefusal(new Error("boom"))).toBe(false);
	});
});
