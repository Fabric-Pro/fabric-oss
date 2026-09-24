/**
 * Sending in a conversation opened from History with the REAL Direct stream
 * hook (Fizzy #2040, staging QA after the F27 switch fix).
 *
 * Opening a saved conversation resets the stream, which arms the hook's
 * "start fresh" flag; the first send then replaced the thread it was handed
 * with just the new exchange. The older messages vanished from the screen
 * until reload although the history still carried them to the model.
 *
 * Same thin harness as the conversation-switch test, minus its
 * `useDirectStream` stand-in: the defect lived in the hook.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@saas/agents/lib/cancel-telemetry", () => ({
	emitCancelEvent: vi.fn(),
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
	ChatInput: (props: { onSend: (prompt: string) => void }) => (
		<button type="button" onClick={() => props.onSend("third question")}>
			send
		</button>
	),
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

const convA = conversation("conv_A", [["user", "question in A"]]);
const convOld = conversation("conv_old", [
	["user", "first question"],
	["assistant", "first answer"],
	["user", "second question"],
	["assistant", "second answer"],
]);

function sseStream(events: Array<Record<string, unknown>>) {
	const encoder = new TextEncoder();
	const chunks = events.map((event) =>
		encoder.encode(`data: ${JSON.stringify(event)}\n`),
	);
	return {
		ok: true,
		body: {
			getReader: () => ({
				read: async () => {
					const value = chunks.shift();
					return value ? { value, done: false } : { done: true };
				},
			}),
		},
		json: async () => ({}),
	};
}

let streamBodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
	streamBodies = [];
	createConversationMock.mockReset();
	addMessageMock.mockReset();
	addMessageMock.mockResolvedValue({});
	vi.spyOn(global, "fetch").mockImplementation((async (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		if (String(input).includes("/api/agents/fabric-ai/stream")) {
			streamBodies.push(JSON.parse(String(init?.body ?? "{}")));
			return sseStream([
				{ type: "text", content: "third answer" },
				{ type: "done" },
			]);
		}
		return { ok: true, json: async () => ({}) };
	}) as unknown as typeof fetch);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function harness() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
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
				onConversationCreated={vi.fn()}
				compactMode={false}
			/>
		</QueryClientProvider>
	);
	return { ui };
}

const EXCHANGES = [
	"first question",
	"first answer",
	"second question",
	"second answer",
	"third question",
	"third answer",
];

async function sendAndSettle(view: ReturnType<typeof render>) {
	await act(async () => {
		fireEvent.click(view.getByRole("button", { name: "send" }));
	});
	await waitFor(() => {
		expect(view.container.textContent).toContain("third answer");
	});
}

describe("FabricDirectChat — sending in a conversation opened from History", () => {
	it("keeps the opened thread on screen and appends the new exchange", async () => {
		const { ui } = harness();
		const view = render(ui("conv_old", convOld));
		await waitFor(() => {
			expect(view.container.textContent).toContain("second answer");
		});

		await sendAndSettle(view);

		const text = view.container.textContent ?? "";
		const positions = EXCHANGES.map((line) => text.indexOf(line));
		expect(positions.every((p) => p >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		// The model received the same thread the screen shows.
		expect(
			(streamBodies[0].history as Array<{ content: string }>).map(
				(h) => h.content,
			),
		).toEqual(EXCHANGES.slice(0, 4));
		await waitFor(() => {
			expect(addMessageMock).toHaveBeenCalled();
		});
		for (const call of addMessageMock.mock.calls) {
			expect((call[0] as { conversationId: string }).conversationId).toBe(
				"conv_old",
			);
		}
	});

	it("after switching away from another conversation, shows only the opened one plus the new exchange", async () => {
		const { ui } = harness();
		const view = render(ui("conv_A", convA));
		await waitFor(() => {
			expect(view.container.textContent).toContain("question in A");
		});

		view.rerender(ui("conv_old", convOld));
		await waitFor(() => {
			expect(view.container.textContent).toContain("second answer");
		});
		await sendAndSettle(view);

		const text = view.container.textContent ?? "";
		for (const line of EXCHANGES) {
			expect(text).toContain(line);
		}
		expect(text).not.toContain("question in A");
	});
});
