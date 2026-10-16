/**
 * Guards how the full page wires Fabric Agent's session history.
 *
 * The list, its changes and the read-only view of a shared session are tested
 * as components (ConversationHistoryPanel, SharedSessionView); this checks the
 * page puts them in the places a person meets them. Source-read rather than
 * rendered, for the reason `loom-engine-lock-and-labels.test.ts` gives:
 * FabricAIClient pulls in the whole chat surface, and this checks wiring, not
 * behavior. The behavior is covered where the pieces are rendered.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	join(
		process.cwd(),
		"modules/saas/agents/components/fabric-ai/FabricAIClient.tsx",
	),
	"utf-8",
);

describe("the full page's session history", () => {
	it("shows the same history panel in the sidebar tab and in the history sheet", () => {
		expect(source.match(/<ConversationHistoryPanel/g)).toHaveLength(2);
		expect(source).not.toMatch(/<HistoryTabContent/);
	});

	it("lets go of the open session when it is deleted from the history", () => {
		expect(
			source.match(/onDeleted=\{handleConversationDeleted\}/g),
		).toHaveLength(2);
		expect(source).toMatch(
			/if \(deletedId === activeConversationId\) \{\s*selectConversation\(null\);/,
		);
	});

	it("reads a conversation another person shared instead of opening a chat on it", () => {
		const shared = source.indexOf(
			"activeConversation && !activeConversation.isOwn",
		);
		const firstChat = source.indexOf("deepResearchEnabled ? (");

		expect(shared).toBeGreaterThan(-1);
		expect(shared).toBeLessThan(firstChat);
	});

	it("continues from a shared conversation on the reader's own engine, with the one flow the drawer uses", () => {
		expect(source).toMatch(
			/const readerEngine = resolveChatEngine\(\{[^}]*conversationEngine: null,/,
		);
		expect(source).toMatch(
			/<SharedSessionView[\s\S]{0,300}?engine=\{readerEngine\}\s*onContinue=\{handleContinuedChat\}/,
		);
		expect(source).toMatch(
			/continuedChat\.current = chat;\s*selectConversation\(chat\.id\);/,
		);
	});

	it("restores a chat continued from a shared one onto the engine it was continued on, and takes nothing from the shared one itself", () => {
		expect(
			source.match(
				/continuedChat\.current\?\.id === (?:activeConversationId|activeConversation\.id)\s*\? continuedChat\.current\.engine\s*: undefined/g,
			),
		).toHaveLength(2);
		expect(source).toMatch(/!activeConversation\.isOwn\s*\) \{\s*return;/);
		expect(source).toMatch(/if \(activeConversation\?\.isOwn\) \{/);
	});
});
