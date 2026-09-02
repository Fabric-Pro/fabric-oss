import { describe, expect, it } from "vitest";
import {
	DOCUMENT_PIPELINE_LIMIT,
	getDocumentMeta,
	getDocumentStatusView,
	getPipelineDocuments,
	type PipelineDocument,
} from "../document-pipeline";

function doc(
	overrides: Partial<PipelineDocument> & { id: string },
): PipelineDocument {
	return {
		type: "GENERAL",
		title: "Untitled",
		status: "DRAFT",
		...overrides,
	};
}

describe("getPipelineDocuments", () => {
	it("returns an empty result for undefined or empty input", () => {
		expect(getPipelineDocuments(undefined)).toEqual({
			visible: [],
			total: 0,
			hasMore: false,
		});
		expect(getPipelineDocuments([])).toEqual({
			visible: [],
			total: 0,
			hasMore: false,
		});
	});

	it("excludes documents with isActive === false", () => {
		const result = getPipelineDocuments([
			doc({ id: "a", isActive: true }),
			doc({ id: "b", isActive: false }),
			doc({ id: "c" }),
		]);
		expect(result.total).toBe(2);
		expect(result.visible.map((d) => d.id)).toEqual(["a", "c"]);
	});

	it("orders documents by the stable pipeline sequence", () => {
		const result = getPipelineDocuments([
			doc({ id: "story", type: "USER_STORY" }),
			doc({ id: "prd", type: "PRD" }),
			doc({ id: "arch", type: "ARCHITECTURE" }),
		]);
		expect(result.visible.map((d) => d.id)).toEqual([
			"prd",
			"arch",
			"story",
		]);
	});

	it("sorts unknown types last", () => {
		const result = getPipelineDocuments([
			doc({ id: "mystery", type: "SOMETHING_NEW" }),
			doc({ id: "prd", type: "PRD" }),
		]);
		expect(result.visible.map((d) => d.id)).toEqual(["prd", "mystery"]);
	});

	it("keeps input order for documents of the same type (stable)", () => {
		const result = getPipelineDocuments([
			doc({ id: "prd-1", type: "PRD" }),
			doc({ id: "prd-2", type: "PRD" }),
			doc({ id: "prd-3", type: "PRD" }),
		]);
		expect(result.visible.map((d) => d.id)).toEqual([
			"prd-1",
			"prd-2",
			"prd-3",
		]);
	});

	it("renders one card per document, including multiple of the same type", () => {
		const result = getPipelineDocuments([
			doc({ id: "prd-1", type: "PRD" }),
			doc({ id: "prd-2", type: "PRD" }),
			doc({ id: "prd-3", type: "PRD" }),
		]);
		expect(result.total).toBe(3);
		expect(result.visible).toHaveLength(3);
	});

	it("caps the visible set at the limit and flags overflow", () => {
		const docs = Array.from({ length: 15 }, (_, i) =>
			doc({ id: `d-${i}`, title: `Doc ${i}` }),
		);
		const result = getPipelineDocuments(docs);
		expect(result.total).toBe(15);
		expect(result.visible).toHaveLength(DOCUMENT_PIPELINE_LIMIT);
		expect(result.hasMore).toBe(true);
	});

	it("shows all cards and no overflow when count equals the limit", () => {
		const docs = Array.from({ length: DOCUMENT_PIPELINE_LIMIT }, (_, i) =>
			doc({ id: `d-${i}` }),
		);
		const result = getPipelineDocuments(docs);
		expect(result.visible).toHaveLength(DOCUMENT_PIPELINE_LIMIT);
		expect(result.hasMore).toBe(false);
	});

	it("orders before capping — the visible top 6 is the highest-priority set, not the input head", () => {
		// A pipeline-last type (GENERAL) is first in the input, followed by the
		// six highest-priority types. Correct sort-then-slice drops GENERAL;
		// a slice-then-sort bug would keep it as the first visible card.
		const result = getPipelineDocuments([
			doc({ id: "general", type: "GENERAL" }),
			doc({ id: "biz", type: "BUSINESS_CASE" }),
			doc({ id: "prd", type: "PRD" }),
			doc({ id: "proposal", type: "PROPOSAL" }),
			doc({ id: "arch", type: "ARCHITECTURE" }),
			doc({ id: "tech", type: "TECHNICAL_SPEC" }),
			doc({ id: "api", type: "API_SPEC" }),
		]);
		expect(result.visible.map((d) => d.id)).toEqual([
			"biz",
			"prd",
			"proposal",
			"arch",
			"tech",
			"api",
		]);
		expect(result.visible.map((d) => d.id)).not.toContain("general");
		expect(result.hasMore).toBe(true);
	});

	it("does not let inactive documents inflate the overflow count", () => {
		const active = Array.from({ length: DOCUMENT_PIPELINE_LIMIT }, (_, i) =>
			doc({ id: `active-${i}` }),
		);
		const inactive = Array.from({ length: 3 }, (_, i) =>
			doc({ id: `inactive-${i}`, isActive: false }),
		);
		const result = getPipelineDocuments([...active, ...inactive]);
		expect(result.total).toBe(DOCUMENT_PIPELINE_LIMIT);
		expect(result.visible).toHaveLength(DOCUMENT_PIPELINE_LIMIT);
		expect(result.hasMore).toBe(false);
	});
});

describe("getDocumentMeta", () => {
	it("returns the correct human label for a known type", () => {
		expect(getDocumentMeta("PROPOSAL").label).toBe("Proposal");
		expect(getDocumentMeta("PRD").label).toBe("Requirements Document");
		expect(getDocumentMeta("API_SPEC").label).toBe("API Specification");
		expect(getDocumentMeta("DESIGN_SYSTEM").label).toBe("Design System");
	});

	it("does not carry the old mismatched labels", () => {
		expect(getDocumentMeta("PROPOSAL").label).not.toBe("Frontend Design");
		expect(getDocumentMeta("API_SPEC").label).not.toBe(
			"Security Guidelines",
		);
	});

	it("falls back to a default for unknown types", () => {
		expect(getDocumentMeta("SOMETHING_NEW").label).toBe("Document");
	});
});

describe("getDocumentStatusView", () => {
	it("maps COMPLETE to Ready", () => {
		expect(getDocumentStatusView("COMPLETE")).toEqual({
			label: "Ready",
			tone: "complete",
		});
	});

	it("maps in-flight statuses to Active", () => {
		expect(getDocumentStatusView("GENERATING").label).toBe("Active");
		expect(getDocumentStatusView("IN_PROGRESS").label).toBe("Active");
	});

	it("maps everything else to Pending", () => {
		for (const status of ["DRAFT", "REVIEW", "FAILED", "UNKNOWN"]) {
			expect(getDocumentStatusView(status).label).toBe("Pending");
		}
	});
});
