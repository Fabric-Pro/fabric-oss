/**
 * Message rows re-render only for their own message (Fizzy #2430, review F30).
 *
 * Every streamed token replaces the chat's `messages` array and re-renders
 * the component; each earlier row used to render again with it. Rows are now
 * memoized on their message and the shared state they read, so a token
 * re-renders the streaming row alone.
 *
 * Mounted with the same thin harness as the conversation-switch test.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture every render of the button so the test can assert on its
// props. We re-export a vi.fn from the mock and read it back below.
const insertDiagramButtonMock = vi.fn();
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/ChatMessageInsertDiagramButton",
	() => ({
		ChatMessageInsertDiagramButton: (props: Record<string, unknown>) => {
			insertDiagramButtonMock(props);
			return (
				<div
					data-testid="chat-message-insert-diagram-button"
					data-surface={props.surface as string}
					data-message-id={props.chatMessageId as string}
				/>
			);
		},
	}),
);

// Capture McpAppFrame props for negative-path assertion (the button must
// NOT render when McpAppFrame is for a non-Excalidraw resource).
const mcpAppFrameMock = vi.fn();
vi.mock("@/components/ai-elements/McpAppFrame", () => ({
	McpAppFrame: (props: Record<string, unknown>) => {
		mcpAppFrameMock(props);
		return (
			<div
				data-testid="mcp-app-frame"
				data-resource-uri={props.resourceUri as string}
			/>
		);
	},
}));

// ---------------------------------------------------------------------------
// Launcher / org / resolver hook stubs.
// ---------------------------------------------------------------------------

const launchContextMock = {
	projectId: "proj_feature_1",
	storyId: "story_F-007",
	storyIdentifier: "F-007",
	storyTitle: "Login flow",
	prompt: "Sketch the auth state machine",
};

vi.mock("@saas/agents/components/FabricAgentLauncher", () => ({
	useFabricAgentLauncher: () => ({
		applyToDocument: null,
		launchContext: launchContextMock,
		isOpen: false,
		openLauncher: vi.fn(),
		closeLauncher: vi.fn(),
		clearContext: vi.fn(),
		registerAmbientContext: vi.fn(() => () => {}),
		registerDocumentEditor: vi.fn(() => () => {}),
	}),
	// `useRegisterFabricAgentContext` is referenced indirectly by other
	// FabricDirectChat siblings — provide a passthrough no-op so the
	// module import resolves.
	useRegisterFabricAgentContext: vi.fn(),
	FabricAgentLauncherProvider: ({
		children,
	}: {
		children: React.ReactNode;
	}) => children,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org_example",
		organizationSlug: "example-org",
		organizationName: "Example Organization",
		basePath: "/app/example-org",
		isOrgContext: true,
		isPersonalContext: false,
		isOrganizationAdmin: true,
		userRole: "admin",
		loaded: true,
		organization: { id: "org_example", slug: "example-org" },
	}),
}));

// The resolver returns a stable target so the button branch picks the
// "active" path. We swap the editor for a JSDOM-safe stub so any
// downstream ProseMirror touches inside the (mocked) button don't trip.
const fakeEditor = {
	on: vi.fn(),
	off: vi.fn(),
} as unknown as Editor;

const resolverTargetMock = {
	kind: "story" as const,
	editor: fakeEditor,
	projectId: "proj_feature_1",
	documentLabel: "F-007 Login flow",
	storyId: "story_F-007",
};

vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/useActiveTipTapEditor",
	() => ({
		useActiveTipTapEditor: vi.fn(() => resolverTargetMock),
	}),
);

// Stable, as the real hook's memoized scope is.
const chatScope = vi.hoisted(() => ({
	projectId: "proj_feature_1",
	organizationId: null,
	lastUserPromptForMessage: (_id: string) => "Sketch the auth state machine",
}));
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/useChatScopedProject",
	() => ({
		useChatScopedProjectFromLauncher: () => chatScope,
	}),
);

// `deriveDiagramTitle` is a pure util — passthrough to verify the
// FabricDirectChat call site forwards the launcher prompt correctly.
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/deriveDiagramTitle",
	() => ({
		deriveDiagramTitle: (input: { userPromptText?: string | null }) =>
			(input.userPromptText ?? "Untitled diagram from chat").slice(0, 60),
	}),
);

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: "user_1", name: "Test User", email: "test@example.com" },
	}),
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

const createConversationMock = vi.fn();
const addMessageMock = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			diagrams: { createFromChat: vi.fn() },
			conversations: { attach: vi.fn() },
		},
		agents: {
			conversations: {
				create: (...args: unknown[]) => createConversationMock(...args),
				addMessage: (...args: unknown[]) => addMessageMock(...args),
				update: vi.fn(),
			},
		},
		users: {
			chatAgentSelection: {
				get: vi.fn(async () => null),
				set: vi.fn(async () => null),
			},
		},
	},
}));

// A stateful stand-in for `useDirectStream`: `reset` really clears the
// stream, so the render after a conversation switch shows what the
// component loaded rather than the mock's fixed array.
const hookState: {
	messages: Array<Record<string, unknown>>;
	isLoading: boolean;
} = { messages: [], isLoading: false };
const resetMock = vi.fn(() => {
	hookState.messages = [];
	hookState.isLoading = false;
});
const stopMock = vi.fn(() => {
	hookState.isLoading = false;
});

vi.mock("@saas/agents/hooks/useDirectStream", () => ({
	useDirectStream: () => ({
		messages: hookState.messages,
		isLoading: hookState.isLoading,
		sendMessage: vi.fn(),
		reset: resetMock,
		stop: stopMock,
		restoreContextUsage: vi.fn(),
		contextInfo: { usage: null, maxTokens: 200_000 },
	}),
}));

vi.mock("@saas/agents/hooks/useEscToStopOrClose", () => ({
	useEscToStopOrClose: vi.fn(),
}));

vi.mock("@saas/agents/hooks/useSkillSlashCommand", () => ({
	useSkillSlashCommand: () => ({
		isOpen: false,
		query: "",
		results: [],
		isLoading: false,
		selectedIndex: 0,
		open: vi.fn(),
		close: vi.fn(),
		selectSkill: vi.fn(),
		setSelectedIndex: vi.fn(),
		handleKeyDown: vi.fn(() => false),
	}),
}));

vi.mock("@saas/agents/hooks/useSkillSuggestions", () => ({
	useSkillSuggestions: () => ({
		suggestions: [],
		isLoading: false,
		clear: vi.fn(),
	}),
}));

vi.mock("@saas/agents/hooks/useToolSuggestions", () => ({
	useToolSuggestions: () => ({
		suggestions: [],
		isLoading: false,
	}),
}));

vi.mock("@saas/agents/lib/derive-trajectory", () => ({
	deriveTrajectorySteps: () => [],
}));

vi.mock("@saas/agents/lib/tool-call-status", () => ({
	persistedToToolCallStatus: (s: string) => s,
	toolCallToPersistedStatus: (s: string) => s,
}));

vi.mock("@saas/agents/lib/direct-chat-tools", () => ({
	getSelectedConversationToolIds: () => [],
	mergeDirectConversationMetadata: (m: unknown) => m,
}));

vi.mock("@saas/agents/lib/code-references", () => ({
	buildComprehensiveFileContext: () => "",
	deduplicateCodeReferences: (r: unknown[]) => r,
	extractCodeReferences: () => [],
	formatCodeReference: () => "",
	hasCodeReferences: () => false,
	identifyRelatedFiles: () => [],
}));

vi.mock("@saas/agents/components/FabricChat/ConversationToolPicker", () => ({
	ConversationToolPicker: () => null,
}));

vi.mock("@saas/agents/components/FabricChat/shared", () => ({
	ActiveContextIndicator: () => null,
	AgentModelPicker: () => null,
	ChatInput: () => null,
	ChatWelcome: () => null,
	getLatestSuccessfulFrameFromGroups: () => null,
	InteractiveContentPanel: () => null,
	ToolCallList: () => null,
	useTypewriterPlaceholder: () => "",
}));

vi.mock("@saas/agents/components/FabricChat/shared/SkillAutocomplete", () => ({
	SkillAutocomplete: () => null,
}));

vi.mock(
	"@saas/agents/components/FabricChat/shared/SkillSuggestionChips",
	() => ({
		SkillSuggestionChips: () => null,
	}),
);

vi.mock("@saas/agents/components/FabricChat/TrajectorySteps", () => ({
	TrajectorySteps: () => null,
}));

// The shared ai-elements that the .map block sits between are not
// part of the F3 contract — replace them with passthroughs so the
// render reaches the `.map((tc) => ...)` branch.
vi.mock("@/components/ai-elements/checkpoint", () => ({
	CheckpointCreateButton: () => null,
	CheckpointHistory: () => null,
	CheckpointProvider: ({ children }: { children: React.ReactNode }) =>
		children,
	createCheckpoint: vi.fn(),
}));

vi.mock("@/components/ai-elements/confirmation", () => ({
	Confirmation: () => null,
	ConfirmationAction: () => null,
	ConfirmationActions: () => null,
	ConfirmationDescription: () => null,
	ConfirmationIcon: () => null,
	ConfirmationRequest: () => null,
	ConfirmationTitle: () => null,
}));

vi.mock("@/components/ai-elements/conversation", () => ({
	Conversation: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	ConversationContent: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	ConversationScrollButton: () => null,
}));

vi.mock("@/components/ai-elements/message", () => ({
	Message: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	MessageAvatar: () => null,
	MessageContent: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
}));

// Every render of a message body is recorded, so the test can tell which
// rows rendered again when the last one streamed a token.
const responseRenders = vi.hoisted(() => [] as string[]);
vi.mock("@/components/ai-elements/response", () => ({
	Response: ({ children }: { children: React.ReactNode }) => {
		responseRenders.push(String(children));
		return <div>{children}</div>;
	},
}));

vi.mock("@/components/ai-elements/sources", () => ({
	Sources: () => null,
}));

vi.mock("@saas/agents/components/StoppedIndicator", () => ({
	StoppedIndicator: () => null,
}));

vi.mock("@saas/shared/components/FabricLogo", () => ({
	FabricLogo: () => null,
}));

// JSDOM doesn't implement ResizeObserver; Radix primitives need it.
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
	ResizeObserverStub;

const { FabricDirectChat } = await import("../FabricDirectChat");

function ui(attachedProjectId: string | null = null) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={queryClient}>
			<FabricDirectChat
				organizationId="org_example"
				reasoningMode="balanced"
				activeConversationId={null}
				activeConversation={null}
				attachedProjectId={attachedProjectId}
				compactMode={false}
			/>
		</QueryClientProvider>
	);
}

const settled = [
	{
		id: "u1",
		role: "user",
		content: "first question",
		timestamp: new Date(0),
	},
	{
		id: "a1",
		role: "assistant",
		content: "first answer",
		timestamp: new Date(0),
		streamStatus: "completed",
	},
	{
		id: "u2",
		role: "user",
		content: "second question",
		timestamp: new Date(0),
	},
];

function streaming(content: string) {
	return {
		id: "a2",
		role: "assistant",
		content,
		timestamp: new Date(0),
		isStreaming: true,
		streamStatus: "streaming",
	};
}

function rendersOf(content: string) {
	return responseRenders.filter((text) => text === content).length;
}

beforeEach(() => {
	responseRenders.length = 0;
	hookState.messages = [];
	hookState.isLoading = false;
});

describe("FabricDirectChat — streaming render cost", () => {
	it("re-renders only the streaming message when a token arrives", () => {
		hookState.isLoading = true;
		hookState.messages = [...settled, streaming("Part")];
		const view = render(ui());
		expect(rendersOf("first answer")).toBe(1);
		expect(rendersOf("Part")).toBe(1);

		hookState.messages = [...settled, streaming("Partial")];
		view.rerender(ui());
		hookState.messages = [...settled, streaming("Partial answer")];
		view.rerender(ui());

		expect(rendersOf("first answer")).toBe(1);
		expect(rendersOf("first question")).toBe(1);
		expect(rendersOf("Partial answer")).toBe(1);
		expect(view.container.textContent).toContain("Partial answer");
	});

	it("re-renders every row when state they all read changes", () => {
		hookState.isLoading = true;
		hookState.messages = [...settled, streaming("Part")];
		const view = render(ui());

		hookState.isLoading = false;
		hookState.messages = [
			...settled,
			{ ...streaming("Part done"), isStreaming: false },
		];
		view.rerender(ui());

		expect(rendersOf("first answer")).toBe(2);
	});

	it("rebuilds an earlier answer's action cards when the project changes", () => {
		hookState.messages = [...settled];
		const view = render(ui());
		expect(view.container.textContent).not.toContain(
			"Suggested next actions",
		);

		view.rerender(ui("proj_1"));

		expect(view.container.textContent).toContain("Suggested next actions");
	});
});
