import { normalizeDocumentType } from "@repo/agent-types";
import { describe, expect, it } from "vitest";
import { getDocumentPrompt } from "../index";

describe("qa_strategy prompt", () => {
	it("resolves the dedicated config, not the general fallback", () => {
		const config = getDocumentPrompt("qa_strategy");
		expect(config.id).toBe("qa_strategy");
		expect(config.name).toMatch(/qa strategy/i);
	});

	it("requires the baseline testing-overview sections at every tier", () => {
		const config = getDocumentPrompt("qa_strategy");
		const required = config.sections
			.filter((s) => s.required)
			.map((s) => s.name);
		expect(required).toContain("Testing Overview & Objectives");
		expect(required).toContain("Scope of Testing");
		expect(required).toContain("Test Types & Approach");
		expect(required).toContain("Environments & Test Data");
	});

	it("offers the depth-tier sections (non-required) including a Coverage Gaps section", () => {
		const config = getDocumentPrompt("qa_strategy");
		const names = config.sections.map((s) => s.name);
		expect(names).toContain("Security Testing");
		expect(names).toContain("Performance Testing");
		expect(names).toContain("Accessibility Compliance");
		expect(names).toContain("Coverage Gaps & Open Items");
		const depthTier = config.sections.filter((s) =>
			[
				"Automated Regression Strategy",
				"Security Testing",
				"Performance Testing",
				"Accessibility Compliance",
				"Coverage Gaps & Open Items",
			].includes(s.name),
		);
		expect(depthTier).toHaveLength(5);
		expect(depthTier.every((s) => !s.required)).toBe(true);
	});

	it("normalizes QA_STRATEGY -> qa_strategy", () => {
		expect(normalizeDocumentType("QA_STRATEGY")).toBe("qa_strategy");
	});
});
