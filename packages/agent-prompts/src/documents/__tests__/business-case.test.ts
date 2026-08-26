import { normalizeDocumentType } from "@repo/agent-types";
import { describe, expect, it } from "vitest";
import { getDocumentPrompt } from "../index";

describe("business_case prompt", () => {
	it("resolves the dedicated config, not the general fallback", () => {
		const config = getDocumentPrompt("business_case");
		expect(config.id).toBe("business_case");
		expect(config.name).toMatch(/business case/i);
	});

	it("requires the AC-2 Business-Case-specific sections", () => {
		const config = getDocumentPrompt("business_case");
		const names = config.sections.map((s) => s.name);
		expect(names).toContain("Executive Summary");
		expect(names).toContain("Options Considered");
		expect(names).toContain("Recommendation & Next Step");
	});

	it("normalizes BUSINESS_CASE -> business_case", () => {
		expect(normalizeDocumentType("BUSINESS_CASE")).toBe("business_case");
	});
});
