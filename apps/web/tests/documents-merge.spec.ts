import { expect, test } from "@playwright/test";
import {
	DEFAULT_DOCUMENT_META,
	makePreloadedDocs,
	mergeSelectedWithRecommendations,
	type ProjectDocumentType,
	type Recommendation,
} from "../modules/saas/projects/components/wizard/documents";

// These are pure function tests executed in Playwright's Node test runner.
// No browser/page is needed.

test.describe("documents.ts merge and preload logic", () => {
	test("makePreloadedDocs creates selected docs with default metadata", () => {
		const selected: ProjectDocumentType[] = ["PRD", "ARCHITECTURE", "PRD"]; // duplicates ignored
		const pre = makePreloadedDocs(selected);

		expect(pre.length).toBe(2);

		const prd = pre.find((d) => d.type === "PRD");
		const arch = pre.find((d) => d.type === "ARCHITECTURE");

		expect(prd).toBeTruthy();
		expect(arch).toBeTruthy();

		expect(prd?.title).toBe(DEFAULT_DOCUMENT_META.PRD.title);
		expect(prd?.description).toBe(DEFAULT_DOCUMENT_META.PRD.description);
		expect(prd?.prompt).toBe(DEFAULT_DOCUMENT_META.PRD.defaultPrompt);
		expect(prd?.selected).toBe(true);

		expect(arch?.title).toBe(DEFAULT_DOCUMENT_META.ARCHITECTURE.title);
		expect(arch?.selected).toBe(true);
	});

	test("mergeSelectedWithRecommendations respects Step 4 selection and uses rec metadata when available", () => {
		const selected: ProjectDocumentType[] = ["PRD", "ARCHITECTURE"];
		const recs: Recommendation[] = [
			{
				type: "PRD",
				title: "AI PRD Title",
				description: "AI PRD Description",
				suggestedPrompt: "Write a PRD",
				score: 42,
			},
			{
				type: "USER_STORY",
				title: "User Stories Title",
				description: "User Stories Description",
				suggestedPrompt: "Write user stories",
				score: 5,
			},
		];

		const merged = mergeSelectedWithRecommendations(selected, recs);

		// Only selected documents appear - no extra recommendations added
		expect(merged.map((d) => d.type)).toEqual(["PRD", "ARCHITECTURE"]);
		expect(merged.length).toBe(2);

		const prd = merged[0];
		const arch = merged[1];

		expect(prd.selected).toBe(true);
		expect(arch.selected).toBe(true);

		// PRD uses AI metadata
		expect(prd.title).toBe("AI PRD Title");
		expect(prd.description).toBe("AI PRD Description");
		expect(prd.prompt).toBe("Write a PRD");

		// ARCHITECTURE falls back to defaults
		expect(arch.title).toBe(DEFAULT_DOCUMENT_META.ARCHITECTURE.title);
		expect(arch.description).toBe(
			DEFAULT_DOCUMENT_META.ARCHITECTURE.description,
		);
		expect(arch.prompt).toBe(
			DEFAULT_DOCUMENT_META.ARCHITECTURE.defaultPrompt,
		);
	});

	test("mergeSelectedWithRecommendations with no selections returns empty array", () => {
		const selected: ProjectDocumentType[] = [];
		const recs: Recommendation[] = [
			{
				type: "API_SPEC",
				title: "API Spec",
				description: "Describe API",
				suggestedPrompt: "Write API spec",
				score: 12,
			},
			{
				type: "TECHNICAL_SPEC",
				title: "Tech Spec",
				description: "Describe tech",
				suggestedPrompt: "Write tech spec",
				score: 3,
			},
		];

		const merged = mergeSelectedWithRecommendations(selected, recs);

		// When no selection is made, return empty array
		// User can generate documents later from the project page
		expect(merged).toEqual([]);
		expect(merged.length).toBe(0);
	});
});

// Step 5 label mapping test to ensure persisted IDs map to original selection metadata
// Mirrors the logic in DocumentGenerationStep: build id -> meta map on generation start
// and use that map to render friendly titles instead of a generic fallback.
test("docMetaById mapping ensures correct document titles during generation", () => {
	type DocumentSelection = {
		type: ProjectDocumentType;
		title: string;
		description: string;
		prompt: string;
		selected: boolean;
	};

	const selectedDocs: DocumentSelection[] = [
		{
			type: "PRD",
			title: "Product Requirements Document",
			description: "Define product goals",
			prompt: "",
			selected: true,
		},
		{
			type: "ARCHITECTURE",
			title: "Technical Architecture",
			description: "System design",
			prompt: "",
			selected: true,
		},
	];

	// Simulate server response with persisted IDs, returned in the same order as requested
	const serverResponse = {
		documents: [{ id: "doc-id-1" }, { id: "doc-id-2" }],
	};

	// Build mapping as done in DocumentGenerationStep
	const idMap: Record<string, DocumentSelection> = {};
	serverResponse.documents.forEach((doc, idx) => {
		const meta = selectedDocs[idx];
		if (meta) {
			idMap[doc.id] = meta;
		}
	});

	// Assertions: mapping matches selected meta and labels resolve correctly
	expect(idMap["doc-id-1"]).toBeTruthy();
	expect(idMap["doc-id-1"].title).toBe("Product Requirements Document");
	expect(idMap["doc-id-1"].type).toBe("PRD");

	expect(idMap["doc-id-2"]).toBeTruthy();
	expect(idMap["doc-id-2"].title).toBe("Technical Architecture");
	expect(idMap["doc-id-2"].type).toBe("ARCHITECTURE");

	// Simulate UI rendering fallback: title || "Document"
	const label1 = idMap["doc-id-1"]?.title || "Document";
	const label2 = idMap["doc-id-2"]?.title || "Document";
	expect(label1).toBe("Product Requirements Document");
	expect(label2).toBe("Technical Architecture");
});
