import {
	DOCUMENT_TIERS as SHARED_DOCUMENT_TIERS,
	isDocumentAvailable as sharedIsDocumentAvailable,
} from "@repo/database/src/document-dependency-graph";
import { describe, expect, it } from "vitest";
import {
	alignBatchDocuments,
	DEFAULT_DOCUMENT_META,
	DOCUMENT_TIERS,
	type DocumentSelection,
	getPrerequisiteHint,
	isDocumentAvailable,
} from "../documents";

describe("design system onboarding document", () => {
	it("is available without prerequisites", () => {
		expect(DOCUMENT_TIERS.DESIGN_SYSTEM).toEqual({
			tier: 1,
			prerequisites: [],
		});
		expect(isDocumentAvailable("DESIGN_SYSTEM", new Set())).toBe(true);
	});

	it("uses the design.md document metadata", () => {
		expect(DEFAULT_DOCUMENT_META.DESIGN_SYSTEM.title).toBe(
			"Design System (design.md)",
		);
	});
});

describe("wizard prerequisite graph", () => {
	it("hands out the shared graph rather than a second copy", () => {
		// Identity, not equality. A structurally-equal copy is exactly the state
		// this module was in before — matching the workflow's phases by hand and
		// free to drift from them.
		expect(DOCUMENT_TIERS).toBe(SHARED_DOCUMENT_TIERS);
		expect(isDocumentAvailable).toBe(sharedIsDocumentAvailable);
	});

	it("still gates the technical documents behind a requirements doc", () => {
		expect(isDocumentAvailable("ARCHITECTURE", new Set())).toBe(false);
		expect(isDocumentAvailable("ARCHITECTURE", new Set(["PROPOSAL"]))).toBe(
			true,
		);
		expect(getPrerequisiteHint("ARCHITECTURE")).toBe(
			"Generate PRD or Proposal first",
		);
	});
});

describe("alignBatchDocuments — matching started documents to their selections", () => {
	const selection = (type: string, selected = true): DocumentSelection =>
		({
			type,
			title: `${type} title`,
			description: "",
			prompt: "",
			selected,
		}) as DocumentSelection;

	it("keeps every later document on its own type when one type was skipped", () => {
		// Fizzy #1930: the batch skips a type its capability gate refuses and
		// returns the rest in request order. Zipped against the full selection,
		// the architecture document would have been labelled "API_SPEC".
		const aligned = alignBatchDocuments(
			[
				selection("PRD"),
				selection("API_SPEC"),
				selection("ARCHITECTURE"),
				selection("GENERAL", false),
			],
			[{ id: "doc_prd" }, { id: "doc_architecture" }],
			[{ type: "API_SPEC" }],
		);

		expect(aligned.doc_prd.type).toBe("PRD");
		expect(aligned.doc_architecture.type).toBe("ARCHITECTURE");
		expect(Object.keys(aligned)).toHaveLength(2);
	});

	it("zips one to one when nothing was skipped", () => {
		const aligned = alignBatchDocuments(
			[selection("PRD"), selection("ARCHITECTURE")],
			[{ id: "a" }, { id: "b" }],
			[],
		);
		expect(aligned.a.type).toBe("PRD");
		expect(aligned.b.type).toBe("ARCHITECTURE");
	});
});
