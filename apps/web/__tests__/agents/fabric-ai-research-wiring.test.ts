/**
 * Guards how the full page wires Deep Research to its runtime transport.
 *
 * The transport (`useResearchRuntimeStream`), the selector
 * (`useResearchRunStream`) and the chat (`DeepResearchInlineChat`) are tested
 * where they are rendered; this checks the page opens only the reader's own
 * Research conversation on the Research surface, records a new run's
 * conversation, and keeps the question in the stream alone. Source-read
 * rather than rendered, for the reason `loom-engine-lock-and-labels.test.ts`
 * gives: FabricAIClient pulls in the whole chat surface.
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

describe("the full page's Deep Research", () => {
	it("opens only the reader's own Research conversation, on the Research surface", () => {
		expect(source).toMatch(
			/const researchConversationId =\s*deepResearchEnabled &&\s*activeConversation\?\.isOwn &&\s*activeConversation\.id === activeConversationId &&\s*restoreFromConversationMetadata\(activeConversation\.metadata\)\.mode ===\s*"research"\s*\? activeConversation\.id\s*: null;/,
		);
		expect(source).toMatch(
			/useResearchRunStream\(\{[\s\S]{0,300}?conversationId: researchConversationId,\s*onConversationStarted: handleResearchConversationStarted,/,
		);
	});

	it("records a new run's conversation: the research engine, the page's conversation and the history list", () => {
		expect(source).toMatch(
			/const handleResearchConversationStarted = useCallback\(\s*\(threadId: string\) => \{[\s\S]{0,200}?setConversationEngine\("research"\);\s*onConversationChange\(threadId\);\s*refetchList\(\);/,
		);
	});

	it("starts New Research by leaving the open conversation", () => {
		expect(source).toMatch(
			/const handleNewResearch = useCallback\(\(\) => \{\s*selectConversation\(null\);\s*deepResearchStream\.reset\(\);/,
		);
		expect(source).toMatch(/onReset=\{handleNewResearch\}/);
	});

	it("sends straight to the stream, whose sendQuery guards an empty or second run", () => {
		expect(source).toMatch(/onSend=\{deepResearchStream\.sendQuery\}/);
		expect(source).not.toMatch(/handleDeepResearchSend|resetDeepResearch/);
	});

	it("says when the runtime did not take a stop", () => {
		expect(source).toMatch(
			/useResearchRunStream\(\{[\s\S]{0,400}?onStopFailed: \(\) =>\s*toast\.message\(/,
		);
	});

	it("keeps the question in the stream alone", () => {
		expect(source).not.toMatch(/deepResearchQuery/);
		expect(source).not.toMatch(/deepResearchHasInteracted/);
		expect(source).not.toMatch(/useWorkflowTemplateStream/);
	});
});
