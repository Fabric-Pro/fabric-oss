import { describe, expect, it } from "vitest";
import {
	DEFAULT_DOCUMENT_META,
	DOCUMENT_TIERS,
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
