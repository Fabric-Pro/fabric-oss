/**
 * Tests for buildFollowUpInstructions — the prompt section that steers the
 * document-generator family to ask clarifying questions by emitting a
 * `clarifying-question` JSON block (which the agent turns into the interactive
 * card), honor the project's frequency policy, and record dismissed questions as
 * open items.
 *
 * Run with: pnpm --filter @repo/agent-prompts test
 */

import { describe, expect, it } from "vitest";
import { buildFollowUpInstructions } from "../src/core/follow-up-questions";

type DocType = Parameters<typeof buildFollowUpInstructions>[0];

describe("buildFollowUpInstructions", () => {
	const text = buildFollowUpInstructions("PRD" as DocType);

	it("instructs the model to emit a clarifying-question block with options", () => {
		expect(text).toContain("clarifying-question");
		expect(text.toLowerCase()).toContain("options");
		// JSON shape the agent parser (extractClarifyingQuestion) expects.
		expect(text).toContain('"question"');
	});

	it("records dismissed questions as open items (pause, don't guess)", () => {
		expect(text).toContain("Open Questions");
		expect(text.toLowerCase()).toContain("dismiss");
	});

	it("references all three frequency tiers", () => {
		expect(text).toContain("MINIMAL");
		expect(text).toContain("BALANCED");
		expect(text).toContain("THOROUGH");
	});

	it("preserves the non-empty-content rule for document writes", () => {
		expect(text.toLowerCase()).toContain("must not be empty");
	});
});
