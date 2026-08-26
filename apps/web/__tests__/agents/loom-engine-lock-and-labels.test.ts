/**
 * Guards two follow-ups from the #2040 QA pass.
 *
 * 1. The engine pills answered a click by doing nothing. A conversation is
 *    bound to the engine it was created on — an effect keyed on the active
 *    conversation restores that engine from its metadata — so clicking another
 *    pill set the state and had it reverted before the next send, which still
 *    went to the original engine's endpoint. Reproduced on a deployed build in
 *    both directions. The binding is deliberate; a control that looks live and
 *    isn't is not, so the pills are disabled and say why.
 *
 * 2. The MCP toggles had no accessible name. The server name sits in plain
 *    text beside the switch, so a screen reader announced "switch, off" with
 *    nothing to identify it — against the repo's own rule that icon-only
 *    controls carry an aria-label or a tooltip.
 *
 * Source-read rather than rendered: FabricAIClient pulls in the whole chat
 * surface, and this checks a wiring invariant, not behavior. Mirrors
 * stream-max-duration-drift.test.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
	return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

describe("engine pills while a conversation is loaded", () => {
	const source = readSource(
		"app/(saas)/app/agents/fabric-ai/FabricAIClient.tsx",
	);

	it("derives the lock from the active conversation", () => {
		expect(source).toMatch(
			/const engineLockedToConversation = Boolean\(activeConversationId\)/,
		);
	});

	it("disables all three engine pills", () => {
		const disabled = source.match(
			/disabled=\{\s*engineLockedToConversation\s*\}/g,
		);
		expect(disabled).toHaveLength(3);
	});

	it("explains the lock in each pill's tooltip", () => {
		// Silent disabling is the same defect in a quieter form: the user
		// still has no idea why the control does nothing.
		const explained = source.match(
			/engineLockedToConversation\s*\n?\s*\?\s*engineLockNote/g,
		);
		expect(explained).toHaveLength(3);
		expect(source).toMatch(/const engineLockNote =/);
	});
});

describe("MCP server toggle accessibility", () => {
	const source = readSource(
		"modules/saas/agents/components/OrchestratorConfigPanel.tsx",
	);

	it("names the server the switch belongs to", () => {
		expect(source).toMatch(
			/aria-label=\{`Enable \$\{config\.displayName \?\? "MCP server"\} for this chat`\}/,
		);
	});
});
