/**
 * Tests for the cross-section consistency (propagation) clause in the editing
 * prompt. Pins the fix: when editing an existing document, the prompt must tell
 * the model to propagate a cross-cutting change to every affected section (so
 * it can't update the Use Cases but leave the Acceptance Criteria stale).
 *
 * Run with: pnpm --filter @repo/agent-prompts test
 */

import { describe, expect, it } from "vitest";
import { buildUnifiedSystemPrompt } from "../src/builders/unified-prompt-builder";

const existingDocument = [
	"# Feature Title",
	"",
	"## Use Cases",
	"",
	"UC1: a user does the thing.",
	"",
	"## Acceptance Criteria",
	"",
	"GIVEN a thing WHEN it happens THEN it works.",
].join("\n");

describe("cross-section consistency clause", () => {
	for (const toolMode of ["write", "patch"] as const) {
		it(`is present when editing an existing document (${toolMode} mode)`, () => {
			const prompt = buildUnifiedSystemPrompt({
				documentType: "general",
				existingDocument,
				excludeDocumentBody: true,
				toolMode,
			});
			expect(prompt).toContain("CROSS-SECTION CONSISTENCY");
			expect(prompt).toContain("Acceptance Criteria");
		});
	}

	it("is present when the document body is embedded (legacy full-body mode)", () => {
		const prompt = buildUnifiedSystemPrompt({
			documentType: "general",
			existingDocument,
			excludeDocumentBody: false,
			toolMode: "write",
		});
		expect(prompt).toContain("CROSS-SECTION CONSISTENCY");
	});

	it("is absent when creating a new document (no existing document)", () => {
		const prompt = buildUnifiedSystemPrompt({
			documentType: "general",
			ragContexts: [],
		});
		expect(prompt).not.toContain("CROSS-SECTION CONSISTENCY");
	});
});
