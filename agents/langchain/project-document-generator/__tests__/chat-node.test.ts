/**
 * Comprehensive tests for Project Document Generator Chat Node
 *
 * Tests cover:
 * 1. Initial document generation with RAG context
 * 2. Follow-up questions (should make targeted edits, not regenerate)
 * 3. After confirmation (summary only, no regeneration)
 * 4. Frontend actions handling (regenerate_document)
 * 5. Error handling and retry logic
 */

import {
	AIMessage,
	type BaseMessage,
	HumanMessage,
	type MessageContentComplex,
	SystemMessage,
	ToolMessage,
} from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	chatNode,
	FINALIZE_GUARD_EMPTY_RESPONSE_USER_MESSAGE,
	sanitizeMessagesForModel,
	stripToolDefinitions,
	TRUNCATED_EMPTY_RESPONSE_USER_MESSAGE,
	VISION_UNSUPPORTED_USER_MESSAGE,
} from "../nodes/chat-node";
import type { AgentState } from "../state";
// Resolves to the mocked "../utils" module (vi.mock below is hoisted above
// this import) — used to assert on the options object chat-node.ts passes
// to getAgentModelAsync, e.g. that maxTokensForConfig is wired through.
import { getAgentModelAsync, MAX_TOOL_ITERATIONS } from "../utils";

// Mock the external dependencies
const mockInvoke = vi.fn();
vi.mock("../utils", async () => ({
	DEFAULT_RECURSION_LIMIT: 50,
	MAX_RETRIES: 3,
	MAX_JSON_RETRIES: 5,
	MAX_TOOL_ITERATIONS: 20,
	getAgentModelAsync: vi.fn().mockResolvedValue({
		bindTools: vi.fn().mockImplementation(function (this: any) {
			return this;
		}),
		invoke: (...args: unknown[]) => mockInvoke(...args),
	}),
	extractProviderConfig: vi.fn().mockReturnValue({ model: "gpt-4o" }),
	// Mock-level stand-in mirroring the real function's shape closely enough
	// to exercise the maxTokensForConfig wiring below — not the real
	// resolution paths, which stay mocked out via getAgentModelAsync.
	reasoningOutputAllowanceForConfig: vi
		.fn()
		.mockImplementation(
			(cfg: { model?: string; isReasoningModel?: boolean }) =>
				cfg?.isReasoningModel === true ||
				cfg?.model === "system.ai.claude-sonnet-5"
					? 12000
					: 0,
		),
	isJsonParseError: vi.fn().mockReturnValue(false),
	// The chat-node catch block consults all three classifiers before it
	// decides between fail-fast and retry. They default to false so a test
	// that rejects the model call lands on the branch it is actually
	// exercising; override per-test to target the vision/context paths.
	isContextLengthError: vi.fn().mockReturnValue(false),
	isVisionUnsupportedError: vi.fn().mockReturnValue(false),
	calculateRetryDelay: vi.fn().mockReturnValue(100),
	sleep: vi.fn().mockResolvedValue(undefined),
	// The real implementation (from the dependency-free tool-rounds
	// submodule) so tests that build up long tool-call histories exercise
	// the actual finalize-mode threshold. The rest of the "../utils" barrel
	// stays mocked to keep model-factory's heavy imports out of the test.
	countToolRoundsSinceLastHuman: (
		await vi.importActual<typeof import("../utils/tool-rounds")>(
			"../utils/tool-rounds",
		)
	).countToolRoundsSinceLastHuman,
	// Real implementations from the dependency-free patch-response submodule
	// (same reason as tool-rounds): the patch-mode success path calls both,
	// and their output shapes the ToolMessage / confirm follow-up the tests
	// assert on.
	...(await vi.importActual<typeof import("../utils/patch-response")>(
		"../utils/patch-response",
	)),
	// chat-node summarizes the outgoing message shape before every model
	// invocation (diagnostics for empty-body provider 400s), so the mocked
	// barrel has to export it or any test reaching the model call throws on a
	// missing export.
	summarizeMessagesForLogging: vi.fn().mockReturnValue([]),
}));

vi.mock("../prompts", () => ({
	buildSystemPrompt: vi.fn().mockReturnValue("Test system prompt"),
	buildSystemPromptAsync: vi.fn().mockResolvedValue("Test system prompt"),
	getPredictStateConfig: vi.fn().mockReturnValue([
		{
			state_key: "document",
			tool: "write_document_local",
			tool_argument: "document",
		},
	]),
}));

vi.mock("@repo/agent-core/services/usage-logging", () => ({
	logAgentUsageFromRunnableConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@copilotkit/sdk-js/langgraph", () => ({
	convertActionsToDynamicStructuredTools: vi.fn().mockReturnValue([]),
}));

// Helper to create mock states
function createMockState(overrides: Partial<AgentState> = {}): AgentState {
	return {
		messages: [],
		document: "",
		documentType: "architecture",
		projectContext: {
			name: "Test Project",
			description: "A test project",
			techStack: [],
			features: [],
		},
		ragContexts: [],
		systemPrompt: undefined,
		focusAnchor: undefined,
		streamingContent: "",
		retryCount: 0,
		error: undefined,
		copilotkit: { actions: [], context: [] },
		hasTeamsIntegration: false,
		hasRepoIntegration: false,
		projectId: "",
		userId: "",
		organizationId: undefined,
		isRegeneration: false,
		...overrides,
	};
}

// Helper to create AI message with tool call
function createAIMessageWithToolCall(
	toolName: string,
	args: Record<string, any> = {},
	id?: string,
) {
	const callId =
		id ?? `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
	return new AIMessage({
		content: "",
		tool_calls: [
			{
				id: callId,
				name: toolName,
				args,
			},
		],
	});
}

// Helper to get the tool call id from an AI message
function getToolCallId(message: AIMessage): string {
	const toolCalls = message.tool_calls;
	if (!toolCalls || toolCalls.length === 0 || !toolCalls[0].id) {
		throw new Error("Message does not have a valid tool call id");
	}
	return toolCalls[0].id;
}

// Helper to create tool response message
function createToolMessage(content: string, toolCallId: string) {
	return new ToolMessage({
		content,
		tool_call_id: toolCallId,
	});
}

describe("Project Document Generator Chat Node - Message Flow Tests", () => {
	describe("isAfterConfirmation detection", () => {
		it("should detect immediate post-confirmation state (tool response is last)", () => {
			const confirmToolCall = createAIMessageWithToolCall(
				"confirm_changes",
				{},
				"confirm_1",
			);
			const toolResponse = createToolMessage(
				'{"accepted":true}',
				getToolCallId(confirmToolCall),
			);

			const messages = [
				new HumanMessage("Generate architecture doc"),
				createAIMessageWithToolCall(
					"write_document_local",
					{ document: "# Architecture\n..." },
					"write_1",
				),
				createToolMessage("Document written.", "call_1"),
				confirmToolCall,
				toolResponse,
			];

			// This state should be detected as "after confirmation"
			expect(messages[messages.length - 1]).toBeInstanceOf(ToolMessage);
			expect(
				(messages[messages.length - 2] as AIMessage).tool_calls?.[0]
					.name,
			).toBe("confirm_changes");
		});

		it("should NOT detect follow-up question as after confirmation", () => {
			const confirmToolCall = createAIMessageWithToolCall(
				"confirm_changes",
				{},
				"confirm_2",
			);
			const toolResponse = createToolMessage(
				'{"accepted":true}',
				getToolCallId(confirmToolCall),
			);

			const messages = [
				new HumanMessage("Generate architecture doc"),
				createAIMessageWithToolCall(
					"write_document_local",
					{ document: "# Architecture\n..." },
					"write_2",
				),
				createToolMessage("Document written.", "call_1"),
				confirmToolCall,
				toolResponse,
				new HumanMessage("Add a section about API design"), // Follow-up question
			];

			// Last message is HumanMessage, NOT ToolMessage
			expect(messages[messages.length - 1]).toBeInstanceOf(HumanMessage);
		});

		it("should handle multiple conversation turns correctly", () => {
			const confirmToolCall1 = createAIMessageWithToolCall(
				"confirm_changes",
				{},
				"confirm_3",
			);
			const confirmToolCall2 = createAIMessageWithToolCall(
				"confirm_changes",
				{},
				"confirm_4",
			);

			const messages = [
				// First document generation
				new HumanMessage("Generate architecture doc"),
				createAIMessageWithToolCall(
					"write_document_local",
					{ document: "# Architecture v1" },
					"write_3",
				),
				createToolMessage("Document written.", "call_1"),
				confirmToolCall1,
				createToolMessage(
					'{"accepted":true}',
					getToolCallId(confirmToolCall1),
				),
				new AIMessage("I've created an architecture document."),
				// Second edit request
				new HumanMessage("Add security section"),
				createAIMessageWithToolCall(
					"write_document_local",
					{ document: "# Architecture v2\n## Security" },
					"write_4",
				),
				createToolMessage("Document written.", "call_2"),
				confirmToolCall2,
				createToolMessage(
					'{"accepted":true}',
					getToolCallId(confirmToolCall2),
				),
				new AIMessage("Added security section."),
				// Third follow-up (should NOT regenerate!)
				new HumanMessage("What about performance considerations?"),
			];

			// Last is human message - should make targeted edit
			expect(messages[messages.length - 1]).toBeInstanceOf(HumanMessage);
		});
	});

	describe("RAG context integration", () => {
		it("should include RAG contexts in state", () => {
			const state = createMockState({
				ragContexts: [
					"API design pattern from api-docs.md...",
					"Database schema from db-schema.md...",
				],
			});

			expect(state.ragContexts.length).toBe(2);
		});

		it("should work without RAG contexts", () => {
			const state = createMockState({
				ragContexts: [],
			});

			expect(state.ragContexts.length).toBe(0);
		});
	});

	describe("Frontend actions handling", () => {
		it("should handle regenerate_document action from CopilotKit", () => {
			const state = createMockState({
				copilotkit: {
					actions: [
						{
							name: "regenerate_document",
							description: "Regenerate the entire document",
							parameters: [],
						},
					],
					context: [],
				},
				messages: [new HumanMessage("Regenerate the document")],
			});

			// Frontend action should be available
			expect(state.copilotkit?.actions?.length).toBe(1);
			expect(state.copilotkit?.actions?.[0].name).toBe(
				"regenerate_document",
			);
		});

		it("should work without CopilotKit actions (Temporal backend)", () => {
			const state = createMockState({
				copilotkit: { actions: [], context: [] },
				messages: [new HumanMessage("Generate architecture doc")],
			});

			// No frontend actions in Temporal context
			expect(state.copilotkit?.actions?.length).toBe(0);
		});

		it("should handle confirm_changes action", () => {
			const state = createMockState({
				copilotkit: {
					actions: [
						{
							name: "confirm_changes",
							description: "Confirm document changes",
							parameters: [],
						},
					],
					context: [],
				},
			});

			expect(
				state.copilotkit?.actions?.some(
					(a) => a.name === "confirm_changes",
				),
			).toBe(true);
		});
	});

	describe("Document regeneration prevention", () => {
		it("should preserve existing document in state for follow-ups", () => {
			const existingDoc = `# Architecture Document

## Overview
This is the system architecture.

## Components
- Service A
- Service B`;

			const state = createMockState({
				document: existingDoc,
				messages: [
					new HumanMessage("Generate architecture doc"),
					createAIMessageWithToolCall("write_document_local", {
						document: existingDoc,
					}),
					createToolMessage("Document written.", "call_1"),
					createAIMessageWithToolCall("confirm_changes", {}),
					createToolMessage('{"accepted":true}', "call_2"),
					new AIMessage("Architecture document created."),
					new HumanMessage("Add a deployment section"), // Follow-up
				],
			});

			// Document should be preserved
			expect(state.document).toBe(existingDoc);
			// Last message is follow-up question
			expect(state.messages[state.messages.length - 1]).toBeInstanceOf(
				HumanMessage,
			);
		});

		it("should include document content in system prompt context", () => {
			const state = createMockState({
				document: "Existing document content",
				documentType: "architecture",
			});

			// The buildSystemPrompt should receive the document
			expect(state.document).toBe("Existing document content");
		});
	});

	describe("Project context handling", () => {
		it("should include project context in state", () => {
			const state = createMockState({
				projectContext: {
					name: "My Project",
					description: "Project description",
					techStack: ["TypeScript", "React"],
					features: ["Authentication", "Dashboard"],
					projectTypes: ["web-app"],
				},
			});

			expect(state.projectContext.name).toBe("My Project");
			expect(state.projectContext.description).toBe(
				"Project description",
			);
		});

		it("should handle minimal project context", () => {
			const state = createMockState({
				projectContext: {
					name: "Minimal Project",
					techStack: [],
					features: [],
				},
			});

			expect(state.projectContext.name).toBe("Minimal Project");
			expect(state.projectContext.description).toBeUndefined();
		});
	});
});

describe("Project Document Generator Chat Node - Error Handling", () => {
	it("should track retry count for JSON parse errors", () => {
		const state = createMockState({
			retryCount: 3,
			error: "JSON parse error",
		});

		expect(state.retryCount).toBe(3);
	});

	it("should reset state after successful generation", () => {
		const state = createMockState({
			document: "Generated document",
			retryCount: 0,
			error: undefined,
		});

		expect(state.retryCount).toBe(0);
		expect(state.error).toBeUndefined();
	});
});

describe("Project Document Generator Chat Node - Document Types", () => {
	const documentTypes = [
		"general",
		"prd",
		"proposal",
		"architecture",
		"technical_spec",
		"user_story",
		"api_spec",
	] as const;

	documentTypes.forEach((docType) => {
		it(`should handle ${docType} document type`, () => {
			const state = createMockState({
				documentType: docType,
				messages: [new HumanMessage(`Generate ${docType} document`)],
			});

			expect(state.documentType).toBe(docType);
		});
	});
});

describe("Project Document Generator Chat Node - Streaming Support", () => {
	it("should support streamingContent for predictive updates", () => {
		const state = createMockState({
			streamingContent: "# Document\n\nContent being streamed...",
			document: "", // Not yet committed
		});

		expect(state.streamingContent).toBe(
			"# Document\n\nContent being streamed...",
		);
	});

	it("should have focusAnchor for cursor positioning", () => {
		const state = createMockState({
			focusAnchor: "## New Section",
			document: "# Document\n\n## New Section\n\nContent...",
		});

		expect(state.focusAnchor).toBe("## New Section");
	});
});

// stripToolDefinitions focuses on the baseline-aware strikethrough logic.
// Background: the model sometimes uses `~~text~~` to indicate deletions during
// an edit. MarkdownIt renders that as real `<s>` strikethrough, TipTap treats
// it as user formatting (not a DiffDelete mark), and stripDiffTags leaves it
// alone — so "Accept Changes" silently preserves it and the saved document
// accumulates stale strikethrough. But users CAN author real strikethrough,
// so we can't blindly strip all `~~...~~`. The function takes the pre-edit
// baseline and only removes strikethrough runs that weren't already there.
describe("stripToolDefinitions - strikethrough handling", () => {
	it("strips model deletion markers on first generation (no baseline)", () => {
		const document =
			"Teams ~~today~~ face challenges ~~in~~that slow delivery.";
		const result = stripToolDefinitions(document);
		expect(result).toBe("Teams face challenges that slow delivery.");
		expect(result).not.toContain("~~");
	});

	it("preserves user-authored strikethrough on an unrelated edit", () => {
		const baseline =
			"Use ~~deprecated_api~~ for legacy code. See docs for details.";
		// AI edit unrelated to the strikethrough — the real user strike
		// MUST survive the round-trip.
		const aiOutput =
			"Use ~~deprecated_api~~ for legacy code. See the updated docs for details.";
		const result = stripToolDefinitions(aiOutput, baseline);
		expect(result).toContain("~~deprecated_api~~");
		expect(result).toContain("updated docs");
	});

	// The trailing trim also eats dashes, which is fine for a stray "—" the
	// model left behind but destructive when the patch legitimately ends on a
	// table separator row: `| --- | --- |` loses its tail and the table stops
	// parsing, rendering as literal pipe text.
	it("keeps a trailing table separator row intact", () => {
		const document = "| Role | Owner |\n| --- | --- |";
		expect(stripToolDefinitions(document)).toBe(document);
	});

	it("keeps a trailing table row intact", () => {
		const document = "| Role | Owner |\n| --- | --- |\n| PM | Alice |";
		expect(stripToolDefinitions(document)).toBe(document);
	});

	it("keeps a separator row that omits the closing pipe", () => {
		// GFM allows dropping the outer pipes. Here the trailing trim used to
		// eat the last `---`, leaving the separator one column short of the
		// header so the table stopped parsing entirely.
		const document = "| Role | Owner\n| --- | ---";
		expect(stripToolDefinitions(document)).toBe(document);
	});

	it("still trims a stray trailing dash after prose", () => {
		expect(stripToolDefinitions("Some prose. —  ")).toBe("Some prose.");
	});

	it("keeps user strikethrough but strips NEW model deletion markers", () => {
		const baseline =
			"The ~~deprecated_api~~ should be used for X. Teams handle Y and Z.";
		const aiOutput =
			"The ~~deprecated_api~~ should be used for X. Teams handle ~~Y and~~ just Z.";
		const result = stripToolDefinitions(aiOutput, baseline);
		expect(result).toContain("~~deprecated_api~~");
		expect(result).not.toContain("~~Y and~~");
		expect(result).toContain("Teams handle just Z");
	});

	it("strips long deletion markers (regression for the 50-char length cap)", () => {
		// This 55-character strikethrough is the exact kind of phrase that
		// slipped through the previous `~~[^~]{1,50}~~` regex and ended up
		// in saved documents as unaccepted deletions.
		const document =
			"Decisions are ~~made in meetings but never documented; requirements are~~ scattered everywhere.";
		const result = stripToolDefinitions(document);
		expect(result).toBe("Decisions are scattered everywhere.");
		expect(result).not.toContain("~~");
	});

	it("handles multiple strikethroughs in a single line", () => {
		const document = "Start ~~a~~ middle ~~b c~~ end ~~d e f~~.";
		const result = stripToolDefinitions(document);
		expect(result).not.toContain("~~");
		expect(result).toMatch(/Start\s+middle\s+end\s*\./);
	});

	it("leaves plain text untouched", () => {
		const document = "No strikethrough here at all.";
		expect(stripToolDefinitions(document)).toBe(document);
		expect(stripToolDefinitions(document, "baseline content")).toBe(
			document,
		);
	});

	it("distinguishes identical strikethrough runs in different positions", () => {
		// The baseline has one `~~TODO~~` note. The AI response has TWO.
		// The second occurrence is new, but our set-based check treats any
		// occurrence of a baseline run as "safe". Document the behavior.
		const baseline = "Section A: ~~TODO~~ needs work.";
		const aiOutput =
			"Section A: ~~TODO~~ needs work.\nSection B: ~~TODO~~ also needs work.";
		const result = stripToolDefinitions(aiOutput, baseline);
		// Both occurrences are preserved because the set membership check
		// is intentionally permissive — false negatives (stripping real
		// user content) are much worse than false positives (keeping a
		// model-added duplicate of an existing marker).
		expect(result).toContain("Section A: ~~TODO~~");
		expect(result).toContain("Section B: ~~TODO~~");
	});

	it("still strips other non-strikethrough removal patterns", () => {
		const document =
			"Keep this [removed] middle (deleted) end.\nAnother line.";
		const result = stripToolDefinitions(document);
		expect(result).not.toContain("[removed]");
		expect(result).not.toContain("(deleted)");
		expect(result).toContain("Keep this");
		expect(result).toContain("Another line");
	});

	// =========================================================================
	// fabric_source_document wrapper-tag echo (regression for the leak in which
	// the model occasionally emits the wrapper tag — or its `_`-suffixed
	// neutralization variant — inside the document body. Once written, every
	// subsequent edit re-poisons the output.)
	// =========================================================================

	it("strips a leaked <fabric_source_document> wrapper tag from output", () => {
		const aiOutput =
			"<fabric_source_document>This is the feature description.\nMore text here.";
		const result = stripToolDefinitions(aiOutput);
		expect(result).not.toContain("<fabric_source_document>");
		expect(result).toContain("This is the feature description.");
		expect(result).toContain("More text here.");
	});

	it("strips the sanitized <fabric_source_document_> variant too", () => {
		const aiOutput =
			"<fabric_source_document> <fabric_source_document_> Test feature body.";
		const result = stripToolDefinitions(aiOutput);
		expect(result).not.toMatch(/<fabric_source_document_*>/);
		expect(result).toContain("Test feature body.");
	});

	it("strips closing wrapper tags as well as opening ones", () => {
		const aiOutput =
			"Body content here.</fabric_source_document>\n</fabric_source_document_>";
		const result = stripToolDefinitions(aiOutput);
		expect(result).not.toMatch(/<\/?fabric_source_document_*>/);
		expect(result).toContain("Body content here.");
	});

	it("leaves unrelated `<fabric_*>` mentions alone", () => {
		// Only the exact wrapper-tag spellings are stripped — narrative
		// mentions of e.g. `<fabric_diagram>` or `<fabric_source>` (without
		// the `_document` suffix) remain untouched, so we don't accidentally
		// gut domain content.
		const document =
			"See `<fabric_diagram>` and `<fabric_source>` for related concepts.";
		const result = stripToolDefinitions(document);
		expect(result).toContain("<fabric_diagram>");
		expect(result).toContain("<fabric_source>");
	});
});

// =============================================================================
// Patch Mode
// =============================================================================
//
// The chat node switches to `apply_document_patches` for edits on existing
// documents of at least PATCH_MODE_MIN_DOC_CHARS, avoiding the full-rewrite
// output-token bleed. These tests cover:
// - Tool binding decisions (threshold, regeneration, new docs, small docs).
// - Successful patch flow (confirm_changes emitted, document updated).
// - Failed patch retry (corrective ToolMessage with valid anchors).
// - MAX_RETRIES exhaustion (user-facing error, document unchanged).
// - sanitizeContent hook runs per patch.

/** Build a large doc (>= 4K chars) so patch mode kicks in. */
function createLargeDocument(): string {
	const header = "# Product Requirements Document\n\n";
	const overview = "## Overview\n\nThe product helps teams ship faster.\n\n";
	const scope = "## Scope\n\n### In Scope\n\n- Feature A\n- Feature B\n\n";
	const stakeholders =
		"## Stakeholders\n\n- Alice (PM)\n- Bob (Engineering)\n\n";
	// Pad with filler to cross the 4000-char threshold.
	const filler = "\n".concat(
		"This is filler paragraph content. ".repeat(150),
		"\n",
	);
	return header + overview + scope + stakeholders + filler;
}

describe("Project Document Generator Chat Node - Patch Mode", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
	});

	it("successful patches: applies changes and emits confirm_changes", async () => {
		const existingDoc = createLargeDocument();
		// Model response: one patch that appends a new stakeholder.
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "Added Charlie to the stakeholders list.",
				tool_calls: [
					{
						id: "call_patches_1",
						name: "apply_document_patches",
						args: {
							patches: [
								{
									op: "append_to_section",
									anchor: "## Stakeholders",
									content: "- Charlie (Design)",
								},
							],
						},
					},
				],
			}),
		);

		const state = createMockState({
			document: existingDoc,
			messages: [
				new HumanMessage("Add Charlie from Design to stakeholders."),
			],
		});

		const command = await chatNode(state);
		const update = (command as any).update as {
			document?: string;
			streamingContent?: string;
			messages?: any[];
		};

		expect(update.document).toBeDefined();
		expect(update.document).toContain("Alice (PM)");
		expect(update.document).toContain("Bob (Engineering)");
		expect(update.document).toContain("Charlie (Design)");

		// streamingContent mirrors the final document so the UI effect can diff.
		expect(update.streamingContent).toBe(update.document);

		// A confirm_changes tool call must be emitted so the frontend modal shows.
		// buildConfirmChangesCommand emits an AIMessage with LangChain-shape
		// tool_calls (`{ id, name, args, type: "tool_call" }`), not the legacy
		// OpenAI `function.name` shape — match either to stay robust if the
		// shape evolves again.
		const lastMsg = update.messages?.[update.messages.length - 1];
		const confirmCall = (lastMsg as any)?.tool_calls?.[0];
		expect(confirmCall?.function?.name ?? confirmCall?.name).toBe(
			"confirm_changes",
		);
	});

	it("falls back to write_document_local for small documents", async () => {
		// A doc well under the 4K threshold — the chat node should bind
		// write_document_local and the model response uses that tool.
		const smallDoc = "## Overview\n\nTiny document.\n";
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "Updated.",
				tool_calls: [
					{
						id: "call_write_1",
						name: "write_document_local",
						args: {
							document: "## Overview\n\nUpdated tiny document.\n",
						},
					},
				],
			}),
		);

		const state = createMockState({
			document: smallDoc,
			messages: [new HumanMessage("update it")],
		});
		const command = await chatNode(state);
		const update = (command as any).update;

		expect(update?.document).toContain("Updated tiny document");
	});

	it("falls back to write_document_local when isRegeneration=true", async () => {
		// Large doc but regeneration flag is on — patch mode should NOT trigger.
		const existingDoc = createLargeDocument();
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "Regenerated.",
				tool_calls: [
					{
						id: "call_write_2",
						name: "write_document_local",
						args: {
							document:
								"# Regenerated Document\n\n## Overview\n\nFresh start.",
						},
					},
				],
			}),
		);

		const state = createMockState({
			document: existingDoc,
			isRegeneration: true,
			messages: [new HumanMessage("regenerate")],
		});
		const command = await chatNode(state);
		const update = (command as any).update;

		expect(update?.document).toContain("Regenerated Document");
	});

	it("retries with corrective ToolMessage when a patch anchor is unknown", async () => {
		const existingDoc = createLargeDocument();
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "Adding to a section",
				tool_calls: [
					{
						id: "call_patches_bad",
						name: "apply_document_patches",
						args: {
							patches: [
								{
									op: "append_to_section",
									anchor: "## NotARealSection",
									content: "- Whatever",
								},
							],
						},
					},
				],
			}),
		);

		const state = createMockState({
			document: existingDoc,
			messages: [new HumanMessage("add a bullet somewhere")],
		});

		const command = await chatNode(state);
		const goto = (command as any).goto;
		const update = (command as any).update;

		// Should route BACK to chat_node with a corrective ToolMessage and
		// incremented retryCount — not to END.
		// LangGraph Command wraps goto in an array internally.
		expect(Array.isArray(goto) ? goto[0] : goto).toBe("chat_node");
		expect(update.retryCount).toBe(1);

		const lastMessage = update.messages?.[update.messages.length - 1];
		const content =
			typeof lastMessage?.content === "string" ? lastMessage.content : "";
		expect(content).toContain("apply_document_patches");
		expect(content).toContain("anchor");
		// The correction should list valid anchors from the actual doc.
		expect(content).toContain("## Overview");
	});

	it("after MAX_RETRIES patch failures, surfaces a user-facing error", async () => {
		const existingDoc = createLargeDocument();
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "call_patches_bad_2",
						name: "apply_document_patches",
						args: {
							patches: [
								{
									op: "append_to_section",
									anchor: "## AlsoNotARealSection",
									content: "- X",
								},
							],
						},
					},
				],
			}),
		);

		const state = createMockState({
			document: existingDoc,
			retryCount: 3, // already at MAX_RETRIES
			messages: [new HumanMessage("nope")],
		});

		const command = await chatNode(state);
		const goto = (command as any).goto;
		const update = (command as any).update;

		expect(Array.isArray(goto) ? goto[0] : goto).toBe("__end__");
		expect(update.error).toContain("Failed to apply document patches");
		// Document should NOT be updated — baseline is preserved.
		expect(update.document).toBeUndefined();
	});

	it("sanitizeContent hook strips tool definitions from patch content", async () => {
		const existingDoc = createLargeDocument();
		// Patch content includes a leaked tool definition pattern that
		// stripToolDefinitions should remove (the "[removed]" marker).
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "Added a new bullet",
				tool_calls: [
					{
						id: "call_patches_strip",
						name: "apply_document_patches",
						args: {
							patches: [
								{
									op: "append_to_section",
									anchor: "## Stakeholders",
									content: "- Charlie (Design) [removed]",
								},
							],
						},
					},
				],
			}),
		);

		const state = createMockState({
			document: existingDoc,
			messages: [new HumanMessage("add charlie")],
		});

		const command = await chatNode(state);
		const update = (command as any).update;
		expect(update.document).toContain("Charlie (Design)");
		// The "[removed]" marker should have been stripped by sanitizeContent.
		expect(update.document).not.toContain("[removed]");
	});

	it("empty patches array retries with corrective message", async () => {
		const existingDoc = createLargeDocument();
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "call_patches_empty",
						name: "apply_document_patches",
						args: { patches: [] },
					},
				],
			}),
		);

		const state = createMockState({
			document: existingDoc,
			messages: [new HumanMessage("do something")],
		});

		const command = await chatNode(state);
		const goto = (command as any).goto;
		const update = (command as any).update;

		// LangGraph Command wraps goto in an array internally.
		expect(Array.isArray(goto) ? goto[0] : goto).toBe("chat_node");
		expect(update.retryCount).toBe(1);
	});

	it("falls back to write_document_local for large docs with no headings", async () => {
		// A plain-text / custom-prompt document large enough to cross the 4K
		// threshold but with zero headings. Patch mode would have no anchors
		// to target, so the chat node must bind write_document_local instead.
		const headinglessDoc = "This is a plain text document. ".repeat(200);
		expect(headinglessDoc.length).toBeGreaterThan(4000);

		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "Rewritten.",
				tool_calls: [
					{
						id: "call_write_headingless",
						name: "write_document_local",
						args: {
							document: "Rewritten plain text.",
						},
					},
				],
			}),
		);

		const state = createMockState({
			document: headinglessDoc,
			messages: [new HumanMessage("tidy this up")],
		});
		const command = await chatNode(state);
		const update = (command as any).update;

		expect(update?.document).toContain("Rewritten plain text");
	});
});

describe("Project Document Generator Chat Node - Truncated Output Handling", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
	});

	it("does not retry write_document_local empty args when the response was truncated at the output-token limit", async () => {
		const smallDoc = "## Overview\n\nTiny document.\n";
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "call_truncated_1",
						name: "write_document_local",
						args: {},
					},
				],
				response_metadata: { stop_reason: "max_tokens" },
			}),
		);

		const state = createMockState({
			document: smallDoc,
			retryCount: 0,
			messages: [new HumanMessage("update it")],
		});

		const command = await chatNode(state);
		const goto = (command as any).goto;
		const update = (command as any).update;

		// Truncation is deterministic — even at retryCount 0 (budget available)
		// the node must go straight to END instead of "chat_node".
		expect(Array.isArray(goto) ? goto[0] : goto).toBe("__end__");
		expect(update.retryCount).toBe(0);
		expect(update.error).toContain("output limit");
	});

	it("still retries write_document_local empty args when there is no truncation signal (existing behavior)", async () => {
		const smallDoc = "## Overview\n\nTiny document.\n";
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "call_empty_1",
						name: "write_document_local",
						args: {},
					},
				],
			}),
		);

		const state = createMockState({
			document: smallDoc,
			retryCount: 0,
			messages: [new HumanMessage("update it")],
		});

		const command = await chatNode(state);
		const goto = (command as any).goto;
		const update = (command as any).update;

		expect(Array.isArray(goto) ? goto[0] : goto).toBe("chat_node");
		expect(update.retryCount).toBe(1);
	});
});

// =============================================================================
// maxTokensForConfig wiring (issue #2781 HIGH review finding)
// =============================================================================
//
// extractProviderConfig runs BEFORE getAgentModelAsync, but getAgentModelAsync
// can still substitute a different resolved model (task-specific-preference
// override, or an API-fallback config the node never saw) before building the
// client. A reasoning allowance computed from the pre-resolution model would
// silently apply to the wrong model. chat-node.ts instead hands
// getAgentModelAsync a `maxTokensForConfig` callback that
// `createProviderModel` evaluates against the FINAL resolved config. These
// tests stay at the mock boundary: they assert chat-node.ts constructs and
// passes that callback correctly, not that getAgentModelAsync's real
// resolution paths work (those are exercised elsewhere / by agent-core's own
// tests for `createProviderModel`).
describe("Project Document Generator Chat Node - maxTokensForConfig wiring", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
		vi.mocked(getAgentModelAsync).mockClear();
	});

	it("passes a maxTokensForConfig function to getAgentModelAsync that resolves the reasoning allowance from the config it is called with, not from the config extracted up front", async () => {
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({ content: "ack", tool_calls: [] }),
		);

		const state = createMockState({
			document: "## Overview\n\nSome content.\n",
			retryCount: 0,
			messages: [new HumanMessage("update it")],
		});

		await chatNode(state);

		expect(getAgentModelAsync).toHaveBeenCalled();
		const lastCall = vi.mocked(getAgentModelAsync).mock.calls.at(-1);
		const options = lastCall?.[1] as
			| { maxTokensForConfig?: (cfg: unknown) => number }
			| undefined;
		expect(typeof options?.maxTokensForConfig).toBe("function");

		const withAllowance = options?.maxTokensForConfig?.({
			model: "system.ai.claude-sonnet-5",
		});
		const withoutAllowance = options?.maxTokensForConfig?.({
			model: "gpt-4o",
		});

		// extractProviderConfig is mocked to always return { model: "gpt-4o" }
		// (a non-reasoning name) — if the callback used that pre-resolution
		// config instead of the config it's invoked with, both calls above
		// would return the same value regardless of the argument passed in.
		expect(withAllowance).toBeGreaterThan(withoutAllowance as number);
	});
});

// =============================================================================
// sanitizeMessagesForModel — image_url passthrough
// =============================================================================
//
// We always preserve array-shaped multimodal content (text + image_url parts)
// end-to-end. The tenant's configured model is the source of truth — if it
// does not accept image content, the LLM API surfaces a clear error which
// propagates back to the frontend as a toast. We never second-guess the
// model with a hardcoded whitelist.

/** Build a typed multimodal HumanMessage content array (text + image_url). */
function buildMultimodalContent(): MessageContentComplex[] {
	return [
		{ type: "text", text: "look at this" },
		{
			type: "image_url",
			image_url: {
				url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg",
			},
		},
	];
}

describe("sanitizeMessagesForModel - image_url passthrough", () => {
	it("preserves array-shaped HumanMessage content regardless of provider", () => {
		const content = buildMultimodalContent();
		const input: BaseMessage[] = [new HumanMessage({ content })];

		const result = sanitizeMessagesForModel(input, new Set());

		expect(result).toHaveLength(1);
		const out = result[0].content;
		expect(Array.isArray(out)).toBe(true);
		expect(out).toEqual(content);
	});

	it("preserves array content when merging consecutive human turns", () => {
		const content = buildMultimodalContent();
		const input: BaseMessage[] = [
			new HumanMessage({ content: "first turn" }),
			new HumanMessage({ content }),
		];

		const result = sanitizeMessagesForModel(input, new Set());

		// Two consecutive human messages collapse into one. The merged
		// content keeps the multimodal array shape so the model still sees
		// the image part.
		expect(result).toHaveLength(1);
		const out = result[0].content;
		expect(Array.isArray(out)).toBe(true);
	});

	it("leaves string-content HumanMessages unchanged", () => {
		const input: BaseMessage[] = [
			new HumanMessage({ content: "plain text" }),
		];

		const result = sanitizeMessagesForModel(input, new Set());

		expect(result).toHaveLength(1);
		expect(result[0].content).toBe("plain text");
	});
});

// =============================================================================
// sanitizeMessagesForModel — orphaned tool_result recovery
// =============================================================================
//
// When the user answers the clarifying-question card, the answer round-trips as
// a tool_result. The LangGraph reducer / CopilotKit wire-format can strip the
// synthetic `ask_clarifying_question` tool_use between runs, leaving the result
// orphaned — which Anthropic rejects ("tool_result ... must have a corresponding
// tool_use block"). The sanitizer must convert such orphans into a plain user
// message so the answer survives and the model can continue with it.
describe("sanitizeMessagesForModel - orphaned tool_result recovery", () => {
	it("converts an orphaned clarifying-question answer into a user message", () => {
		const input: BaseMessage[] = [
			new HumanMessage({ content: "Add login to this feature" }),
			createToolMessage(
				JSON.stringify({
					answered: true,
					answer: "OAuth 2.0 / OpenID Connect",
					viaCustom: false,
				}),
				"stripped-tool-use-id",
			),
		];

		const result = sanitizeMessagesForModel(input, new Set());

		// No tool message may survive without its tool_use — that would 400.
		expect(result.every((m) => !(m instanceof ToolMessage))).toBe(true);
		// The answer is preserved as user-visible text the model can act on.
		const joined = result
			.map((m) => (typeof m.content === "string" ? m.content : ""))
			.join("\n");
		expect(joined).toContain("OAuth 2.0 / OpenID Connect");
	});

	it("converts a dismissed clarifying-question result into an open-question note", () => {
		const input: BaseMessage[] = [
			new HumanMessage({ content: "Add login" }),
			createToolMessage(
				JSON.stringify({ answered: false, dismissed: true }),
				"stripped-id",
			),
		];

		const result = sanitizeMessagesForModel(input, new Set());

		expect(result.every((m) => !(m instanceof ToolMessage))).toBe(true);
		const joined = result
			.map((m) => (typeof m.content === "string" ? m.content : ""))
			.join("\n")
			.toLowerCase();
		expect(joined).toContain("open question");
	});

	it("preserves a properly paired tool_use + tool_result", () => {
		const ai = createAIMessageWithToolCall(
			"write_document_local",
			{ title: "Doc" },
			"call-1",
		);
		const input: BaseMessage[] = [
			new HumanMessage({ content: "Make a doc" }),
			ai,
			createToolMessage("done", "call-1"),
		];

		const result = sanitizeMessagesForModel(
			input,
			new Set(["write_document_local"]),
		);

		// The tool result stays a tool message because its tool_use is present.
		expect(result.some((m) => m instanceof ToolMessage)).toBe(true);
	});

	it("merges a converted orphaned answer into the preceding human turn (no consecutive user messages)", () => {
		const input: BaseMessage[] = [
			new HumanMessage({ content: "original request" }),
			createToolMessage(
				JSON.stringify({ answered: true, answer: "PostgreSQL" }),
				"x",
			),
		];

		const result = sanitizeMessagesForModel(input, new Set());

		// Anthropic requires alternating roles — the converted answer must fold
		// into the prior human turn, never create two consecutive user messages.
		for (let i = 1; i < result.length; i++) {
			const consecutiveHumans =
				result[i - 1] instanceof HumanMessage &&
				result[i] instanceof HumanMessage;
			expect(consecutiveHumans).toBe(false);
		}
		expect(result).toHaveLength(1);
		expect(result[0].content).toContain("PostgreSQL");
	});
});

describe("chat-node — reasoning trace integration", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
	});

	it("preserves multi-block response.content array in state.messages AND writes reasoningByTurn", async () => {
		// Mock the model to return Anthropic-shape multi-block content
		// (thinking + text), as it would when `thinking` is enabled.
		mockInvoke.mockResolvedValueOnce({
			content: [
				{
					type: "thinking",
					thinking: "Analyzing the document structure...",
				},
				{
					type: "text",
					text: "Here is my analysis: the auth module needs...",
				},
			],
			tool_calls: [],
		});

		const state = createMockState({
			messages: [new HumanMessage("Analyze the auth module")],
		});

		const result = await chatNode(state);

		// ASSERT 1 — reasoningByTurn populated under turnIndex=1
		expect(result).toHaveProperty("update");
		const update = (result as { update: Record<string, unknown> }).update;
		expect(update.reasoningByTurn).toEqual({
			1: expect.objectContaining({
				text: "Analyzing the document structure...",
				startedAt: expect.any(Number),
				completedAt: expect.any(Number),
				durationMs: expect.any(Number),
			}),
		});

		// ASSERT 2 — the assistant message pushed onto state.messages
		// retains the original multi-block array (NOT collapsed to string).
		// This is critical: Anthropic's Messages API requires the thinking
		// block (with its cryptographic `signature`) to be present in the
		// prior assistant turn on any follow-up request that continues a
		// tool-use conversation. Mutating to a string here would strip the
		// signature and cause HTTP 400 on the next chat-node invocation.
		const messages = update.messages as Array<{ content: unknown }>;
		const lastMessage = messages[messages.length - 1];
		expect(Array.isArray(lastMessage.content)).toBe(true);
		const blocks = lastMessage.content as Array<{
			type: string;
			thinking?: string;
			text?: string;
		}>;
		expect(blocks.find((b) => b.type === "thinking")?.thinking).toBe(
			"Analyzing the document structure...",
		);
		expect(blocks.find((b) => b.type === "text")?.text).toBe(
			"Here is my analysis: the auth module needs...",
		);
	});

	it("no reasoningByTurn written when response.content is plain string (no thinking)", async () => {
		mockInvoke.mockResolvedValueOnce({
			content: "Just a plain reply.",
			tool_calls: [],
		});

		const state = createMockState({
			messages: [new HumanMessage("Hello")],
		});

		const result = await chatNode(state);
		const update = (result as { update: Record<string, unknown> }).update;

		// No reasoningByTurn delta — the state's existing reasoningByTurn
		// (empty {}) is unchanged.
		expect(update.reasoningByTurn).toBeUndefined();

		// Content remains string (it was already)
		const messages = update.messages as Array<{ content: unknown }>;
		expect(typeof messages[messages.length - 1].content).toBe("string");
	});

	it("extracts reasoning from OpenAI o-series content blocks", async () => {
		mockInvoke.mockResolvedValueOnce({
			content: [
				{ type: "reasoning", reasoning: "OpenAI o-series thinking..." },
				{ type: "text", text: "OpenAI answer." },
			],
			tool_calls: [],
		});

		const state = createMockState({
			messages: [new HumanMessage("Test OpenAI shape")],
		});

		const result = await chatNode(state);
		const update = (result as { update: Record<string, unknown> }).update;

		expect(update.reasoningByTurn).toEqual({
			1: expect.objectContaining({
				text: "OpenAI o-series thinking...",
			}),
		});
	});

	it("preserves multi-block content (thinking + signature) in state.messages for multi-turn tool replay", async () => {
		// Mock model returning Anthropic thinking + text + tool_call shape.
		// The thinking block's `signature` is what Anthropic requires preserved
		// across turns; if our normalization strips it, subsequent chat-node
		// invocations will fail with HTTP 400.
		mockInvoke.mockResolvedValueOnce({
			content: [
				{
					type: "thinking",
					thinking: "Let me search Teams for that.",
					signature: "sig_abc123",
				},
				{
					type: "text",
					text: "I'll search Teams for relevant messages.",
				},
			],
			tool_calls: [
				{
					id: "call_1",
					name: "search_teams_messages",
					args: { query: "auth migration" },
				},
			],
		});

		const state = createMockState({
			messages: [
				new HumanMessage("Search Teams for auth migration discussion"),
			],
			hasTeamsIntegration: true,
		});

		const result = await chatNode(state);
		const update = (result as { update: Record<string, unknown> }).update;
		const messages = update.messages as Array<{ content: unknown }>;
		const lastMessage = messages[messages.length - 1];

		// The AIMessage pushed onto state.messages MUST retain the multi-block array
		// including the thinking block with its signature, so the next chat-node
		// invocation can replay it to Anthropic without HTTP 400.
		expect(Array.isArray(lastMessage.content)).toBe(true);
		const blocks = lastMessage.content as Array<{
			type: string;
			signature?: string;
		}>;
		const thinkingBlock = blocks.find((b) => b.type === "thinking");
		expect(thinkingBlock).toBeDefined();
		expect(thinkingBlock?.signature).toBe("sig_abc123");

		// And reasoning was still extracted into state for the UI
		expect(update.reasoningByTurn).toEqual({
			1: expect.objectContaining({
				text: "Let me search Teams for that.",
			}),
		});
	});

	it("sanitizer extracts text from multi-block AI history (no '[object Object]' corruption)", async () => {
		// Simulate a turn-2 conversation: prior assistant turn had thinking + text
		// (no tool_calls — happy-path no-tool reply), now the user sends a
		// follow-up. sanitizeMessagesForModel runs at chat-node entry and
		// processes the history. It MUST NOT stringify the multi-block content
		// array to "[object Object],[object Object]" — that would corrupt the
		// conversation sent to Anthropic on the second turn.
		mockInvoke.mockResolvedValueOnce({
			content: "Second turn reply.",
			tool_calls: [],
		});

		const priorAIMessage = new AIMessage({
			content: [
				{
					type: "thinking",
					thinking: "Internal turn-1 reasoning.",
					signature: "sig_t1",
				},
				{ type: "text", text: "Visible turn-1 answer." },
			] as unknown as MessageContentComplex[],
		});

		const state = createMockState({
			messages: [
				new HumanMessage("First user"),
				priorAIMessage,
				new HumanMessage("Second user"),
			],
		});

		await chatNode(state);

		// Inspect what was passed to mockInvoke. The sanitized history should
		// include the prior AI as an actual text message (extracted from the
		// multi-block array), NOT the literal stringification
		// "[object Object],..." that `String(array)` would produce.
		expect(mockInvoke).toHaveBeenCalledTimes(1);
		const [callMessages] = mockInvoke.mock.calls[0] as [
			Array<{ content: unknown }>,
		];
		const aiInHistory = callMessages.find(
			(m) =>
				typeof m.content === "string" &&
				m.content.includes("Visible turn-1 answer"),
		);
		expect(aiInHistory).toBeDefined();
		expect(
			callMessages.some(
				(m) =>
					typeof m.content === "string" &&
					m.content.includes("[object Object]"),
			),
		).toBe(false);
	});
});

/**
 * Integration tests for the per-turn tool-call trace capture path.
 *
 * Validates the full chat-node → `reconcileToolCalls` → `Command.update`
 * wiring (Codex review concern #10): the helper alone is well-covered by
 * `chat-node-tools.test.ts`, but the prior regression in PR #1023 (Anthropic
 * thinking-signature mutation) happened in the wiring, not the helper. These
 * tests close that gap.
 */
describe("Project Document Generator Chat Node - Tool-call trace capture", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
	});

	it("writes pending toolCallsByTurn[1] when first response carries tool_calls", async () => {
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "call_trace_1",
						name: "search_teams_messages",
						args: { query: "deployment" },
					},
				],
			}),
		);

		const state = createMockState({
			messages: [new HumanMessage("Find recent Teams messages")],
		});

		const command = await chatNode(state);
		const update = (command as any).update;

		expect(update.toolCallsByTurn).toBeDefined();
		const entries = update.toolCallsByTurn[1];
		expect(Array.isArray(entries)).toBe(true);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			id: "call_trace_1",
			name: "search_teams_messages",
			status: "pending",
		});
		expect(typeof entries[0].startedAt).toBe("number");
		// durationMs is undefined on pending entries (only set on resolution).
		expect(entries[0].durationMs).toBeUndefined();
	});

	it("transitions pending → success when next invocation sees matching ToolMessage", async () => {
		// Second chat-node invocation: state.messages now contains the
		// pending tool's ToolMessage (reduced from the tool node), and the
		// model returns a final AIMessage with no further tool calls. The
		// reconcile path must resolve the pending entry to success and
		// flip status accordingly inside update.toolCallsByTurn[1].
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "Found 5 relevant messages.",
				tool_calls: [],
			}),
		);

		const aiWithToolCall = new AIMessage({
			content: "",
			tool_calls: [
				{
					id: "call_trace_2",
					name: "search_teams_messages",
					args: { query: "deployment" },
				},
			],
		});
		const toolResultMsg = new ToolMessage({
			content: "5 messages matched",
			tool_call_id: "call_trace_2",
		});

		const state = createMockState({
			messages: [
				new HumanMessage("Find recent Teams messages"),
				aiWithToolCall,
				toolResultMsg,
			],
			// Previous turn already wrote the pending entry.
			toolCallsByTurn: {
				1: [
					{
						id: "call_trace_2",
						name: "search_teams_messages",
						status: "pending",
						startedAt: Date.now() - 400,
					},
				],
			},
		} as Partial<AgentState>);

		const command = await chatNode(state);
		const update = (command as any).update;

		expect(update.toolCallsByTurn).toBeDefined();
		const entries = update.toolCallsByTurn[1];
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			id: "call_trace_2",
			name: "search_teams_messages",
			status: "success",
		});
		expect(typeof entries[0].durationMs).toBe("number");
		expect(entries[0].durationMs).toBeGreaterThanOrEqual(0);
		expect(entries[0].errorMessage).toBeUndefined();
	});

	it("transitions pending → error when next invocation sees errored ToolMessage", async () => {
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "Tool failed, falling back.",
				tool_calls: [],
			}),
		);

		// LangChain ≥ 0.3 sets status: "error" on ToolMessage when the
		// tool throws. We construct the raw object shape since
		// `new ToolMessage(...)` may not accept the status field in all
		// versions (the runtime sets it via lc_kwargs).
		const erroredToolMsg = {
			_getType: () => "tool",
			tool_call_id: "call_trace_err",
			status: "error",
			content: "Error: API rate limit exceeded",
		} as unknown as BaseMessage;

		const aiWithToolCall = new AIMessage({
			content: "",
			tool_calls: [
				{
					id: "call_trace_err",
					name: "search_repository_code",
					args: { query: "auth" },
				},
			],
		});

		const state = createMockState({
			messages: [
				new HumanMessage("Search code for auth"),
				aiWithToolCall,
				erroredToolMsg,
			],
			toolCallsByTurn: {
				1: [
					{
						id: "call_trace_err",
						name: "search_repository_code",
						status: "pending",
						startedAt: Date.now() - 250,
					},
				],
			},
		} as Partial<AgentState>);

		const command = await chatNode(state);
		const update = (command as any).update;

		const entries = update.toolCallsByTurn[1];
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			id: "call_trace_err",
			name: "search_repository_code",
			status: "error",
		});
		expect(entries[0].errorMessage).toContain("API rate limit");
	});

	it("preserves multi-block response.content in state.messages while still capturing tool_calls (regression guard for #1023)", async () => {
		// Mirror the Anthropic thinking-enabled shape: content is an array
		// of [thinking-block, tool_use-block]. If chat-node ever mutates
		// response.content (as the bug in #1023 did), the next Anthropic
		// API call will reject the request with
		// "messages.X.content: thinking block missing" because the
		// cryptographic signature was stripped. Asserting array preservation
		// here is the structural defence.
		const multiBlockContent: MessageContentComplex[] = [
			{
				type: "thinking",
				thinking: "Let me search Teams first…",
				// @ts-expect-error -- runtime adds signature post-hoc
				signature: "anthropic_signature_abc123",
			},
			{
				type: "text",
				text: "Looking it up.",
			},
		];

		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: multiBlockContent,
				tool_calls: [
					{
						id: "call_trace_multi",
						name: "search_teams_messages",
						args: { query: "deploy" },
					},
				],
			}),
		);

		const state = createMockState({
			messages: [new HumanMessage("Find recent Teams chatter")],
		});

		const command = await chatNode(state);
		const update = (command as any).update;

		// 1. Tool-call trace must be captured.
		expect(update.toolCallsByTurn?.[1]).toHaveLength(1);
		expect(update.toolCallsByTurn[1][0].status).toBe("pending");

		// 2. state.messages MUST still carry the response with content as
		//    the original array (NOT collapsed to a string). The thinking
		//    block + signature MUST be present, since Anthropic requires
		//    them to be replayed on the next turn.
		const lastMsg = update.messages?.[update.messages.length - 1];
		expect(lastMsg).toBeDefined();
		const lastContent = (lastMsg as AIMessage).content;
		expect(Array.isArray(lastContent)).toBe(true);

		const blocks = lastContent as MessageContentComplex[];
		const thinkingBlock = blocks.find((b) => b.type === "thinking");
		expect(thinkingBlock).toBeDefined();
		expect((thinkingBlock as { thinking?: string }).thinking).toContain(
			"Let me search Teams first",
		);
		expect((thinkingBlock as { signature?: string }).signature).toBe(
			"anthropic_signature_abc123",
		);
	});

	it("flows toolCallsByTurnUpdate through buildConfirmChangesCommand on write_document_local (extraStateUpdate spread)", async () => {
		// The previous 4 tests cover the external-tool-call and no-tool-call
		// return paths (sites A and B in chat-node.ts). This test covers
		// site C: write_document_local routes through buildConfirmChangesCommand
		// which merges toolCallsByTurnUpdate via `extraStateUpdate`. A bug in
		// that spread would silently drop the pending entry for the most
		// frequent tool in this agent (every document edit).
		//
		// Resolution semantics: pending stays pending until the user accepts
		// the confirm_changes modal, at which point chat-node re-enters with
		// the synthetic ToolMessage (`tool_call_id` matching the original
		// write_document_local id, content "Document written.") in
		// state.messages — at THAT point reconcileToolCalls matches by id and
		// flips pending → success. That second-hop behavior is identical to
		// the external-tool path covered by test 2 above; here we only verify
		// the WRITE site emits the pending entry at all.
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "Updating the document.",
				tool_calls: [
					{
						id: "call_write_trace",
						name: "write_document_local",
						args: {
							document: "## Overview\n\nUpdated content.\n",
						},
					},
				],
			}),
		);

		const state = createMockState({
			document: "## Overview\n\nOriginal.\n",
			messages: [new HumanMessage("Update the document")],
		});

		const command = await chatNode(state);
		const update = (command as any).update;

		// Sanity: the write path was actually taken (document field updated +
		// confirm_changes synthetic tool call appended).
		expect(update.document).toContain("Updated content");
		const lastMsg = update.messages?.[update.messages.length - 1];
		const confirmCall = (lastMsg as any)?.tool_calls?.[0];
		expect(confirmCall?.function?.name ?? confirmCall?.name).toBe(
			"confirm_changes",
		);

		// The actual assertion: toolCallsByTurnUpdate flowed through
		// extraStateUpdate into the Command.update payload.
		expect(update.toolCallsByTurn).toBeDefined();
		const entries = update.toolCallsByTurn[1];
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			id: "call_write_trace",
			name: "write_document_local",
			status: "pending",
		});
		expect(typeof entries[0].startedAt).toBe("number");
	});

	it("guards against phantom pending entries when model violates parallel_tool_calls: false", async () => {
		// chat-node sends parallel_tool_calls: false to the model and
		// processes only response.tool_calls[0]. For inline tools (the
		// hot path), buildConfirmChangesCommand only synthesizes a
		// matching ToolMessage for [0] — additional calls would otherwise
		// become phantom pending rows that spin forever in the UI.
		// Regression guard: a response with 2 tool_calls must yield only
		// 1 trace entry (the first), regardless of how nonconformant the
		// model is.
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "call_kept",
						name: "write_document_local",
						args: {
							document: "## Overview\n\nFirst write.\n",
						},
					},
					{
						id: "call_dropped",
						name: "write_document_local",
						args: {
							document: "## Overview\n\nIgnored second write.\n",
						},
					},
				],
			}),
		);

		const state = createMockState({
			document: "## Overview\n\nOriginal.\n",
			messages: [new HumanMessage("Update the document")],
		});

		const command = await chatNode(state);
		const update = (command as any).update;

		expect(update.toolCallsByTurn).toBeDefined();
		const entries = update.toolCallsByTurn[1];
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe("call_kept");
		expect(entries[0].name).toBe("write_document_local");
		// The dropped second call must NOT appear in the trace.
		expect(
			entries.find((e: { id: string }) => e.id === "call_dropped"),
		).toBeUndefined();
	});
});

describe("Project Document Generator Chat Node - Post-confirmation reconciler", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
	});

	// Helper to build the "user just clicked Accept/Reject" message
	// shape that the post-confirmation branch in chatNode detects:
	// the LAST message must be a ToolMessage referencing the
	// SECOND-TO-LAST AIMessage's confirm_changes tool_call.
	function buildPostConfirmMessages(params: {
		accepted: boolean;
		inlineToolId: string;
		inlineToolName: "write_document_local" | "apply_document_patches";
		withMarker: boolean;
	}): BaseMessage[] {
		const confirmId = `confirm_${Date.now()}`;
		const confirmAi = new AIMessage({
			content: "Changes ready for review.",
			tool_calls: [
				{
					id: confirmId,
					name: "confirm_changes",
					args: params.withMarker
						? {
								__inlineTool: {
									id: params.inlineToolId,
									name: params.inlineToolName,
								},
							}
						: {},
					type: "tool_call" as const,
				},
			],
		});
		return [
			new HumanMessage("Generate architecture doc"),
			confirmAi,
			new ToolMessage({
				content: JSON.stringify({ accepted: params.accepted }),
				tool_call_id: confirmId,
			}),
		];
	}

	it("in-place × accepted: flips matching pending entry to success and preserves durationMs", async () => {
		const started = Date.now() - 5000;
		const state = createMockState({
			messages: buildPostConfirmMessages({
				accepted: true,
				inlineToolId: "call_inplace_ok",
				inlineToolName: "apply_document_patches",
				withMarker: true,
			}),
			toolCallsByTurn: {
				1: [
					{
						id: "call_inplace_ok",
						name: "apply_document_patches",
						status: "pending",
						startedAt: started,
					},
				],
			},
		} as Partial<AgentState>);

		const command = await chatNode(state);
		const update = (command as any).update;

		expect(update.toolCallsByTurn).toBeDefined();
		const entries = update.toolCallsByTurn[1];
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			id: "call_inplace_ok",
			name: "apply_document_patches",
			status: "success",
			startedAt: started,
		});
		expect(typeof entries[0].durationMs).toBe("number");
		expect(entries[0].durationMs).toBeGreaterThanOrEqual(0);
		expect(entries[0].errorMessage).toBeUndefined();
	});

	it("in-place × rejected: flips matching pending entry to error with rejection message", async () => {
		const started = Date.now() - 2000;
		const state = createMockState({
			messages: buildPostConfirmMessages({
				accepted: false,
				inlineToolId: "call_inplace_err",
				inlineToolName: "write_document_local",
				withMarker: true,
			}),
			toolCallsByTurn: {
				1: [
					{
						id: "call_inplace_err",
						name: "write_document_local",
						status: "pending",
						startedAt: started,
					},
				],
			},
		} as Partial<AgentState>);

		const command = await chatNode(state);
		const update = (command as any).update;

		const entries = update.toolCallsByTurn[1];
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			id: "call_inplace_err",
			name: "write_document_local",
			status: "error",
			startedAt: started,
			errorMessage: "User rejected the proposed changes",
		});
		expect(typeof entries[0].durationMs).toBe("number");
	});

	it("reconstruct × accepted: synthesizes success entry from args.__inlineTool when toolCallsByTurn is empty", async () => {
		const state = createMockState({
			messages: buildPostConfirmMessages({
				accepted: true,
				inlineToolId: "call_recon_ok",
				inlineToolName: "apply_document_patches",
				withMarker: true,
			}),
			// Simulate CopilotKit's wire-format normalization wiping
			// the field — Annotation default ({}) is the realistic
			// post-deploy condition for this branch.
			toolCallsByTurn: {},
		} as Partial<AgentState>);

		const command = await chatNode(state);
		const update = (command as any).update;

		expect(update.toolCallsByTurn).toBeDefined();
		const entries = update.toolCallsByTurn[1];
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			id: "call_recon_ok",
			name: "apply_document_patches",
			status: "success",
		});
		// Reconstruct path intentionally omits durationMs — original
		// startedAt is unknown, and a now-now=0 reading would render
		// misleading "0.0s" in the UI.
		expect(entries[0].durationMs).toBeUndefined();
		expect(entries[0].errorMessage).toBeUndefined();
	});

	it("reconstruct × rejected: synthesizes error entry with rejection message", async () => {
		const state = createMockState({
			messages: buildPostConfirmMessages({
				accepted: false,
				inlineToolId: "call_recon_err",
				inlineToolName: "write_document_local",
				withMarker: true,
			}),
			toolCallsByTurn: {},
		} as Partial<AgentState>);

		const command = await chatNode(state);
		const update = (command as any).update;

		const entries = update.toolCallsByTurn[1];
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			id: "call_recon_err",
			name: "write_document_local",
			status: "error",
			errorMessage: "User rejected the proposed changes",
		});
		expect(entries[0].durationMs).toBeUndefined();
	});

	it("reconstruct preserves other resolved entries in the same turn (no stomp)", async () => {
		// Regression guard for the "synthesized entry replaces whole
		// turn array" bug. Multi-tool turn where an earlier tool
		// (search_teams_messages) already resolved, plus a stale
		// pending row that should be dropped, plus the inline tool
		// whose confirmation we're now reconciling. Final turn
		// array should contain the preserved successful entry +
		// the newly synthesized inline-tool entry, in that order.
		const earlierEntry = {
			id: "call_search_ok",
			name: "search_teams_messages",
			status: "success" as const,
			startedAt: Date.now() - 8000,
			durationMs: 350,
		};
		const stalePending = {
			id: "call_stale_pending",
			name: "search_repository_code",
			status: "pending" as const,
			startedAt: Date.now() - 10000,
		};
		const state = createMockState({
			messages: buildPostConfirmMessages({
				accepted: true,
				inlineToolId: "call_recon_keep",
				inlineToolName: "apply_document_patches",
				withMarker: true,
			}),
			// Non-empty turn array, but no entry whose name is in
			// POST_CONFIRMATION_INLINE_TOOLS — so in-place flip
			// fails and reconstruct takes over.
			toolCallsByTurn: {
				1: [earlierEntry, stalePending],
			},
		} as Partial<AgentState>);

		const command = await chatNode(state);
		const update = (command as any).update;

		const entries = update.toolCallsByTurn[1];
		// Preserved success + synthesized inline tool; stale
		// pending dropped.
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			id: "call_search_ok",
			name: "search_teams_messages",
			status: "success",
			durationMs: 350,
		});
		expect(entries[1]).toMatchObject({
			id: "call_recon_keep",
			name: "apply_document_patches",
			status: "success",
		});
		expect(
			entries.find((e: { id: string }) => e.id === "call_stale_pending"),
		).toBeUndefined();
	});

	it("no resolution: emits info log with resolutionPath='none' when neither path resolves", async () => {
		// Legacy-thread case: confirm_changes message lacks the
		// `args.__inlineTool` marker (saved before this PR's deploy).
		// Both in-place and reconstruct fail. The unconditional
		// reconciliation log must still fire so production telemetry
		// can detect this failure mode.
		const state = createMockState({
			messages: buildPostConfirmMessages({
				accepted: true,
				inlineToolId: "call_no_marker",
				inlineToolName: "apply_document_patches",
				withMarker: false, // ← legacy shape
			}),
			toolCallsByTurn: {},
		} as Partial<AgentState>);

		const command = await chatNode(state);
		const update = (command as any).update;

		// No toolCallsByTurn update is produced for the "none" path.
		expect(update.toolCallsByTurn).toBeUndefined();
		// But the chat-node still produces an acknowledgment message
		// so the user sees a response (graceful degradation).
		expect(update.messages).toBeDefined();
		const lastMsg = update.messages[update.messages.length - 1];
		expect((lastMsg as AIMessage).content).toContain(
			"Changes have been applied",
		);
	});

	it("reconstruct correlates by tool_call_id when multiple confirm_changes exist (no wrong-trace corruption)", async () => {
		// Regression guard for the adversarial scenario: state.messages
		// contains TWO confirm_changes AIMessages with different
		// __inlineTool markers. The answering ToolMessage at the tail
		// references the OLDER one's id (call_confirm_OLD), so the
		// reconstruct path MUST resolve OLD's marker —
		// `apply_document_patches` / `call_inline_OLD` — and NOT the
		// most-recent confirm_changes (which would point at
		// `write_document_local` / `call_inline_NEW` and corrupt the
		// user-visible trace).
		//
		// Without tool_call_id correlation, the naive
		// "most-recent AI with any __inlineTool" lookup picks NEW,
		// causing the trace to mark the wrong inline tool as
		// resolved.
		const oldConfirmAi = new AIMessage({
			content: "Changes ready for review.",
			tool_calls: [
				{
					id: "call_confirm_OLD",
					name: "confirm_changes",
					args: {
						__inlineTool: {
							id: "call_inline_OLD",
							name: "apply_document_patches",
						},
					},
					type: "tool_call" as const,
				},
			],
		});
		const newConfirmAi = new AIMessage({
			content: "Changes ready for review (round 2).",
			tool_calls: [
				{
					id: "call_confirm_NEW",
					name: "confirm_changes",
					args: {
						__inlineTool: {
							id: "call_inline_NEW",
							name: "write_document_local",
						},
					},
					type: "tool_call" as const,
				},
			],
		});

		const state = createMockState({
			messages: [
				new HumanMessage("First request"),
				oldConfirmAi,
				new AIMessage("Acknowledged round 1."),
				new HumanMessage("Second request"),
				newConfirmAi,
				// ToolMessage answers the OLDER confirm_changes —
				// out-of-order delivery / rehydration edge.
				new ToolMessage({
					content: JSON.stringify({ accepted: true }),
					tool_call_id: "call_confirm_OLD",
				}),
			],
			toolCallsByTurn: {},
		} as Partial<AgentState>);

		const command = await chatNode(state);
		const update = (command as any).update;

		expect(update.toolCallsByTurn).toBeDefined();
		// countHumanMessages = 2, so the resolved entry lands at
		// turnIndex 2.
		const entries = update.toolCallsByTurn[2];
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			id: "call_inline_OLD",
			name: "apply_document_patches",
			status: "success",
		});
		// Critically: the NEW marker must NOT be selected.
		expect(entries[0].id).not.toBe("call_inline_NEW");
		expect(entries[0].name).not.toBe("write_document_local");
	});
});

describe("chat-node reasoning capture — Vercel Gateway path", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
	});

	it("populates reasoningByTurn from __raw_response and strips the envelope from persisted state", async () => {
		// Arrange: mock the model to return an AIMessage whose only reasoning
		// signal is in additional_kwargs.__raw_response — mimicking the
		// Gateway response shape after our langchain-models factory enables
		// __includeRawResponse: true. content is a string (no thinking blocks).
		const rawReasoningText =
			"Walking through scaling: connection pool size, hot cache keys, cache invalidation tradeoffs…";
		mockInvoke.mockResolvedValueOnce({
			content: "Here are three scaling recommendations.",
			tool_calls: [],
			additional_kwargs: {
				__raw_response: {
					choices: [
						{
							message: {
								content:
									"Here are three scaling recommendations.",
								reasoning: rawReasoningText,
							},
						},
					],
				},
			},
		});

		// turnIndex = 1 (one HumanMessage in state.messages)
		const state = createMockState({
			messages: [
				new HumanMessage(
					"Think deeply about scaling considerations: connection limits, hot paths, cache invalidation.",
				),
			],
		});

		// Act
		const result = await chatNode(state);

		// ASSERT 1 — reasoningByTurn populated (Codex P1.1 ordering-bug guard:
		// if the __raw_response cleanup ran before extraction, this would be
		// undefined and the suite would catch the regression).
		expect(result).toHaveProperty("update");
		const update = (result as { update: Record<string, unknown> }).update;
		expect(update.reasoningByTurn).toEqual({
			1: expect.objectContaining({
				text: rawReasoningText,
				startedAt: expect.any(Number),
				completedAt: expect.any(Number),
				durationMs: expect.any(Number),
			}),
		});

		// ASSERT 2 — the persisted assistant message has its raw envelope
		// stripped (state-bloat guard).
		const messages = update.messages as Array<{
			additional_kwargs?: { __raw_response?: unknown };
			_getType?: () => string;
		}>;
		const lastMessage = messages[messages.length - 1];
		expect(lastMessage.additional_kwargs?.__raw_response).toBeUndefined();
	});

	it("yields empty reasoningByTurn when neither content[] nor __raw_response carries reasoning (no enrollment / non-Claude model)", async () => {
		// Negative case: model returned plain string content, no __raw_response.
		// The factory would skip enrollment for these (e.g. openai/gpt-4o via
		// Vercel Gateway, or any non-Vercel gateway). The agent must NOT
		// invent a reasoning step.
		mockInvoke.mockResolvedValueOnce({
			content: "Three scaling recommendations: …",
			tool_calls: [],
		});
		const state = createMockState({
			messages: [new HumanMessage("Three scaling recs please.")],
		});
		const result = await chatNode(state);
		const update = (result as { update: Record<string, unknown> }).update;
		expect(update.reasoningByTurn).toBeUndefined();
	});
});

describe("AC-12 — vision-unsupported model fallback copy lock", () => {
	// The chat-node catch block surfaces `VISION_UNSUPPORTED_USER_MESSAGE`
	// to the user when `isVisionUnsupportedError(err) === true` — see
	// `chat-node.ts` near the `isVisionError` branch. We lock the exact
	// copy here so a future refactor (translation move, wording tweak)
	// cannot silently change the user-facing string as a side effect.

	it("locks the exact user-facing copy at the constant level", () => {
		// Arrange + Act: the constant IS the user-facing message; reading
		// it directly is the smallest unit of regression coverage we can
		// write without booting the full chat-node graph.
		const message = VISION_UNSUPPORTED_USER_MESSAGE;

		// Assert: the exact opening substring the contract anchors against.
		expect(message).toContain(
			"The current AI model doesn't support image input.",
		);
		// And the example model names, which are locked too.
		expect(message).toContain("Claude Sonnet");
		expect(message).toContain("GPT-4o");
	});

	it("matches the full verbatim string", () => {
		// Locking the entire string belt-and-braces — any wording change
		// (admin -> ops, GPT-4o -> GPT-5, etc.) will trip this assertion
		// and force the PR author to update spec/requirements alongside.
		expect(VISION_UNSUPPORTED_USER_MESSAGE).toBe(
			"The current AI model doesn't support image input. Remove the attached images, or ask an admin to configure a vision-capable model (e.g., Claude Sonnet or GPT-4o) for tool-calling before retrying.",
		);
	});
});

// =============================================================================
// No-op confirm suppression + bare-confirm interception
// =============================================================================
//
// Two gates that keep the "Confirm changes" affordance from ever appearing when
// there is nothing to apply:
//   A. buildConfirmChangesCommand suppresses the synthetic confirm_changes when
//      the produced document is normalized-identical to the baseline — a plain
//      assistant reply is emitted instead, and the document state is left alone.
//   B. A model that calls confirm_changes itself (no document written) is
//      intercepted at dispatch so its tool call never reaches the frontend.

describe("Project Document Generator Chat Node - No-op confirm suppression", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
	});

	// Collect every tool-call name across a Command's returned messages, coping
	// with both the LangChain (`name`) and legacy OpenAI (`function.name`)
	// shapes.
	function collectToolCallNames(messages: unknown[] | undefined): string[] {
		const names: string[] = [];
		for (const m of messages ?? []) {
			const calls = (m as { tool_calls?: unknown[] })?.tool_calls ?? [];
			for (const c of calls) {
				const name =
					(c as { name?: string })?.name ??
					(c as { function?: { name?: string } })?.function?.name;
				if (name) {
					names.push(name);
				}
			}
		}
		return names;
	}

	it("suppresses the synthetic confirm_changes when the written document is normalized-identical to the baseline", async () => {
		// A trailing-whitespace-only difference proves the gate uses
		// normalizeForComparison, not raw string equality — the same predicate
		// the save layer uses to decide "no real change".
		const baseline = "## Overview\n\nThe body is already complete.\n";
		const writtenWithTrailingWs =
			"## Overview  \n\nThe body is already complete.  \n";

		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content:
					"The document already covers everything requested — no edits were needed.",
				tool_calls: [
					{
						id: "call_noop_write",
						name: "write_document_local",
						args: { document: writtenWithTrailingWs },
					},
				],
			}),
		);

		const state = createMockState({
			document: baseline,
			messages: [new HumanMessage("Make sure the overview is complete")],
		});

		const command = await chatNode(state);
		const update = (command as any).update;

		// No confirm_changes tool call anywhere — no frontend confirm card.
		expect(collectToolCallNames(update.messages)).not.toContain(
			"confirm_changes",
		);

		// A plain assistant reply carrying the model's own commentary, no tools.
		const lastMsg = update.messages[update.messages.length - 1];
		expect(lastMsg.content).toBe(
			"The document already covers everything requested — no edits were needed.",
		);
		expect(lastMsg.tool_calls ?? []).toHaveLength(0);

		// Document state is NOT overwritten (editor stays on the baseline).
		expect(update.document).toBeUndefined();
		expect(update.streamingContent).toBeUndefined();

		// The inline tool trace resolves to success rather than stranding a
		// permanent "awaiting confirmation" pending row.
		const entries = update.toolCallsByTurn?.[1];
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			id: "call_noop_write",
			name: "write_document_local",
			status: "success",
		});
	});

	it("falls back to the neutral no-changes notice when the model returns no commentary on a no-op", async () => {
		const baseline = "## Overview\n\nUnchanged body.\n";
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "call_noop_empty",
						name: "write_document_local",
						args: { document: baseline },
					},
				],
			}),
		);

		const state = createMockState({
			document: baseline,
			messages: [new HumanMessage("tidy it up")],
		});

		const command = await chatNode(state);
		const update = (command as any).update;

		expect(collectToolCallNames(update.messages)).not.toContain(
			"confirm_changes",
		);
		const lastMsg = update.messages[update.messages.length - 1];
		expect(lastMsg.content).toContain("no changes to make");
		// The neutral "Changes ready for review." fallback must NOT be used here.
		expect(lastMsg.content).not.toContain("Changes ready for review");
	});

	it("still emits the synthetic confirm_changes (with __inlineTool marker) on a real change", async () => {
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "Added a new section.",
				tool_calls: [
					{
						id: "call_real_write",
						name: "write_document_local",
						args: {
							document:
								"## Overview\n\nOriginal.\n\n## New Section\n\nFresh content.\n",
						},
					},
				],
			}),
		);

		const state = createMockState({
			document: "## Overview\n\nOriginal.\n",
			messages: [new HumanMessage("add a new section")],
		});

		const command = await chatNode(state);
		const update = (command as any).update;

		// Real change ⇒ document updated + confirm_changes synthesized, and the
		// synthetic call carries the __inlineTool marker that distinguishes it
		// from a model-initiated bare confirm.
		expect(update.document).toContain("New Section");
		const lastMsg = update.messages[update.messages.length - 1];
		const confirmCall = lastMsg.tool_calls[0];
		expect(confirmCall.name ?? confirmCall.function?.name).toBe(
			"confirm_changes",
		);
		expect(confirmCall.args.__inlineTool).toMatchObject({
			id: "call_real_write",
			name: "write_document_local",
		});
	});

	it("intercepts a model-initiated bare confirm_changes call so it never reaches the frontend", async () => {
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "I've prepared the updates for your review.",
				tool_calls: [
					{
						id: "call_bare_confirm",
						name: "confirm_changes",
						args: {},
					},
				],
			}),
		);

		const state = createMockState({
			document: "## Overview\n\nExisting body.\n",
			messages: [new HumanMessage("update the doc")],
		});

		const command = await chatNode(state);
		const update = (command as any).update;

		// The model's confirm_changes call must not survive into state — the
		// transport emits frontend tool calls by scanning state.messages.
		expect(collectToolCallNames(update.messages)).not.toContain(
			"confirm_changes",
		);

		// The run ends with a plain assistant reply preserving the model's text.
		const lastMsg = update.messages[update.messages.length - 1];
		expect(lastMsg.content).toBe(
			"I've prepared the updates for your review.",
		);
		expect(lastMsg.tool_calls ?? []).toHaveLength(0);

		// No document overwrite and no stranded confirm_changes trace entry.
		expect(update.document).toBeUndefined();
		expect(update.toolCallsByTurn).toBeUndefined();
	});

	it("uses the neutral notice when a bare confirm_changes arrives with no commentary", async () => {
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "call_bare_empty",
						name: "confirm_changes",
						args: {},
					},
				],
			}),
		);

		const state = createMockState({
			document: "## Overview\n\nExisting body.\n",
			messages: [new HumanMessage("confirm the doc is fine")],
		});

		const command = await chatNode(state);
		const update = (command as any).update;

		expect(collectToolCallNames(update.messages)).not.toContain(
			"confirm_changes",
		);
		const lastMsg = update.messages[update.messages.length - 1];
		expect(lastMsg.content).toContain("no changes to make");
	});

	it("leaves write_document_local dispatch unchanged when the change is real", async () => {
		// Guard that the interception branch is scoped to confirm_changes and
		// does not shadow the normal write dispatch path.
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "Rewrote the overview.",
				tool_calls: [
					{
						id: "call_write_ok",
						name: "write_document_local",
						args: {
							document: "## Overview\n\nRewritten body.\n",
						},
					},
				],
			}),
		);

		const state = createMockState({
			document: "## Overview\n\nOriginal body.\n",
			messages: [new HumanMessage("rewrite the overview")],
		});

		const command = await chatNode(state);
		const update = (command as any).update;

		expect(update.document).toContain("Rewritten body");
		expect(collectToolCallNames(update.messages)).toContain(
			"confirm_changes",
		);
	});
});

describe("Project Document Generator Chat Node - Section preservation guard", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
	});

	function collectToolCallNames(messages: unknown[] | undefined): string[] {
		const names: string[] = [];
		for (const m of messages ?? []) {
			const calls = (m as { tool_calls?: unknown[] })?.tool_calls ?? [];
			for (const c of calls) {
				const name =
					(c as { name?: string })?.name ??
					(c as { function?: { name?: string } })?.function?.name;
				if (name) {
					names.push(name);
				}
			}
		}
		return names;
	}

	// Small (write-mode) doc with a substantial Acceptance Criteria section.
	const AC_BODY = [
		"GIVEN a registered user WHEN they log in with valid credentials THEN they are redirected to the dashboard and see their active projects.",
		"GIVEN an invalid password WHEN they submit the form THEN an inline error explains the failure and no session is created for them.",
		"GIVEN a locked account WHEN they attempt to sign in THEN they are told to contact support and no session is created for them.",
	].join("\n");
	const baselineDoc = [
		"## Overview",
		"",
		"The product helps teams ship faster across planning, review, and deployment.",
		"",
		"## Acceptance Criteria",
		"",
		AC_BODY,
		"",
		"## Stakeholders",
		"",
		"- Alice (PM)",
		"- Bob (Engineering)",
	].join("\n");
	const guttedRewrite = () => baselineDoc.replace(AC_BODY, "TBD");

	it("retries with a corrective ToolMessage when a rewrite guts a section", async () => {
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "Tightened the doc.",
				tool_calls: [
					{
						id: "call_gut_1",
						name: "write_document_local",
						args: { document: guttedRewrite() },
					},
				],
			}),
		);
		const state = createMockState({
			document: baselineDoc,
			messages: [new HumanMessage("tighten the overview")],
		});
		const command = await chatNode(state);

		// Routes back to the model instead of surfacing a confirm card.
		// LangGraph normalises `goto` to an array.
		const goto = (command as any).goto;
		expect(Array.isArray(goto) ? goto : [goto]).toContain("chat_node");
		const update = (command as any).update;
		expect(update.retryCount).toBe(1);
		const lastMsg = update.messages[update.messages.length - 1];
		const content =
			typeof lastMsg.content === "string" ? lastMsg.content : "";
		expect(content).toContain("Acceptance Criteria");
		// The working document is reset to the baseline for the retry.
		expect(update.document).toBe(baselineDoc);
		expect(collectToolCallNames(update.messages)).not.toContain(
			"confirm_changes",
		);
	});

	it("accepts the model output once the retry budget is spent", async () => {
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "Tightened the doc.",
				tool_calls: [
					{
						id: "call_gut_2",
						name: "write_document_local",
						args: { document: guttedRewrite() },
					},
				],
			}),
		);
		const state = createMockState({
			document: baselineDoc,
			retryCount: 3, // MAX_RETRIES — budget spent
			messages: [new HumanMessage("tighten the overview")],
		});
		const command = await chatNode(state);
		const update = (command as any).update;

		const goto = (command as any).goto;
		expect(Array.isArray(goto) ? goto : [goto]).not.toContain("chat_node");
		expect(update.document).toContain("TBD");
		expect(collectToolCallNames(update.messages)).toContain(
			"confirm_changes",
		);
		// AC2: the confirm card carries a partial-completion warning naming the
		// section that couldn't be preserved.
		const confirmMsg = update.messages[update.messages.length - 1];
		const confirmText =
			typeof confirmMsg.content === "string" ? confirmMsg.content : "";
		expect(confirmText).toContain("didn't fully update");
		expect(confirmText).toContain("Acceptance Criteria");
	});

	it("does not fire on a normal edit that preserves every section", async () => {
		const edited = baselineDoc.replace(
			"The product helps teams ship faster across planning, review, and deployment.",
			"The product helps teams ship faster across planning, review, testing, and deployment.",
		);
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "Added testing to the overview.",
				tool_calls: [
					{
						id: "call_ok_1",
						name: "write_document_local",
						args: { document: edited },
					},
				],
			}),
		);
		const state = createMockState({
			document: baselineDoc,
			messages: [new HumanMessage("mention testing")],
		});
		const command = await chatNode(state);
		const update = (command as any).update;

		expect(collectToolCallNames(update.messages)).toContain(
			"confirm_changes",
		);
		expect(update.document).toContain("testing");
	});
});

// =============================================================================
// sanitizeMessagesForModel — parallel tool_call / tool_result pairing
// =============================================================================
//
// One assistant turn routinely emits several parallel tool_calls, and the
// provider requires a tool_result for EVERY one of them, contiguous with the
// turn that requested them. An incomplete or interleaved batch is rejected
// wholesale — on Databricks with an empty-body 400 that carries no field
// detail — so the sanitizer must drop the tool_calls rather than let a
// malformed history reach the wire.

const PAIRING_TOOLS = new Set(["tool_a", "tool_b"]);

/** AI turn requesting N parallel tool calls. */
function aiWithToolCalls(ids: string[]): AIMessage {
	return new AIMessage({
		content: "",
		tool_calls: ids.map((id, i) => ({
			id,
			name: i === 0 ? "tool_a" : "tool_b",
			args: {},
			type: "tool_call" as const,
		})),
	});
}

/** Count surviving AI messages that still carry tool_calls. */
function countAiWithToolCalls(messages: any[]): number {
	return messages.filter(
		(m) =>
			(m?.tool_calls?.length ?? 0) > 0 || (m?.toolCalls?.length ?? 0) > 0,
	).length;
}

describe("chatNode — deterministic provider 400", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
	});

	it("fails fast on a non-JSON HTTP 400 instead of retrying", async () => {
		// A request-schema rejection fails identically on every attempt, so the
		// retry loop would make 5 redundant provider calls before surfacing the
		// same error. An empty-body 400 also gives the vision/context matchers
		// nothing to pattern-match on, so this is the branch that catches it.
		mockInvoke.mockRejectedValueOnce(
			Object.assign(new Error("Bad Request"), { status: 400 }),
		);

		const command = await chatNode(
			createMockState({
				messages: [new HumanMessage("Generate the document.")],
			}),
		);
		const goto = (command as any).goto;
		const update = (command as any).update;

		expect(Array.isArray(goto) ? goto : [goto]).toContain("__end__");
		expect(update).toMatchObject({ retryCount: 0 });
		expect(update.error).toContain("Bad Request");
		expect(mockInvoke).toHaveBeenCalledTimes(1);
	});

	it("also fails fast when the status is only on the nested response", async () => {
		mockInvoke.mockRejectedValueOnce(
			Object.assign(new Error("Bad Request"), {
				response: { status: 400 },
			}),
		);

		const command = await chatNode(
			createMockState({
				messages: [new HumanMessage("Generate the document.")],
			}),
		);

		expect((command as any).update).toMatchObject({ retryCount: 0 });
		expect(mockInvoke).toHaveBeenCalledTimes(1);
	});
});

describe("sanitizeMessagesForModel — parallel tool pairing", () => {
	it("preserves a complete parallel batch", () => {
		const out = sanitizeMessagesForModel(
			[
				new HumanMessage({ content: "go" }),
				aiWithToolCalls(["c1", "c2"]),
				new ToolMessage({
					content: "a",
					tool_call_id: "c1",
					name: "tool_a",
				}),
				new ToolMessage({
					content: "b",
					tool_call_id: "c2",
					name: "tool_b",
				}),
			],
			PAIRING_TOOLS,
		);
		expect(countAiWithToolCalls(out)).toBe(1);
		expect(out.filter((m) => m instanceof ToolMessage)).toHaveLength(2);
	});

	it("strips tool_calls when one of two results is missing", () => {
		// The positional `result[i+1]` probe used to accept this: a tool message
		// does follow, it just isn't the whole batch.
		const out = sanitizeMessagesForModel(
			[
				new HumanMessage({ content: "go" }),
				aiWithToolCalls(["c1", "c2"]),
				new ToolMessage({
					content: "a",
					tool_call_id: "c1",
					name: "tool_a",
				}),
			],
			PAIRING_TOOLS,
		);
		expect(countAiWithToolCalls(out)).toBe(0);
	});

	it("strips tool_calls when a human turn is interleaved between results", () => {
		// Every id is present somewhere, but the batch is not contiguous.
		const out = sanitizeMessagesForModel(
			[
				new HumanMessage({ content: "go" }),
				aiWithToolCalls(["c1", "c2"]),
				new ToolMessage({
					content: "a",
					tool_call_id: "c1",
					name: "tool_a",
				}),
				new HumanMessage({ content: "interrupting" }),
				new ToolMessage({
					content: "b",
					tool_call_id: "c2",
					name: "tool_b",
				}),
			],
			PAIRING_TOOLS,
		);
		expect(countAiWithToolCalls(out)).toBe(0);
	});

	it("strips tool_calls when results carry duplicate ids", () => {
		const out = sanitizeMessagesForModel(
			[
				new HumanMessage({ content: "go" }),
				aiWithToolCalls(["c1", "c2"]),
				new ToolMessage({
					content: "a",
					tool_call_id: "c1",
					name: "tool_a",
				}),
				new ToolMessage({
					content: "b",
					tool_call_id: "c1",
					name: "tool_b",
				}),
			],
			PAIRING_TOOLS,
		);
		expect(countAiWithToolCalls(out)).toBe(0);
	});

	it("strips tool_calls when a call id is blank", () => {
		const out = sanitizeMessagesForModel(
			[
				new HumanMessage({ content: "go" }),
				aiWithToolCalls(["   ", "c2"]),
				new ToolMessage({
					content: "a",
					tool_call_id: "   ",
					name: "tool_a",
				}),
				new ToolMessage({
					content: "b",
					tool_call_id: "c2",
					name: "tool_b",
				}),
			],
			PAIRING_TOOLS,
		);
		expect(countAiWithToolCalls(out)).toBe(0);
	});

	it("keeps a single complete call/result pair", () => {
		const out = sanitizeMessagesForModel(
			[
				new HumanMessage({ content: "go" }),
				aiWithToolCalls(["c1"]),
				new ToolMessage({
					content: "a",
					tool_call_id: "c1",
					name: "tool_a",
				}),
			],
			PAIRING_TOOLS,
		);
		expect(countAiWithToolCalls(out)).toBe(1);
	});
});

/**
 * The "## Diagrams (Excalidraw)" system-prompt section — routing guidance
 * for the managed-default `create_view` MCP tool.
 *
 * Bug context: the assistant invoked `create_view` for conversational
 * messages that never asked for a diagram, and the parameter guidance
 * contradicted the tool schema (prompt said "array" while the schema —
 * matching the upstream MCP server — says JSON-encoded string). These
 * tests pin the tightened prompt: the negative default for conversational
 * turns, the Mermaid arbitration, and the schema-aligned parameter text.
 */
describe("Project Document Generator Chat Node - Excalidraw prompt routing", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
	});

	async function systemPromptWithActions(
		actions: Array<{ name: string }>,
	): Promise<string> {
		mockInvoke.mockResolvedValueOnce(new AIMessage({ content: "ok" }));
		const state = createMockState({
			messages: [new HumanMessage("I think option #1 is best.")],
			copilotkit: {
				actions: actions as never,
				context: [],
			} as never,
		});
		await chatNode(state);
		expect(mockInvoke).toHaveBeenCalledTimes(1);
		const [callMessages] = mockInvoke.mock.calls[0] as [
			Array<{ content: unknown }>,
		];
		const system = callMessages[0];
		expect(typeof system.content).toBe("string");
		return system.content as string;
	}

	it("appends the section only when create_view is among the actions", async () => {
		const prompt = await systemPromptWithActions([{ name: "create_view" }]);
		expect(prompt).toContain("## Diagrams (Excalidraw)");
	});

	it("omits the section when create_view is absent", async () => {
		const prompt = await systemPromptWithActions([
			{ name: "confirm_changes" },
		]);
		expect(prompt).not.toContain("## Diagrams (Excalidraw)");
	});

	it("carries the negative default for conversational messages", async () => {
		const prompt = await systemPromptWithActions([{ name: "create_view" }]);
		expect(prompt).toContain("**User's message is conversational**");
		expect(prompt).toContain("When in doubt");
	});

	it("arbitrates proactive diagrams toward mermaid in document content", async () => {
		const prompt = await systemPromptWithActions([{ name: "create_view" }]);
		expect(prompt).toContain("`mermaid` code block");
		expect(prompt).toContain("reserved for an explicit user request");
	});

	it("aligns parameter guidance with the tool schema (string, non-empty)", async () => {
		const prompt = await systemPromptWithActions([{ name: "create_view" }]);
		expect(prompt).toContain(
			"must be a **JSON-encoded string** of a **non-empty** array",
		);
		// The old text told the model to pass a raw array — the exact
		// contradiction that made calls fail upstream schema validation.
		expect(prompt).not.toContain("expects an `elements` array");
	});

	it("keeps the positive triggers and the do-NOT-mix rule intact", async () => {
		const prompt = await systemPromptWithActions([{ name: "create_view" }]);
		expect(prompt).toContain("asks for a diagram, drawing, visualization");
		expect(prompt).toContain(
			"do NOT mix tools when the user only wants a diagram",
		);
	});
});

// =============================================================================
// Truncated-empty response recovery (issue #2976)
// =============================================================================
//
// A reasoning-capable model served through a gateway bills invisible thinking
// against the same output budget as the visible answer. After a long
// repository-exploration tool loop the accumulated input is large, thinking
// scales with it, and the budget can be gone before a single visible token is
// emitted: the turn comes back `finish_reason: length` with NO content and NO
// tool calls. Before this fix that fell through the "no tool call" branch and
// ended the run with `error: undefined`, leaving the document untouched and the
// user with the generic "I wasn't able to generate a response" fallback.
describe("Project Document Generator Chat Node - Truncated-Empty Response Recovery", () => {
	const truncatedEmptyResponse = () =>
		new AIMessage({
			content: "",
			tool_calls: [],
			response_metadata: { finish_reason: "length" },
		});

	beforeEach(() => {
		mockInvoke.mockReset();
		vi.mocked(getAgentModelAsync).mockClear();
	});

	it("retries once with an escalated output budget when the response is empty and truncated", async () => {
		mockInvoke.mockResolvedValueOnce(truncatedEmptyResponse());
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "Updated.",
				tool_calls: [
					{
						id: "call_after_retry",
						name: "write_document_local",
						args: { document: "# Overview\n\nRewritten body.\n" },
					},
				],
			}),
		);

		const state = createMockState({
			document: "## Overview\n\nTiny document.\n",
			messages: [new HumanMessage("update it")],
		});

		const command = await chatNode(state);

		// Exactly one retry — not a loop.
		expect(mockInvoke).toHaveBeenCalledTimes(2);

		const calls = vi.mocked(getAgentModelAsync).mock.calls;
		const firstOptions = calls[0]?.[1] as {
			maxTokens?: number;
			maxTokensForConfig?: (cfg: unknown) => number;
		};
		const retryOptions = calls.at(-1)?.[1] as {
			maxTokens?: number;
			maxTokensForConfig?: (cfg: unknown) => number;
		};

		expect(retryOptions?.maxTokens).toBeGreaterThan(
			firstOptions?.maxTokens as number,
		);
		// The reasoning-model budget is what actually overflowed in production
		// (16K floor + 12K allowance = the 28,000 the failing run requested);
		// the retry has to escalate THAT number, not just the base.
		const firstResolved = firstOptions?.maxTokensForConfig?.({
			model: "system.ai.claude-sonnet-5",
		}) as number;
		const retryResolved = retryOptions?.maxTokensForConfig?.({
			model: "system.ai.claude-sonnet-5",
		}) as number;
		expect(firstResolved).toBe(28000);
		expect(retryResolved).toBe(56000);

		// The retry's result is what the node acts on: the document was written.
		const update = (command as any).update;
		expect(update.document).toContain("Rewritten body");
		expect(update.error).toBeUndefined();
	});

	it("compresses the accumulated history on the retry while keeping the source document pinned", async () => {
		mockInvoke.mockResolvedValueOnce(truncatedEmptyResponse());
		// The forced budget gate summarizes the middle of the history through
		// the SIMPLE-task model — which resolves to the same stubbed invoke.
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({ content: "Earlier turns, condensed." }),
		);
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "Updated.",
				tool_calls: [
					{
						id: "call_after_retry_2",
						name: "write_document_local",
						args: { document: "# Overview\n\nRewritten body.\n" },
					},
				],
			}),
		);

		const longHistory: BaseMessage[] = [];
		for (let i = 0; i < 12; i++) {
			longHistory.push(new HumanMessage(`question ${i}`));
			longHistory.push(new AIMessage(`answer ${i}`));
		}

		const state = createMockState({
			document: "## Overview\n\nTiny document.\n",
			messages: longHistory,
		});

		await chatNode(state);

		expect(mockInvoke).toHaveBeenCalledTimes(3);
		const firstMessages = mockInvoke.mock.calls[0][0] as BaseMessage[];
		const retryMessages = mockInvoke.mock.calls[2][0] as BaseMessage[];

		expect(retryMessages.length).toBeLessThan(firstMessages.length);
		const asText = retryMessages.map((m) =>
			typeof m.content === "string"
				? m.content
				: JSON.stringify(m.content),
		);
		// The middle was replaced by a summary...
		expect(
			asText.some((t) => t.includes("Earlier context (summarized")),
		).toBe(true);
		// ...but the document being edited survived. Summarizing it away would
		// leave the model rewriting a document it can no longer see.
		expect(asText.some((t) => t.includes("fabric_source_document"))).toBe(
			true,
		);
		// EXACTLY ONE SystemMessage, at index 0. `@langchain/anthropic` strips
		// only the first message when it is a system message and throws on any
		// later one, so the summary must be merged into the system prompt rather
		// than appended as a second SystemMessage — otherwise every
		// direct-Anthropic request that reaches this gate fails.
		const systemIndexes = retryMessages
			.map((m, i) => (m instanceof SystemMessage ? i : -1))
			.filter((i) => i >= 0);
		expect(systemIndexes).toEqual([0]);
		expect(
			typeof retryMessages[0].content === "string"
				? retryMessages[0].content
				: "",
		).toContain("Earlier context (summarized");
	});

	it("ends with a user-facing error when the escalated retry is also empty and truncated", async () => {
		mockInvoke.mockResolvedValueOnce(truncatedEmptyResponse());
		mockInvoke.mockResolvedValueOnce(truncatedEmptyResponse());

		// Contains the literal wrapper token on purpose. The node's
		// `preEditDocument` baseline scrubs that token for prompt/edit
		// processing, so restoring THAT copy would silently rewrite a document
		// the user was just told is unchanged — the restore has to use the raw
		// node-entry snapshot.
		const originalDocument =
			"## Overview\n\nTiny document mentioning <fabric_source_document> and </fabric_source_document_> verbatim.\n";
		const state = createMockState({
			document: originalDocument,
			messages: [new HumanMessage("update it")],
		});

		const command = await chatNode(state);
		const goto = (command as any).goto;
		const update = (command as any).update;

		expect(mockInvoke).toHaveBeenCalledTimes(2);
		expect(Array.isArray(goto) ? goto[0] : goto).toBe("__end__");
		expect(update.error).toBe(TRUNCATED_EMPTY_RESPONSE_USER_MESSAGE);
		// unified-server prefers a friendly `response`/`error` string for the
		// assistant turn, but the message list is what gets persisted — the
		// explanation has to be in both.
		const last = update.messages.at(-1);
		expect(last.content).toBe(TRUNCATED_EMPTY_RESPONSE_USER_MESSAGE);
		// The message promises the document was not changed, so the update has
		// to SAY so rather than stay silent: `predict_state` streams partial
		// `write_document_local` arguments into state.document as they arrive,
		// and a call truncated mid-arguments lands in `invalid_tool_calls`,
		// which the emptiness check deliberately ignores. Omitting `document`
		// here would leave that fragment as the final state. Byte-identical:
		// the wrapper tokens above must survive verbatim.
		expect(update.document).toBe(originalDocument);
	});

	it("leaves a genuinely empty (non-truncated) response on the existing no-tool-call path", async () => {
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({ content: "", tool_calls: [] }),
		);

		const state = createMockState({
			document: "## Overview\n\nTiny document.\n",
			messages: [new HumanMessage("update it")],
		});

		const command = await chatNode(state);
		const goto = (command as any).goto;
		const update = (command as any).update;

		// No stop reason means no evidence of truncation: no retry, and the
		// existing quiet-END behavior is unchanged.
		expect(mockInvoke).toHaveBeenCalledTimes(1);
		expect(Array.isArray(goto) ? goto[0] : goto).toBe("__end__");
		expect(update.error).toBeUndefined();
	});
});

// =============================================================================
// Reasoning carry-over across the truncation-recovery retry (issue #2976)
// =============================================================================
//
// The retry REPLACES `response`, so without an explicit carry-over the failed
// attempt's reasoning is gone — and on this failure class that trace is the
// only record of what the model spent its entire output budget thinking about.
// The source guard in chat-node-reasoning-spread.test.ts only counts call
// sites; it cannot see whether `existingByTurn` is still chained or whether the
// fallback survives. These drive the node and read the resulting slice.
describe("Project Document Generator Chat Node - Reasoning carry-over across the truncation retry", () => {
	const thinkingBlock = (text: string) => ({
		type: "thinking",
		thinking: text,
	});

	// Truncated, empty of visible output, but carrying a thinking block — the
	// exact production shape: budget spent entirely on invisible reasoning.
	const truncatedEmptyWithReasoning = (trace: string) =>
		new AIMessage({
			content: [thinkingBlock(trace)] as any,
			tool_calls: [],
			response_metadata: { finish_reason: "length" },
		});

	const writeToolCall = (id: string) => ({
		id,
		name: "write_document_local",
		args: { document: "# Overview\n\nRewritten body.\n" },
	});

	beforeEach(() => {
		mockInvoke.mockReset();
		vi.mocked(getAgentModelAsync).mockClear();
	});

	it("coalesces the failed attempt's reasoning with the retry's, once and in order", async () => {
		mockInvoke.mockResolvedValueOnce(
			truncatedEmptyWithReasoning("FIRST-TRACE "),
		);
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: [
					thinkingBlock("SECOND-TRACE"),
					{ type: "text", text: "Updated." },
				] as any,
				tool_calls: [writeToolCall("call_carry_1")],
			}),
		);

		const state = createMockState({
			document: "## Overview\n\nTiny document.\n",
			messages: [new HumanMessage("update it")],
		});

		const command = await chatNode(state);
		const update = (command as any).update;

		expect(mockInvoke).toHaveBeenCalledTimes(2);
		// One entry for the turn, both traces, failed attempt first — not the
		// retry's trace alone, and not either trace twice.
		expect(update.reasoningByTurn[1].text).toBe("FIRST-TRACE SECOND-TRACE");
	});

	it("keeps the failed attempt's reasoning when the retry produces none", async () => {
		mockInvoke.mockResolvedValueOnce(
			truncatedEmptyWithReasoning("ONLY-TRACE"),
		);
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [],
				response_metadata: { finish_reason: "length" },
			}),
		);

		const state = createMockState({
			document: "## Overview\n\nTiny document.\n",
			messages: [new HumanMessage("update it")],
		});

		const command = await chatNode(state);
		const update = (command as any).update;

		// buildReasoningUpdate returns {} for the reasoning-free retry, so
		// without the fallback the carried trace would be dropped — on the very
		// path where it is the only diagnostic evidence that survives.
		expect(update.error).toBe(TRUNCATED_EMPTY_RESPONSE_USER_MESSAGE);
		expect(update.reasoningByTurn[1].text).toBe("ONLY-TRACE");
	});

	it("appends to the turn's existing reasoning on an ordinary turn, without duplication", async () => {
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: [
					thinkingBlock("NOW"),
					{ type: "text", text: "Updated." },
				] as any,
				tool_calls: [writeToolCall("call_carry_2")],
			}),
		);

		const state = createMockState({
			document: "## Overview\n\nTiny document.\n",
			messages: [new HumanMessage("update it")],
			reasoningByTurn: {
				1: {
					text: "PRIOR ",
					durationMs: 10,
					startedAt: 1,
					completedAt: 11,
				},
			},
		});

		const command = await chatNode(state);
		const update = (command as any).update;

		// No truncation, so no retry and no carry-over: the in-turn coalescing
		// that already existed must still be exactly one pass over the response.
		expect(mockInvoke).toHaveBeenCalledTimes(1);
		expect(update.reasoningByTurn[1].text).toBe("PRIOR NOW");
	});
});

/**
 * Finalize mode — prompt-cache stability and the post-invoke tool guard.
 *
 * Issue #2999: the finalize turn is the largest call of a long run. It used to
 * arrive with a changed system prompt AND a shrunken tool list, so the whole
 * request prefix missed the provider's prompt cache and the entire accumulated
 * history was billed uncached. The finalize instruction now rides in an
 * ephemeral trailing user message, and the budget is enforced after the invoke.
 */
describe("Project Document Generator Chat Node - Finalize mode (issue #2999)", () => {
	// The mocked `getAgentModelAsync` resolves the same model object on every
	// call, so its `bindTools` is a stable spy across the whole file — clear it
	// per test rather than reading a stale call list.
	async function getBindToolsSpy() {
		const model = await (
			getAgentModelAsync as unknown as () => Promise<{
				bindTools: ReturnType<typeof vi.fn>;
			}>
		)();
		return model.bindTools;
	}

	function boundToolNamesFromCall(call: unknown[]): string[] {
		return (call[0] as Array<Record<string, any>>).map(
			(t) => t.function?.name ?? t.name,
		);
	}

	// Full serialization of a message, so the prefix comparison covers
	// tool_calls and additional_kwargs — not only the visible content.
	function serializeMessage(message: BaseMessage): string {
		return JSON.stringify({
			type: (message as any).getType?.() ?? (message as any)._getType?.(),
			content: message.content,
			tool_calls: (message as AIMessage).tool_calls ?? null,
			invalid_tool_calls:
				(message as AIMessage).invalid_tool_calls ?? null,
			tool_call_id: (message as ToolMessage).tool_call_id ?? null,
			additional_kwargs: message.additional_kwargs ?? {},
			response_metadata: message.response_metadata ?? {},
		});
	}

	/** `count` AI-tool-call rounds, each with its ToolMessage result. */
	function buildToolRounds(count: number): BaseMessage[] {
		const messages: BaseMessage[] = [];
		for (let i = 0; i < count; i++) {
			const id = `call_round_${i}`;
			messages.push(
				new AIMessage({
					content: "",
					tool_calls: [
						{
							id,
							name: "search_project_knowledge",
							args: { query: `q${i}` },
						},
					],
				}),
			);
			messages.push(
				new ToolMessage({ content: `result ${i}`, tool_call_id: id }),
			);
		}
		return messages;
	}

	function stateWithRounds(rounds: number) {
		return createMockState({
			messages: [
				new HumanMessage("Write the architecture doc"),
				...buildToolRounds(rounds),
			],
		});
	}

	function writeResponse(id: string) {
		return new AIMessage({
			content: "Done.",
			tool_calls: [
				{
					id,
					name: "write_document_local",
					args: { document: "# Architecture\n\nBody." },
				},
			],
		});
	}

	function searchResponse(id: string) {
		return new AIMessage({
			content: "",
			tool_calls: [
				{
					id,
					name: "search_project_knowledge",
					args: { query: "more research" },
				},
			],
		});
	}

	beforeEach(async () => {
		mockInvoke.mockReset();
		(await getBindToolsSpy()).mockClear();
	});

	it("leaves the request prefix byte-identical: no system-prompt append and the same bound tool definitions as the previous round", async () => {
		const bindTools = await getBindToolsSpy();

		// Round 19 — still inside the budget.
		mockInvoke.mockResolvedValueOnce(writeResponse("call_pre"));
		await chatNode(stateWithRounds(MAX_TOOL_ITERATIONS - 1));
		const nonFinalizeBindCall = bindTools.mock.calls[0];
		const [nonFinalizeMessages] = mockInvoke.mock.calls[0] as [
			BaseMessage[],
		];

		mockInvoke.mockReset();
		bindTools.mockClear();

		// Round 20 — finalize turn. Round 19's request is a strict prefix of
		// round 20's: two more history messages, then the ephemeral directive.
		mockInvoke.mockResolvedValueOnce(writeResponse("call_final"));
		await chatNode(stateWithRounds(MAX_TOOL_ITERATIONS));
		const finalizeBindCall = bindTools.mock.calls[0];
		const finalizeTools = boundToolNamesFromCall(finalizeBindCall);
		const [finalizeMessages] = mockInvoke.mock.calls[0] as [BaseMessage[]];

		// The tool definitions serialize ahead of the messages, inside the
		// cacheable prefix — the FULL definitions must not change, not just
		// their names: a changed description or parameter schema breaks the
		// cache exactly as a dropped tool does. The bind options
		// (`parallel_tool_calls`) are part of the same call and compared with it.
		expect(finalizeTools).toContain("search_project_knowledge");
		expect(finalizeTools.length).toBeGreaterThan(1);
		expect(JSON.stringify(finalizeBindCall)).toBe(
			JSON.stringify(nonFinalizeBindCall),
		);

		// The system message is the head of that prefix.
		expect(String(finalizeMessages[0].content)).not.toContain(
			"Research Budget Exhausted",
		);

		// And every message ahead of the ephemeral tail is unchanged — compared
		// as fully serialized objects (type, content, tool_calls,
		// additional_kwargs, tool_call_id), not just their text, since the
		// sanitizer's known failure mode is reshaping tool_calls while leaving
		// content alone.
		//
		// This holds as long as the input-budget gate does not newly trigger on
		// the finalize round: crossing BUDGET_TRIM_TRIGGER_CHARS rewrites the
		// middle of the history into a summary and legitimately changes the
		// prefix. The fixture stays far below that threshold, which is the
		// condition under which prefix identity is claimed at all.
		expect(
			finalizeMessages
				.slice(0, nonFinalizeMessages.length)
				.map(serializeMessage),
		).toEqual(nonFinalizeMessages.map(serializeMessage));
	});

	it("appends the finalize directive as an ephemeral trailing user message that never reaches state", async () => {
		mockInvoke.mockResolvedValueOnce(writeResponse("call_final_2"));

		const command = await chatNode(stateWithRounds(MAX_TOOL_ITERATIONS));

		const [sentMessages] = mockInvoke.mock.calls[0] as [BaseMessage[]];
		const last = sentMessages[sentMessages.length - 1];
		expect(last).toBeInstanceOf(HumanMessage);
		expect(String(last.content)).toContain("[SYSTEM DIRECTIVE");
		expect(String(last.content)).toContain("Research Budget Exhausted");
		expect(String(last.content)).toContain(`${MAX_TOOL_ITERATIONS} rounds`);

		// Persisting it would add a human turn to the history, which is exactly
		// what `countToolRoundsSinceLastHuman` reads to decide the budget — the
		// next node entry would hand the model a fresh round of research.
		const persisted = (command as any).update.messages as BaseMessage[];
		expect(
			persisted.some((m) =>
				String(m.content).includes("[SYSTEM DIRECTIVE"),
			),
		).toBe(false);
	});

	it("does not inject the directive on a round still inside the budget", async () => {
		mockInvoke.mockResolvedValueOnce(writeResponse("call_pre_2"));

		await chatNode(stateWithRounds(MAX_TOOL_ITERATIONS - 1));

		const [sentMessages] = mockInvoke.mock.calls[0] as [BaseMessage[]];
		expect(
			sentMessages.some((m) =>
				String(m.content).includes("[SYSTEM DIRECTIVE"),
			),
		).toBe(false);
	});

	it("guard: rejects a research call made on the finalize turn and keeps the retry transcript out of state", async () => {
		mockInvoke.mockResolvedValueOnce(searchResponse("call_bad_1"));
		mockInvoke.mockResolvedValueOnce(writeResponse("call_good_1"));

		const command = await chatNode(stateWithRounds(MAX_TOOL_ITERATIONS));

		expect(mockInvoke).toHaveBeenCalledTimes(2);

		// The rejected call was answered with an error tool result and the
		// directive re-stated, all on the SAME request — the prefix is intact.
		const [retryMessages] = mockInvoke.mock.calls[1] as [BaseMessage[]];
		const errorResult = retryMessages.find(
			(m) => (m as ToolMessage).tool_call_id === "call_bad_1",
		) as ToolMessage | undefined;
		expect(errorResult).toBeDefined();
		expect(String(errorResult?.content)).toContain(
			"search_project_knowledge is no longer available",
		);
		expect(errorResult?.status).toBe("error");
		expect(
			String(retryMessages[retryMessages.length - 1].content),
		).toContain("[SYSTEM DIRECTIVE");

		// Only the accepted response is persisted.
		const persisted = (command as any).update.messages as BaseMessage[];
		expect(
			persisted.some((m) =>
				((m as AIMessage).tool_calls ?? []).some(
					(tc) => tc.id === "call_bad_1",
				),
			),
		).toBe(false);
		expect(
			persisted.some((m) =>
				((m as AIMessage).tool_calls ?? []).some(
					(tc) => tc.id === "call_good_1",
				),
			),
		).toBe(true);
	});

	it("guard: a mixed response answers every tool call, not just the disallowed one", async () => {
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "call_mixed_write",
						name: "write_document_local",
						args: { document: "# Draft" },
					},
					{
						id: "call_mixed_search",
						name: "search_project_knowledge",
						args: { query: "one more" },
					},
				],
			}),
		);
		mockInvoke.mockResolvedValueOnce(writeResponse("call_good_2"));

		await chatNode(stateWithRounds(MAX_TOOL_ITERATIONS));

		const [retryMessages] = mockInvoke.mock.calls[1] as [BaseMessage[]];
		// An AI tool_call left unanswered is a 400 on both wire shapes.
		for (const id of ["call_mixed_write", "call_mixed_search"]) {
			expect(
				retryMessages.some(
					(m) => (m as ToolMessage).tool_call_id === id,
				),
			).toBe(true);
		}
	});

	it("guard: falls back to inline-only tools plus the budget-exhausted system prompt when the model keeps disobeying", async () => {
		const bindTools = await getBindToolsSpy();

		mockInvoke.mockResolvedValueOnce(searchResponse("call_bad_a"));
		mockInvoke.mockResolvedValueOnce(searchResponse("call_bad_b"));
		mockInvoke.mockResolvedValueOnce(searchResponse("call_bad_c"));
		mockInvoke.mockResolvedValueOnce(writeResponse("call_fallback_ok"));

		const command = await chatNode(stateWithRounds(MAX_TOOL_ITERATIONS));

		// 1 initial + MAX_FINALIZE_GUARD_RETRIES (2) + 1 hard fallback.
		expect(mockInvoke).toHaveBeenCalledTimes(4);

		// The fallback rebinds the inline set — the research tools become
		// physically uncallable. This request misses the cache by design; it is
		// only reached when the model refused to finalize twice.
		const fallbackTools = boundToolNamesFromCall(
			bindTools.mock.calls[bindTools.mock.calls.length - 1],
		);
		expect(fallbackTools).toEqual(["write_document_local"]);

		const [fallbackMessages] = mockInvoke.mock.calls[3] as [BaseMessage[]];
		expect(String(fallbackMessages[0].content)).toContain(
			"Research Budget Exhausted",
		);

		// The fallback's response is the one that lands.
		const persisted = (command as any).update.messages as BaseMessage[];
		expect(
			persisted.some((m) =>
				((m as AIMessage).tool_calls ?? []).some(
					(tc) => tc.id === "call_fallback_ok",
				),
			),
		).toBe(true);
	});
	it("guard: strips a research call the terminal fallback returns anyway, so the run never ends on a dangling call", async () => {
		mockInvoke.mockResolvedValueOnce(searchResponse("call_bad_x"));
		mockInvoke.mockResolvedValueOnce(searchResponse("call_bad_y"));
		mockInvoke.mockResolvedValueOnce(searchResponse("call_bad_z"));
		// The fallback binds inline tools only, but a bound tool list is a
		// request to the provider, not a schema the response is validated
		// against — a gateway can still return a call to a tool never sent.
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "I still need to look one more thing up.",
				tool_calls: [
					{
						id: "call_hallucinated",
						name: "search_project_knowledge",
						args: { query: "again" },
					},
				],
				additional_kwargs: {
					tool_calls: [
						{
							id: "call_hallucinated",
							type: "function",
							function: {
								name: "search_project_knowledge",
								arguments: '{"query":"again"}',
							},
						},
					],
				},
			}),
		);

		const state = stateWithRounds(MAX_TOOL_ITERATIONS);
		const command = await chatNode(state);

		// Terminal: no fifth invoke, the fallback is the last word.
		expect(mockInvoke).toHaveBeenCalledTimes(4);

		const persisted = (command as any).update.messages as BaseMessage[];
		const lastMessage = persisted[persisted.length - 1] as AIMessage;

		// Nothing dangling — a persisted call to an unavailable tool is what
		// makes shouldContinue force __end__ with no document written. The
		// prior history keeps its own search calls: those are answered, and
		// rewriting them is the history reshaping this change removed.
		expect(lastMessage.tool_calls ?? []).toHaveLength(0);
		expect(
			(lastMessage.additional_kwargs as { tool_calls?: unknown })
				.tool_calls,
		).toBeUndefined();
		expect(
			persisted
				.slice(state.messages.length)
				.some((m) =>
					((m as AIMessage).tool_calls ?? []).some(
						(tc) => tc.name === "search_project_knowledge",
					),
				),
		).toBe(false);

		// The text the model did produce still stands.
		expect(String(lastMessage.content)).toContain("look one more thing up");
	});

	it("guard: skips the retry transcript entirely when a rejected call has no id", async () => {
		const bindTools = await getBindToolsSpy();

		// No `id` on the call: a rejection ToolMessage would have no
		// tool_call_id to address, which is a 400 before the fallback ever ran.
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [
					{
						name: "search_project_knowledge",
						args: { query: "no id here" },
					} as any,
				],
			}),
		);
		mockInvoke.mockResolvedValueOnce(writeResponse("call_after_idless"));

		const command = await chatNode(stateWithRounds(MAX_TOOL_ITERATIONS));

		// Straight to the fallback: 1 initial + 1 fallback, no retry rounds.
		expect(mockInvoke).toHaveBeenCalledTimes(2);
		const fallbackTools = boundToolNamesFromCall(
			bindTools.mock.calls[bindTools.mock.calls.length - 1],
		);
		expect(fallbackTools).toEqual(["write_document_local"]);

		// No rejection tool results were sent — that is the whole point.
		const [fallbackMessages] = mockInvoke.mock.calls[1] as [BaseMessage[]];
		expect(
			fallbackMessages.some((m) =>
				String(m.content).startsWith("Error: "),
			),
		).toBe(false);
		expect(String(fallbackMessages[0].content)).toContain(
			"Research Budget Exhausted",
		);

		const persisted = (command as any).update.messages as BaseMessage[];
		expect(
			persisted.some((m) =>
				((m as AIMessage).tool_calls ?? []).some(
					(tc) => tc.id === "call_after_idless",
				),
			),
		).toBe(true);
	});
	it("guard: detects a research call carried only in additional_kwargs.tool_calls", async () => {
		// LangChain's normalized `tool_calls` can be empty while the raw
		// OpenAI-shape copy holds the real call — the unified server recovers
		// calls from there, so detection that reads only the normalized view
		// would let this one through.
		const rawOnly = () =>
			new AIMessage({
				content: "",
				tool_calls: [],
				additional_kwargs: {
					tool_calls: [
						{
							id: "call_raw_only",
							type: "function",
							function: {
								name: "search_project_knowledge",
								arguments: '{"query":"raw"}',
							},
						},
					],
				},
			});

		mockInvoke.mockResolvedValueOnce(rawOnly());
		mockInvoke.mockResolvedValueOnce(writeResponse("call_after_raw"));

		const command = await chatNode(stateWithRounds(MAX_TOOL_ITERATIONS));

		// Nothing in `tool_calls` to answer with a ToolMessage, so the guard
		// skips the transcript retry: 1 initial + 1 fallback.
		expect(mockInvoke).toHaveBeenCalledTimes(2);
		const [fallbackMessages] = mockInvoke.mock.calls[1] as [BaseMessage[]];
		expect(String(fallbackMessages[0].content)).toContain(
			"Research Budget Exhausted",
		);

		const persisted = (command as any).update.messages as BaseMessage[];
		expect(
			persisted.some((m) =>
				((m as AIMessage).tool_calls ?? []).some(
					(tc) => tc.id === "call_after_raw",
				),
			),
		).toBe(true);
	});

	it("guard: detects and strips a research call carried only in a tool_use content block", async () => {
		// The Anthropic shape: the call lives in the content array. Leaving the
		// block behind resurrects the call the next time this message is replayed.
		const contentBlockOnly = () =>
			new AIMessage({
				content: [
					{ type: "text", text: "Let me check one more source." },
					{
						type: "tool_use",
						id: "call_block_only",
						name: "search_project_knowledge",
						input: { query: "block" },
					},
				] as unknown as MessageContentComplex[],
				tool_calls: [],
			});

		mockInvoke.mockResolvedValueOnce(contentBlockOnly());
		mockInvoke.mockResolvedValueOnce(contentBlockOnly());

		const command = await chatNode(stateWithRounds(MAX_TOOL_ITERATIONS));

		// Unaddressable by a tool result → straight to the fallback.
		expect(mockInvoke).toHaveBeenCalledTimes(2);

		const persisted = (command as any).update.messages as BaseMessage[];
		const lastMessage = persisted[persisted.length - 1] as AIMessage;
		const blocks = Array.isArray(lastMessage.content)
			? (lastMessage.content as Array<{ type: string }>)
			: [];
		expect(blocks.some((b) => b.type === "tool_use")).toBe(false);
		// The model's prose survives the strip.
		expect(blocks.some((b) => b.type === "text")).toBe(true);
	});

	it("guard: skips the retry transcript when a rejected call has a whitespace-only id", async () => {
		// A blank id is worse than a missing one: it looks present but addresses
		// nothing, so the tool result comes back a provider 400.
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "   ",
						name: "search_project_knowledge",
						args: { query: "blank id" },
					},
				],
			}),
		);
		mockInvoke.mockResolvedValueOnce(writeResponse("call_after_blank_id"));

		await chatNode(stateWithRounds(MAX_TOOL_ITERATIONS));

		expect(mockInvoke).toHaveBeenCalledTimes(2);
		const [fallbackMessages] = mockInvoke.mock.calls[1] as [BaseMessage[]];
		expect(
			fallbackMessages.some((m) =>
				String(m.content).startsWith("Error: "),
			),
		).toBe(false);
	});

	it("guard: ends with an explicit error when the fallback produced nothing but the stripped call", async () => {
		mockInvoke.mockResolvedValueOnce(searchResponse("call_bad_p"));
		mockInvoke.mockResolvedValueOnce(searchResponse("call_bad_q"));
		mockInvoke.mockResolvedValueOnce(searchResponse("call_bad_r"));
		// The fallback's only payload is the disallowed call — stripping it
		// leaves nothing at all.
		mockInvoke.mockResolvedValueOnce(searchResponse("call_bad_s"));

		const command = await chatNode(stateWithRounds(MAX_TOOL_ITERATIONS));
		const update = (command as any).update;

		expect(mockInvoke).toHaveBeenCalledTimes(4);

		// Not a silent success: without the explicit error the run would end on
		// the ordinary no-tool-call branch with error: undefined, reporting
		// success while the document was never written.
		expect(update.error).toBe(FINALIZE_GUARD_EMPTY_RESPONSE_USER_MESSAGE);
		expect(update.document).toBe("");
		const persisted = update.messages as BaseMessage[];
		expect(String(persisted[persisted.length - 1].content)).toBe(
			FINALIZE_GUARD_EMPTY_RESPONSE_USER_MESSAGE,
		);
		expect(
			persisted.some((m) =>
				((m as AIMessage).tool_calls ?? []).some(
					(tc) => tc.id === "call_bad_s",
				),
			),
		).toBe(false);
	});
	it("guard: strips a research call the truncation-recovery retry returns on a finalize turn", async () => {
		// The truncation retry (issue #2976) runs AFTER the guard and replaces
		// `response`, so its result never passed through the guard's checks. It
		// binds inline tools only — a request, not a schema.
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [],
				response_metadata: { finish_reason: "length" },
			}),
		);
		// The retry forces the input-budget gate, whose summarizer runs through
		// this same mocked model — so it consumes the second invoke.
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({ content: "compressed history summary" }),
		);
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "One more search first.",
				tool_calls: [
					{
						id: "call_trunc_bad",
						name: "search_project_knowledge",
						args: { query: "after truncation" },
					},
				],
			}),
		);

		const state = stateWithRounds(MAX_TOOL_ITERATIONS);
		const command = await chatNode(state);

		// 1 initial (empty+truncated) + 1 budget-gate summarizer + 1 retry.
		expect(mockInvoke).toHaveBeenCalledTimes(3);

		const persisted = (command as any).update.messages as BaseMessage[];
		expect(
			persisted
				.slice(state.messages.length)
				.some((m) =>
					((m as AIMessage).tool_calls ?? []).some(
						(tc) => tc.id === "call_trunc_bad",
					),
				),
		).toBe(false);
		// The retry's prose survives, so this is not the empty-response case.
		expect(String(persisted[persisted.length - 1].content)).toContain(
			"One more search first.",
		);
	});

	it("guard: ends with the explicit error when the truncation retry produced only a research call", async () => {
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [],
				response_metadata: { finish_reason: "length" },
			}),
		);
		// Budget-gate summarizer (see the previous test).
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({ content: "compressed history summary" }),
		);
		mockInvoke.mockResolvedValueOnce(searchResponse("call_trunc_only"));

		const command = await chatNode(stateWithRounds(MAX_TOOL_ITERATIONS));
		const update = (command as any).update;

		expect(mockInvoke).toHaveBeenCalledTimes(3);
		// Stripping leaves nothing: an explicit error, not a silent success and
		// not the truncation message (the retry did come back with output).
		expect(update.error).toBe(FINALIZE_GUARD_EMPTY_RESPONSE_USER_MESSAGE);
		expect(
			String(update.messages[update.messages.length - 1].content),
		).toBe(FINALIZE_GUARD_EMPTY_RESPONSE_USER_MESSAGE);
	});

	it("guard: skips the retry transcript when the raw lane carries an extra same-name call the normalized view omits", async () => {
		// Same NAME in both lanes, but two distinct call IDs raw-side. Matching
		// by name would pass the gate and answer only "a", leaving raw call "b"
		// unanswered on the replayed assistant message — a provider 400.
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "call_mirror_a",
						name: "search_project_knowledge",
						args: { query: "a" },
					},
				],
				additional_kwargs: {
					tool_calls: [
						{
							id: "call_mirror_a",
							type: "function",
							function: {
								name: "search_project_knowledge",
								arguments: '{"query":"a"}',
							},
						},
						{
							id: "call_mirror_b",
							type: "function",
							function: {
								name: "search_project_knowledge",
								arguments: '{"query":"b"}',
							},
						},
					],
				},
			}),
		);
		mockInvoke.mockResolvedValueOnce(writeResponse("call_after_mirror"));

		await chatNode(stateWithRounds(MAX_TOOL_ITERATIONS));

		// Straight to the fallback: 1 initial + 1 fallback, no transcript retry.
		expect(mockInvoke).toHaveBeenCalledTimes(2);
		const [fallbackMessages] = mockInvoke.mock.calls[1] as [BaseMessage[]];
		expect(
			fallbackMessages.some((m) =>
				String(m.content).startsWith("Error: "),
			),
		).toBe(false);
		expect(String(fallbackMessages[0].content)).toContain(
			"Research Budget Exhausted",
		);
	});

	it("guard: still takes the retry when both lanes mirror the SAME call", async () => {
		// The ordinary OpenAI shape: LangChain populates the normalized view and
		// keeps the raw copy. Identity matching must not mistake that for two
		// calls, or the transcript retry would never run at all.
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "call_same",
						name: "search_project_knowledge",
						args: { query: "mirrored" },
					},
				],
				additional_kwargs: {
					tool_calls: [
						{
							id: "call_same",
							type: "function",
							function: {
								name: "search_project_knowledge",
								arguments: '{"query":"mirrored"}',
							},
						},
					],
				},
			}),
		);
		mockInvoke.mockResolvedValueOnce(writeResponse("call_after_same"));

		await chatNode(stateWithRounds(MAX_TOOL_ITERATIONS));

		expect(mockInvoke).toHaveBeenCalledTimes(2);
		// The second call IS the transcript retry, not the fallback: it carries
		// the rejection tool result addressed to the mirrored id.
		const [retryMessages] = mockInvoke.mock.calls[1] as [BaseMessage[]];
		expect(
			retryMessages.some(
				(m) => (m as ToolMessage).tool_call_id === "call_same",
			),
		).toBe(true);
	});
});
