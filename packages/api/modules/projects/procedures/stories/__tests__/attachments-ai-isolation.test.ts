import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Guard the architectural AI-safety invariant — as it stands NOW,
// which is narrower than when this file was written.
//
// Originally this asserted a blanket rule: no attachment content reaches any
// agent path. That is no longer true, and pretending otherwise is worse than
// having no test. Context-only (UNLOCKED) attachments are now delivered to the
// model on purpose, through exactly one sanctioned path:
//
//   packages/api/modules/projects/lib/story-attachment-ai-context.ts
//     -> resolve-story-attachment-context-for-agent.ts  (the AI Assistant)
//     -> enhance-feature.ts                             (maturation / Clean Spec)
//
// What this file still guards is that the MEDIA resolver is not a second such
// path. It resolves in-body `story-media/` images and has no business reading
// attachment rows; if it starts to, attachment content would reach the model
// through a route with none of the resolver's designation or MIME gating.
//
// The rule that did NOT narrow: LOCKED attachments never reach a prompt, by any
// route. That one is enforced in the resolver's query, not here — see
// `lib/__tests__/story-attachment-ai-context.test.ts`.
describe("story-media resolver stays out of the attachment path", () => {
	const agentResolver = readFileSync(
		join(__dirname, "../resolve-story-media-for-agent.ts"),
		"utf8",
	);
	it("the agent media resolver never references the story-attachments prefix", () => {
		expect(agentResolver).not.toContain("story-attachments");
	});
	it("the agent media resolver does not include the attachments relation", () => {
		expect(agentResolver).not.toMatch(/attachments\s*:\s*true/);
	});
});
