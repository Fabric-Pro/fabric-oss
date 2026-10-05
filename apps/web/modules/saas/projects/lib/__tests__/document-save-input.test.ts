import { describe, expect, it } from "vitest";
import { buildDocumentSaveInput } from "../document-save-input";

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
});
