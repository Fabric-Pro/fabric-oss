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
		"modules/saas/agents/components/fabric-ai/FabricAIClient.tsx",
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

describe("simple mode engine", () => {
	const source = readSource(
		"modules/saas/agents/components/fabric-ai/FabricAIClient.tsx",
	);

	it("picks the engine through resolveChatEngine with the recorded engine", () => {
		expect(source).toMatch(
			/const chatEngine = resolveChatEngine\(\{[\s\S]{0,200}?conversationEngine,/,
		);
		expect(source).toMatch(
			/const restored = restoreFromConversationMetadata\(\s*activeConversation\.metadata,[\s\S]{0,200}?\);[\s\S]{0,300}?setConversationEngine\(restored\.engine\)/,
		);
	});

	it("runs the Orchestrator's iterative preset in simple mode", () => {
		expect(source).toMatch(
			/executionModeOverride=\{\s*uiMode === "simple" \? "iterative" : undefined\s*\}/,
		);
	});
});

describe("engine mismatch notice in simple mode (Fizzy #3093)", () => {
	const source = readSource(
		"modules/saas/agents/components/fabric-ai/FabricAIClient.tsx",
	);

	it("compares the open chat's engine with the new-chat engine", () => {
		expect(source).toMatch(
			/showsEngineMismatchNotice\(\{[^}]*chatEngine,[^}]*newChatEngine: readerEngine,/,
		);
	});

	it("gates on an open conversation and skips another member's shared one", () => {
		expect(source).toMatch(
			/hasOpenConversation: Boolean\(activeConversationId\),[^}]*\}\) && !\(activeConversation && !activeConversation\.isOwn\)/,
		);
	});

	it("renders the notice on the helper's answer, with the New button's handler", () => {
		expect(source).toMatch(/onClick=\{handleNewChat\}/);
		expect(source).toMatch(
			/\{engineMismatch && \(\s*<EngineMismatchNotice onNewChat=\{handleNewChat\} \/>\s*\)\}/,
		);
	});
});
