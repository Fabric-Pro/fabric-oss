/**
 * Tests for the Excalidraw chat -> editor auto-insert button wiring
 * inside `CopilotAssistantMessage` (F4 / spec § 8.1 row 4).
 *
 * Coverage:
 *   - Button renders only when the inline-MCP envelope's resource URI
 *     contains "excalidraw" (FR-2 happy-path render gate).
 *   - Button does NOT render when the envelope is non-Excalidraw.
 *   - Button does NOT render when the assistant bubble has no envelope.
 *   - Resolver returns the same-page editor that's been registered in
 *     the TiptapEditorRegistry (spec § 9 step 2). The button receives
 *     that target via props.
 *   - Button receives the correct `surface="in-document"` + chatMessageId
 *     + organizationSlug + chatScope wiring (FR-2 happy-path inputs).
 *
 * The `ChatMessageInsertDiagramButton` itself is unit-tested under
 * `apps/web/modules/saas/projects/components/excalidraw-auto-insert/__tests__/`
 * — here we only verify the wiring at the CopilotAssistantMessage seam.
 * The button is stubbed via `vi.mock` to capture its props.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: vi.fn(),
	useCopilotChat: vi.fn(),
}));

vi.mock("@copilotkit/react-ui", () => ({
	Markdown: ({ content }: { content: string }) => (
		<div data-testid="markdown">{content}</div>
	),
	useChatContext: () => ({
		icons: {
			regenerateIcon: <span />,
			copyIcon: <span />,
			thumbsUpIcon: <span />,
			thumbsDownIcon: <span />,
			activityIcon: <span />,
		},
		labels: {
			regenerateResponse: "Regenerate",
			copyToClipboard: "Copy",
			thumbsUp: "Like",
			thumbsDown: "Dislike",
		},
	}),
}));

vi.mock("../ReasoningCollapsible", () => ({
	ReasoningCollapsible: () => <div data-testid="reasoning-collapsible" />,
}));

// `McpAppFrame` is rendered as a sibling above the auto-insert button —
// stub it so the tests focus on the button-wiring assertions.
//
// Note on relative paths: this test file sits in `__tests__/`, one level
// deeper than `CopilotAssistantMessage.tsx`, so every `vi.mock` path
// needs ONE EXTRA `../` compared with the import path written in the
// source file. The sibling `CopilotAssistantMessage.test.tsx` uses the
// same depth as the source (5 `../` instead of 6) but that's a silent
// mismatch — none of its scenarios trigger `<McpAppFrame>` or the
// other re-mocked modules, so the wrong path is a dead mock and the
// production module loads instead. Our tests DO exercise those paths,
// so the path counts must match the test file's location.
vi.mock("../../../../../../components/ai-elements/McpAppFrame", () => ({
	McpAppFrame: (props: { resourceUri: string }) => (
		<div data-testid="mcp-frame" data-resource-uri={props.resourceUri} />
	),
}));

// The outcomes provider returns `null` on surfaces without the provider
// (this matches production behavior for our test setup).
vi.mock(
	"../../../../projects/components/copilot/DocumentAssistantOutcomesProvider",
	() => ({
		useDocumentAssistantOutcomes: () => null,
	}),
);

vi.mock("../../../../projects/components/copilot/DiffOutcomeChip", () => ({
	DiffOutcomeChip: () => null,
}));

// `useParams` is the new hook this PR adds. The global vitest mock for
// `next/navigation` (vitest.setup.ts:16) doesn't expose `useParams`, so
// we extend it here with a controllable stub.
const useParamsMock = vi.fn();
vi.mock("next/navigation", () => ({
	useParams: () => useParamsMock(),
	useRouter: () => ({
		push: vi.fn(),
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
	usePathname: () => "/",
	useSearchParams: () => new URLSearchParams(),
}));

// `useOrganizationId` resolves the active org -- mock to return a
// stable id in org scope.
const useOrganizationIdMock = vi.fn();
vi.mock("../../../../organizations/hooks/use-organization-context", () => ({
	useOrganizationId: () => useOrganizationIdMock(),
}));

// Mock the chat-scope adapter so we can assert the wired projectId /
// organizationId pair the slot derives from URL + active-org.
const chatScopeMock = {
	projectId: "proj_route",
	organizationId: "org_active",
	lastUserPromptForMessage: vi.fn((_id: string) => "Draw a system diagram"),
};
const useChatScopedProjectFromCopilotChatMock = vi.fn(() => chatScopeMock);
vi.mock(
	"../../../../projects/components/excalidraw-auto-insert/useChatScopedProject",
	() => ({
		useChatScopedProjectFromCopilotChat: (opts: Record<string, unknown>) =>
			useChatScopedProjectFromCopilotChatMock(opts),
	}),
);

// Mock the active-editor resolver so we can pin its return value per
// test (verifies the slot passes the resolved target through).
const resolverTargetMock: {
	value: {
		kind: string;
		projectId: string;
		documentLabel: string;
		documentId?: string;
		storyId?: string;
		editor: object;
	} | null;
} = { value: null };
vi.mock(
	"../../../../projects/components/excalidraw-auto-insert/useActiveTipTapEditor",
	() => ({
		useActiveTipTapEditor: () => resolverTargetMock.value,
	}),
);

// Stub `deriveDiagramTitle` so we can assert the title flows through
// without re-testing the pure utility.
vi.mock(
	"../../../../projects/components/excalidraw-auto-insert/deriveDiagramTitle",
	() => ({
		deriveDiagramTitle: ({
			userPromptText,
		}: {
			userPromptText: string | null | undefined;
		}) =>
			userPromptText && userPromptText.length > 0
				? `title:${userPromptText}`
				: "title:fallback",
	}),
);

// The button itself is unit-tested separately -- here we replace it
// with a probe that records every prop call so the test can assert
// surface, chatMessageId, resolverTarget, etc.
const buttonProps: Array<Record<string, unknown>> = [];
vi.mock(
	"../../../../projects/components/excalidraw-auto-insert/ChatMessageInsertDiagramButton",
	() => ({
		ChatMessageInsertDiagramButton: (props: Record<string, unknown>) => {
			buttonProps.push(props);
			const surface = props.surface as string;
			const chatMessageId = props.chatMessageId as string;
			return (
				<div
					data-testid="excalidraw-auto-insert-button"
					data-surface={surface}
					data-message-id={chatMessageId}
				/>
			);
		},
	}),
);

import { useCoAgent, useCopilotChat } from "@copilotkit/react-core";
import { CopilotAssistantMessage } from "../CopilotAssistantMessage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envelopeJson(env: {
	resourceUri: string;
	configId: string;
	checkpointId?: string;
	toolArgs?: Record<string, unknown>;
}): string {
	return JSON.stringify({ __fabricMcpRender: env });
}

const baseProps = {
	message: { id: "a1", content: "Assistant reply" } as unknown,
	isLoading: false,
	isGenerating: false,
	isCurrentMessage: true,
	onRegenerate: () => {},
	onCopy: () => {},
	onThumbsUp: () => {},
	onThumbsDown: () => {},
	markdownTagRenderers: {},
};

beforeEach(() => {
	buttonProps.length = 0;
	useParamsMock.mockReset();
	useParamsMock.mockReturnValue({
		id: "proj_route",
		organizationSlug: "example-org",
	});
	useOrganizationIdMock.mockReset();
	useOrganizationIdMock.mockReturnValue("org_active");
	useChatScopedProjectFromCopilotChatMock.mockClear();
	useChatScopedProjectFromCopilotChatMock.mockImplementation(
		() => chatScopeMock,
	);
	chatScopeMock.lastUserPromptForMessage = vi.fn(
		(_id: string) => "Draw a system diagram",
	);
	resolverTargetMock.value = null;
	(useCoAgent as unknown as ReturnType<typeof vi.fn>).mockReset();
	(useCoAgent as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
		state: {},
	});
	(useCopilotChat as unknown as ReturnType<typeof vi.fn>).mockReset();
});

// ---------------------------------------------------------------------------
// Render-gate tests
// ---------------------------------------------------------------------------

describe("CopilotAssistantMessage -- Excalidraw auto-insert button render gate", () => {
	it("renders the button when the envelope's resourceUri contains 'excalidraw'", () => {
		(useCopilotChat as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
			{
				visibleMessages: [
					{
						id: "u1",
						role: "user",
						content: "Draw a system diagram",
					},
					{
						id: "r1",
						type: "ResultMessage",
						role: "tool",
						result: envelopeJson({
							resourceUri: "ui://excalidraw/scene-1",
							configId: "cfg_excalidraw",
							checkpointId: "cp_xyz",
							toolArgs: {
								elements: [{ type: "rect" }],
								appState: {},
							},
						}),
					},
					{
						id: "a1",
						role: "assistant",
						content: "Here's the diagram.",
					},
				],
			},
		);

		render(<CopilotAssistantMessage {...baseProps} />);

		expect(
			screen.getByTestId("excalidraw-auto-insert-button"),
		).toBeInTheDocument();
		expect(
			screen.getByTestId("excalidraw-auto-insert-button"),
		).toHaveAttribute("data-surface", "in-document");
		expect(
			screen.getByTestId("excalidraw-auto-insert-button"),
		).toHaveAttribute("data-message-id", "a1");
	});

	it("does NOT render the button when the envelope's resourceUri is non-Excalidraw", () => {
		(useCopilotChat as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
			{
				visibleMessages: [
					{ id: "u1", role: "user", content: "Search the docs" },
					{
						id: "r1",
						type: "ResultMessage",
						role: "tool",
						result: envelopeJson({
							resourceUri: "ui://mermaid/abc",
							configId: "cfg_mermaid",
							checkpointId: "cp_xyz",
						}),
					},
					{
						id: "a1",
						role: "assistant",
						content: "Here are the docs.",
					},
				],
			},
		);

		render(<CopilotAssistantMessage {...baseProps} />);

		// `McpAppFrame` still renders for the non-Excalidraw envelope --
		// only the auto-insert button is gated to Excalidraw.
		expect(screen.getByTestId("mcp-frame")).toBeInTheDocument();
		expect(
			screen.queryByTestId("excalidraw-auto-insert-button"),
		).not.toBeInTheDocument();
	});

	it("does NOT render the button when there is no inline-MCP envelope", () => {
		(useCopilotChat as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
			{
				visibleMessages: [
					{ id: "u1", role: "user", content: "Plain question" },
					{ id: "a1", role: "assistant", content: "Plain answer." },
				],
			},
		);

		render(<CopilotAssistantMessage {...baseProps} />);

		expect(screen.queryByTestId("mcp-frame")).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("excalidraw-auto-insert-button"),
		).not.toBeInTheDocument();
	});
});

// ---------------------------------------------------------------------------
// Resolver / wiring assertions
// ---------------------------------------------------------------------------

describe("CopilotAssistantMessage -- Excalidraw auto-insert wiring", () => {
	it("passes the same-page editor returned by the resolver (FR-2 happy path) through to the button", () => {
		// Resolver returns the editor registered on the page.
		const samePageEditor = { commands: {}, state: {} };
		resolverTargetMock.value = {
			kind: "document",
			projectId: "proj_route",
			documentLabel: "Architecture",
			documentId: "doc_1",
			editor: samePageEditor,
		};

		(useCopilotChat as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
			{
				visibleMessages: [
					{ id: "u1", role: "user", content: "Draw it" },
					{
						id: "r1",
						type: "ResultMessage",
						role: "tool",
						result: envelopeJson({
							resourceUri: "ui://excalidraw/scene-1",
							configId: "cfg_excalidraw",
							checkpointId: "cp_xyz",
							toolArgs: { elements: [{ type: "rect" }] },
						}),
					},
					{ id: "a1", role: "assistant", content: "Here it is." },
				],
			},
		);

		render(<CopilotAssistantMessage {...baseProps} />);

		expect(
			screen.getByTestId("excalidraw-auto-insert-button"),
		).toBeInTheDocument();
		expect(buttonProps).toHaveLength(1);
		const props = buttonProps[0];
		if (!props) {
			throw new Error("buttonProps[0] missing");
		}
		expect(props.surface).toBe("in-document");
		expect(props.chatMessageId).toBe("a1");
		expect(props.resolverTarget).toEqual(resolverTargetMock.value);
		expect(props.organizationSlug).toBe("example-org");
		expect(props.chatScope).toBe(chatScopeMock);
		// Tool-result fields flow through verbatim (FR-2 happy path).
		const tr = props.toolResult as Record<string, unknown>;
		expect(tr.resourceUri).toBe("ui://excalidraw/scene-1");
		expect(tr.checkpointId).toBe("cp_xyz");
		expect(tr.mcpConfigId).toBe("cfg_excalidraw");
		expect(tr.elements).toEqual([{ type: "rect" }]);
	});

	it("wires the chat-scope adapter with route projectId + active organizationId", () => {
		(useCopilotChat as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
			{
				visibleMessages: [
					{ id: "u1", role: "user", content: "Draw it" },
					{
						id: "r1",
						type: "ResultMessage",
						role: "tool",
						result: envelopeJson({
							resourceUri: "ui://excalidraw/scene-1",
							configId: "cfg_excalidraw",
							checkpointId: "cp_xyz",
						}),
					},
					{ id: "a1", role: "assistant", content: "Here it is." },
				],
			},
		);

		render(<CopilotAssistantMessage {...baseProps} />);

		expect(useChatScopedProjectFromCopilotChatMock).toHaveBeenCalledTimes(
			1,
		);
		const arg = useChatScopedProjectFromCopilotChatMock.mock
			.calls[0]?.[0] as Record<string, unknown>;
		expect(arg.projectId).toBe("proj_route");
		expect(arg.organizationId).toBe("org_active");
		// `visibleMessages` is forwarded so the adapter can walk the chat
		// for the most recent user prompt.
		expect(Array.isArray(arg.visibleMessages)).toBe(true);
	});

	it("derives the title from the chat-scope's lastUserPromptForMessage lookup", () => {
		chatScopeMock.lastUserPromptForMessage = vi.fn(
			(_id: string) => "Sketch a sequence diagram for the login flow",
		);

		(useCopilotChat as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
			{
				visibleMessages: [
					{
						id: "u1",
						role: "user",
						content: "Sketch a sequence diagram for the login flow",
					},
					{
						id: "r1",
						type: "ResultMessage",
						role: "tool",
						result: envelopeJson({
							resourceUri: "ui://excalidraw/scene-1",
							configId: "cfg_excalidraw",
							checkpointId: "cp_xyz",
						}),
					},
					{ id: "a1", role: "assistant", content: "Here it is." },
				],
			},
		);

		render(<CopilotAssistantMessage {...baseProps} />);

		expect(buttonProps[0]?.title).toBe(
			"title:Sketch a sequence diagram for the login flow",
		);
	});
});
