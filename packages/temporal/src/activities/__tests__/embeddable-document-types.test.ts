import { describe, expect, it } from "vitest";
import { EMBEDDABLE_DOCUMENT_TYPES } from "../project-document-generation";

describe("EMBEDDABLE_DOCUMENT_TYPES", () => {
	it("includes BUSINESS_CASE so generated business cases feed RAG", () => {
		expect(EMBEDDABLE_DOCUMENT_TYPES).toContain("BUSINESS_CASE");
	});

	it("includes DESIGN_SYSTEM so generated design systems feed RAG", () => {
		expect(EMBEDDABLE_DOCUMENT_TYPES).toContain("DESIGN_SYSTEM");
	});

	it("includes QA_STRATEGY so generated QA strategies feed RAG", () => {
		expect(EMBEDDABLE_DOCUMENT_TYPES).toContain("QA_STRATEGY");
	});

	it("includes SRS so generated requirements specs feed RAG", () => {
		expect(EMBEDDABLE_DOCUMENT_TYPES).toContain("SRS");
	});
});
