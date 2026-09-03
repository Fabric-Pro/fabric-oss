/**
 * Factory + module-scope export tests for CopilotAssistantMessage.
 *
 * PR 4/5 of the reasoning-surfacing spec. The factory pattern (Codex pass
 * #1 concern #9 fix) replaces per-callsite `useMemo` with pre-bound
 * module-scope component constants whose identity is guaranteed stable by
 * ES module evaluation semantics.
 *
 * These tests cover:
 *   1. Factory returns a React function component
 *   2. Factory with the same agentName returns DIFFERENT references across
 *      calls (each invocation is a fresh closure) — proves call sites MUST
 *      either use the module-scope exports or wrap in useMemo for dynamic
 *      agents (Q4 follow-up). Calling the factory inline on every render
 *      would create a new component on every render.
 *   3. displayName carries the agent name for debugging
 *   4. The 4 module-scope exports have the expected displayNames
 *   5. Rendering with mocked hooks: `useCoAgent` receives the correct
 *      agent name closed over from the factory
 */

import { render as rtlRender, screen } from "@testing-library/react";
import { CopilotChatSessionProvider } from "../CopilotChatSessionProvider";

// Every component under test reads its CopilotKit chat state from
// `<CopilotChatSessionProvider>` (one `useCopilotChatInternal()` per surface —
// see the provider's doc-comment and Fizzy #2389), so each render mounts the
// real provider over this file's mocked `useCopilotChatInternal`.
function render(ui: Parameters<typeof rtlRender>[0]) {
	return rtlRender(ui, { wrapper: CopilotChatSessionProvider });
}

import { describe, expect, it, vi } from "vitest";

const useCoAgentMock = vi.fn();
const useCopilotChatInternalMock = vi.fn();
const useChatContextMock = vi.fn();

vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: (args: { name: string }) => useCoAgentMock(args),
	useCopilotChatInternal: () => useCopilotChatInternalMock(),
}));

vi.mock("@copilotkit/react-ui", () => ({
	useChatContext: () => useChatContextMock(),
	Markdown: ({ content }: { content: string }) => (
		<div data-testid="markdown">{content}</div>
	),
}));

vi.mock("../../../../../components/ai-elements/McpAppFrame", () => ({
	McpAppFrame: () => <div data-testid="mcp-frame" />,
}));

vi.mock("../ReasoningCollapsible", () => ({
	ReasoningCollapsible: ({ text }: { text?: string }) => (
		<div data-testid="reasoning-collapsible">{text}</div>
	),
}));

// Import AFTER vi.mock so the component sees the stubbed hooks.
import {
	CopilotAssistantMessage,
	CopilotAssistantMessageForBacklogUpdater,
	CopilotAssistantMessageForDocumentGenerator,
	CopilotAssistantMessageForPromptEnhancer,
	CopilotAssistantMessageForStoryBreakdown,
	CopilotAssistantMessageForTaskPlanner,
	makeCopilotAssistantMessage,
} from "../CopilotAssistantMessage";

function setupHookDefaults() {
	useCoAgentMock.mockReturnValue({ state: {} });
	useCopilotChatInternalMock.mockReturnValue({ visibleMessages: [] });
	useChatContextMock.mockReturnValue({
		icons: {
			regenerateIcon: null,
			copyIcon: null,
			thumbsUpIcon: null,
			thumbsDownIcon: null,
			activityIcon: null,
		},
		labels: {
			regenerateResponse: "Regenerate",
			copyToClipboard: "Copy",
			thumbsUp: "Up",
			thumbsDown: "Down",
		},
	});
}

describe("makeCopilotAssistantMessage factory", () => {
	it("returns a React function component", () => {
		const Comp = makeCopilotAssistantMessage({ agentName: "test_agent" });
		expect(typeof Comp).toBe("function");
	});

	it("returns DIFFERENT component references across calls (even with same agentName)", () => {
		// This is the rationale for the module-scope exports — call sites
		// that invoke the factory inline on every render would remount the
		// chat subtree on every parent re-render. Document the actual
		// behavior: each call IS a fresh closure.
		const A = makeCopilotAssistantMessage({ agentName: "x" });
		const B = makeCopilotAssistantMessage({ agentName: "x" });
		expect(A).not.toBe(B);
	});

	it("sets displayName to CopilotAssistantMessage[<agentName>] for debugging", () => {
		const Comp = makeCopilotAssistantMessage({ agentName: "my_agent" });
		expect((Comp as { displayName?: string }).displayName).toBe(
			"CopilotAssistantMessage[my_agent]",
		);
	});

	it("defaults to agentName=project_document_generator when called with no args", () => {
		const Comp = makeCopilotAssistantMessage();
		expect((Comp as { displayName?: string }).displayName).toBe(
			"CopilotAssistantMessage[project_document_generator]",
		);
	});
});

describe("Module-scope exports — displayNames", () => {
	it("default CopilotAssistantMessage is bound to project_document_generator", () => {
		expect(
			(CopilotAssistantMessage as { displayName?: string }).displayName,
		).toBe("CopilotAssistantMessage[project_document_generator]");
	});

	it("CopilotAssistantMessageForBacklogUpdater is bound to backlog_updater", () => {
		expect(
			(
				CopilotAssistantMessageForBacklogUpdater as {
					displayName?: string;
				}
			).displayName,
		).toBe("CopilotAssistantMessage[backlog_updater]");
	});

	it("CopilotAssistantMessageForPromptEnhancer is bound to prompt_enhancer", () => {
		expect(
			(
				CopilotAssistantMessageForPromptEnhancer as {
					displayName?: string;
				}
			).displayName,
		).toBe("CopilotAssistantMessage[prompt_enhancer]");
	});

	it("CopilotAssistantMessageForTaskPlanner is bound to task_planner", () => {
		expect(
			(CopilotAssistantMessageForTaskPlanner as { displayName?: string })
				.displayName,
		).toBe("CopilotAssistantMessage[task_planner]");
	});

	it("CopilotAssistantMessageForDocumentGenerator is bound to document_generator", () => {
		expect(
			(
				CopilotAssistantMessageForDocumentGenerator as {
					displayName?: string;
				}
			).displayName,
		).toBe("CopilotAssistantMessage[document_generator]");
	});

	it("CopilotAssistantMessageForStoryBreakdown is bound to story_breakdown", () => {
		expect(
			(
				CopilotAssistantMessageForStoryBreakdown as {
					displayName?: string;
				}
			).displayName,
		).toBe("CopilotAssistantMessage[story_breakdown]");
	});
});

describe("Module-scope exports — runtime useCoAgent wiring", () => {
	it("the default export calls useCoAgent({name: 'project_document_generator'}) on render", () => {
		setupHookDefaults();
		useCoAgentMock.mockClear();
		render(
			<CopilotAssistantMessage
				message={
					{
						id: "m1",
						content: "hello",
					} as never
				}
				isLoading={false}
				isGenerating={false}
				isCurrentMessage={true}
				onRegenerate={() => undefined}
				onCopy={() => undefined}
			/>,
		);
		expect(useCoAgentMock).toHaveBeenCalledWith({
			name: "project_document_generator",
		});
		expect(screen.getByTestId("markdown").textContent).toBe("hello");
	});

	it("ForBacklogUpdater calls useCoAgent({name: 'backlog_updater'}) on render", () => {
		setupHookDefaults();
		useCoAgentMock.mockClear();
		render(
			<CopilotAssistantMessageForBacklogUpdater
				message={{ id: "m2", content: "hi" } as never}
				isLoading={false}
				isGenerating={false}
				isCurrentMessage={true}
				onRegenerate={() => undefined}
				onCopy={() => undefined}
			/>,
		);
		expect(useCoAgentMock).toHaveBeenCalledWith({
			name: "backlog_updater",
		});
	});

	it("ForPromptEnhancer calls useCoAgent({name: 'prompt_enhancer'}) on render", () => {
		setupHookDefaults();
		useCoAgentMock.mockClear();
		render(
			<CopilotAssistantMessageForPromptEnhancer
				message={{ id: "m3", content: "hi" } as never}
				isLoading={false}
				isGenerating={false}
				isCurrentMessage={true}
				onRegenerate={() => undefined}
				onCopy={() => undefined}
			/>,
		);
		expect(useCoAgentMock).toHaveBeenCalledWith({
			name: "prompt_enhancer",
		});
	});

	it("ForTaskPlanner calls useCoAgent({name: 'task_planner'}) on render", () => {
		setupHookDefaults();
		useCoAgentMock.mockClear();
		render(
			<CopilotAssistantMessageForTaskPlanner
				message={{ id: "m4", content: "hi" } as never}
				isLoading={false}
				isGenerating={false}
				isCurrentMessage={true}
				onRegenerate={() => undefined}
				onCopy={() => undefined}
			/>,
		);
		expect(useCoAgentMock).toHaveBeenCalledWith({ name: "task_planner" });
	});

	it("ForDocumentGenerator calls useCoAgent({name: 'document_generator'}) on render", () => {
		setupHookDefaults();
		useCoAgentMock.mockClear();
		render(
			<CopilotAssistantMessageForDocumentGenerator
				message={{ id: "m6", content: "hi" } as never}
				isLoading={false}
				isGenerating={false}
				isCurrentMessage={true}
				onRegenerate={() => undefined}
				onCopy={() => undefined}
			/>,
		);
		expect(useCoAgentMock).toHaveBeenCalledWith({
			name: "document_generator",
		});
	});

	it("ForStoryBreakdown calls useCoAgent({name: 'story_breakdown'}) on render", () => {
		setupHookDefaults();
		useCoAgentMock.mockClear();
		render(
			<CopilotAssistantMessageForStoryBreakdown
				message={{ id: "m7", content: "hi" } as never}
				isLoading={false}
				isGenerating={false}
				isCurrentMessage={true}
				onRegenerate={() => undefined}
				onCopy={() => undefined}
			/>,
		);
		expect(useCoAgentMock).toHaveBeenCalledWith({
			name: "story_breakdown",
		});
	});

	it("renders ReasoningCollapsible with the reasoning text from agentState.reasoningByTurn[1]", () => {
		setupHookDefaults();
		useCoAgentMock.mockReturnValueOnce({
			state: {
				reasoningByTurn: {
					1: { text: "Thinking step 1…", durationMs: 1000 },
				},
			},
		});
		// Supply visibleMessages so turnIndex resolves to 1 (one user message
		// preceding the assistant message m5).
		useCopilotChatInternalMock.mockReturnValueOnce({
			visibleMessages: [
				{ role: "user", id: "u1" },
				{ role: "assistant", id: "m5" },
			],
		});
		render(
			<CopilotAssistantMessageForBacklogUpdater
				message={{ id: "m5", content: "answer" } as never}
				isLoading={false}
				isGenerating={false}
				isCurrentMessage={true}
				onRegenerate={() => undefined}
				onCopy={() => undefined}
			/>,
		);
		expect(screen.getByTestId("reasoning-collapsible").textContent).toBe(
			"Thinking step 1…",
		);
	});
});
