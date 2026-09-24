/**
 * Opening another conversation from History while the Direct chat has turns
 * in this mount (Fizzy #2040, review F27).
 *
 * The load effect skipped any reload while stream messages existed — a guard
 * meant for the chat's own create being written back into the URL. It also
 * swallowed a real switch: conversation A stayed on screen while saves and
 * the next send went to B. A turn still streaming when the user switched was
 * appended to B.
 *
 * Mounted with the same thin harness as the Excalidraw button test.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
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

vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/useChatScopedProject",
	() => ({
		useChatScopedProjectFromLauncher: () => ({
			projectId: "proj_feature_1",
			organizationId: null,
			lastUserPromptForMessage: (_id: string) =>
				"Sketch the auth state machine",
		}),
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

// ---------------------------------------------------------------------------
// FabricDirectChat sibling-hook stubs. These have to exist because
// `FabricDirectChat`'s body wires them up unconditionally; we keep the
// stub surface tiny — just enough that the messages list reaches the
// .map block we care about.
// ---------------------------------------------------------------------------

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

vi.mock("@/components/ai-elements/response", () => ({
	Response: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
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

function conversation(id: string, texts: Array<[string, string]>) {
	return {
		id,
		title: id,
		metadata: null,
		messages: texts.map(([role, content], index) => ({
			id: `${id}-m${index}`,
			role: role as "user" | "assistant",
			content,
			timestamp: "2026-09-01T00:00:00.000Z",
		})),
	};
}

const convA = conversation("conv_A", [
	["user", "first question in A"],
	["assistant", "first answer in A"],
]);
const convB = conversation("conv_B", [
	["user", "question from B"],
	["assistant", "answer from B"],
]);

function harness() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const onConversationCreated = vi.fn();
	const ui = (
		activeConversationId: string | null,
		activeConversation: ReturnType<typeof conversation> | null,
	) => (
		<QueryClientProvider client={queryClient}>
			<FabricDirectChat
				organizationId="org_example"
				reasoningMode="balanced"
				activeConversationId={activeConversationId}
				activeConversation={activeConversation as never}
				onConversationCreated={onConversationCreated}
				compactMode={false}
			/>
		</QueryClientProvider>
	);
	return { ui, onConversationCreated };
}

/** A turn sent in this mount, on top of conversation A's history. */
function streamTurnInA(options: { streaming: boolean }) {
	hookState.messages = [
		...convA.messages.map((m) => ({ ...m, timestamp: new Date(0) })),
		{
			id: "live-user",
			role: "user",
			content: "hello",
			timestamp: new Date(0),
		},
		{
			id: "live-assistant",
			role: "assistant",
			content: "partial reply in A",
			timestamp: new Date(0),
			isStreaming: options.streaming,
			streamStatus: options.streaming ? "streaming" : "completed",
		},
	];
	hookState.isLoading = options.streaming;
}

beforeEach(() => {
	hookState.messages = [];
	hookState.isLoading = false;
	resetMock.mockClear();
	stopMock.mockClear();
	createConversationMock.mockReset();
	addMessageMock.mockReset();
	addMessageMock.mockResolvedValue({});
});

describe("FabricDirectChat — switching conversation from History", () => {
	it("replaces the thread on screen with the selected conversation", async () => {
		const { ui } = harness();
		const view = render(ui("conv_A", convA));
		streamTurnInA({ streaming: false });
		view.rerender(ui("conv_A", convA));
		expect(view.container.textContent).toContain("hello");

		view.rerender(ui("conv_B", convB));

		await waitFor(() => {
			expect(view.container.textContent).toContain("answer from B");
		});
		expect(view.container.textContent).not.toContain("hello");
		expect(resetMock).toHaveBeenCalled();
		expect(stopMock).not.toHaveBeenCalled();
	});

	it("stops a turn still streaming and saves it into ITS conversation, never the new one", async () => {
		const { ui } = harness();
		const view = render(ui("conv_A", convA));
		streamTurnInA({ streaming: true });
		view.rerender(ui("conv_A", convA));

		view.rerender(ui("conv_B", convB));

		expect(stopMock).toHaveBeenCalled();
		await waitFor(() => {
			expect(addMessageMock).toHaveBeenCalled();
		});
		const targets = addMessageMock.mock.calls.map(
			(call) => (call[0] as { conversationId: string }).conversationId,
		);
		expect(new Set(targets)).toEqual(new Set(["conv_A"]));
		const saved = addMessageMock.mock.calls
			.map(
				(call) =>
					(call[0] as { message: Record<string, unknown> }).message,
			)
			.find((m) => m.role === "assistant");
		expect(saved).toMatchObject({
			content: "partial reply in A",
			streamStatus: "cancelled",
		});
		await waitFor(() => {
			expect(view.container.textContent).toContain("answer from B");
		});
	});

	it("keeps the live thread when the URL receives the conversation this chat just created", async () => {
		// The case the original guard was written for.
		createConversationMock.mockResolvedValue({ id: "conv_N" });
		const { ui, onConversationCreated } = harness();
		const view = render(ui(null, null));
		hookState.messages = [
			{
				id: "u1",
				role: "user",
				content: "brand new",
				timestamp: new Date(0),
			},
			{
				id: "a1",
				role: "assistant",
				content: "streaming reply",
				timestamp: new Date(0),
				isStreaming: true,
			},
		];
		hookState.isLoading = true;
		await act(async () => {
			view.rerender(ui(null, null));
		});
		await waitFor(() => {
			expect(onConversationCreated).toHaveBeenCalledWith("conv_N");
		});

		view.rerender(
			ui("conv_N", conversation("conv_N", [["user", "brand new"]])),
		);

		expect(resetMock).not.toHaveBeenCalled();
		expect(stopMock).not.toHaveBeenCalled();
		expect(view.container.textContent).toContain("streaming reply");
	});
});

describe("FabricDirectChat — reopening a saved conversation", () => {
	it("does not show the workflow's operation-result row beside the saved answer (F33)", async () => {
		const { ui } = harness();
		const withSystemRow = {
			...conversation("conv_S", [
				["user", "what is on the roadmap?"],
				["assistant", "Three features are planned."],
			]),
		};
		withSystemRow.messages.push({
			id: "conv_S-op",
			role: "system" as never,
			content: "SYSTEM\n\nThree features are planned.",
			timestamp: "2026-09-01T00:00:01.000Z",
			metadata: { kind: "operation_result", outcome: "success" },
		} as never);

		const view = render(ui("conv_S", withSystemRow));

		await waitFor(() => {
			expect(view.container.textContent).toContain(
				"Three features are planned.",
			);
		});
		expect(view.container.textContent).not.toContain("SYSTEM");
	});

	it("shows a saved failure as the partial answer plus its cause (F22)", async () => {
		const { ui } = harness();
		const failed = conversation("conv_F", [
			["user", "draw the roadmap"],
			["assistant", "Let me pull up the roadmap first."],
		]);
		Object.assign(failed.messages[1], {
			streamStatus: "error",
			metadata: { errorMessage: "activity Heartbeat timeout" },
		});

		const view = render(ui("conv_F", failed));

		await waitFor(() => {
			expect(view.container.textContent).toContain(
				"Let me pull up the roadmap first.",
			);
		});
		expect(view.container.textContent).toContain(
			"The answer stopped early",
		);
		expect(view.container.textContent).toContain(
			"activity Heartbeat timeout",
		);
	});
});
