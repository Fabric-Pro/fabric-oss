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

		it(`names placeholders as stale once the user supplies the value (${toolMode} mode)`, () => {
			const prompt = buildUnifiedSystemPrompt({
				documentType: "general",
				existingDocument,
				excludeDocumentBody: true,
				toolMode,
			});
			expect(prompt).toContain(
				"Placeholders such as TBD, TBC, to be determined, to be confirmed, not yet defined or not yet determined are stale once the user asks you to change the document and supplies the value they stand for, or asks you to take it from the provided context",
			);
			expect(prompt).toContain(
				"Leave every placeholder for any other value as it is, and never invent a value that neither the user nor the provided context gives.",
			);
			expect(prompt).toContain(
				"a commercial term such as a fee or a start date repeated in a summary, a schedule and a terms section",
			);
			expect(prompt).toContain("re-read every section");
		});
	}

	it("asks for a patch on every section that holds a stale placeholder (patch mode)", () => {
		const prompt = buildUnifiedSystemPrompt({
			documentType: "general",
			existingDocument,
			excludeDocumentBody: true,
			toolMode: "patch",
		});
		expect(prompt).toContain(
			"replace each placeholder for such a value wherever it appears in the document, in the same call, with a patch for every section that holds one",
		);
	});

	it("is present when the document body is embedded (legacy full-body mode)", () => {
		const prompt = buildUnifiedSystemPrompt({
			documentType: "general",
			existingDocument,
			excludeDocumentBody: false,
			toolMode: "write",
		});
		expect(prompt).toContain("CROSS-SECTION CONSISTENCY");
		expect(prompt).toContain(
			"never invent a value that neither the user nor the provided context gives",
		);
	});

	it("is absent when creating a new document (no existing document)", () => {
		const prompt = buildUnifiedSystemPrompt({
			documentType: "general",
			ragContexts: [],
		});
		expect(prompt).not.toContain("CROSS-SECTION CONSISTENCY");
	});
});
