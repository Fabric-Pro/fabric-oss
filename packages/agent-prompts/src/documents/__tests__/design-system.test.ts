import { normalizeDocumentType } from "@repo/agent-types";
import { describe, expect, it } from "vitest";
import { getDocumentPrompt } from "../index";

describe("design_system prompt", () => {
	it("resolves the dedicated config, not the general fallback", () => {
		const config = getDocumentPrompt("design_system");
		expect(config.id).toBe("design_system");
		expect(config.name).toMatch(/design system/i);
	});

	it("requires the design.md gap, question, and source sections", () => {
		const names = getDocumentPrompt("design_system").sections.map(
			(section) => section.name,
		);
		expect(names).toContain("Design Gaps");
		expect(names).toContain("Open Questions");
		expect(names).toContain("Assets / Source References");
	});

	it("normalizes DESIGN_SYSTEM -> design_system", () => {
		expect(normalizeDocumentType("DESIGN_SYSTEM")).toBe("design_system");
	});
});
