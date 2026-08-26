/**
 * Tests for the F3 wiring — `<ChatMessageInsertDiagramButton />` rendered
 * adjacent to `<McpAppFrame>` inside `FabricDirectChat` (spec § 8.1
 * row "In-feature (FabricDirectChat)" + F3 task description).
 *
 * Coverage:
 *   - Button renders with `surface="in-feature"` for a successful
 *     Excalidraw `create_view` tool call (resourceUri contains
 *     "excalidraw" and status === "complete").
 *   - The launcher-context-derived chat scope is forwarded to the button
 *     (projectId from `useFabricAgentLauncher().launchContext`, organizationId
 *     composed from the active org context — proves the resolver wiring
 *     uses step 1 of spec § 9 / canonical happy path).
 *   - Button does NOT render for non-Excalidraw MCP `<McpAppFrame>` tool
 *     calls (e.g. calendar / map widgets) — confirms the
 *     `resourceUri.includes("excalidraw")` gate.
 *
 * Strategy:
 *   `FabricDirectChat` is a 3600-line page-level component with 40+
 *   imports, so we mount it only as a thin harness for the .map block
 *   that does the F3 wiring. We mock the heavy hooks and the button
 *   itself so we can assert the prop contract without dragging in the
 *   entire SSE-stream + persistence + skill-suggestion machinery.
 *
 * NB: This is the F3 unit test only — the cross-surface E2E coverage
 * lives in `apps/web/tests/excalidraw-auto-insert.spec.ts` (Group G,
 * task G3 specifically for the in-feature happy path).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — these stand in for the heavy-weight hooks `FabricDirectChat`
// pulls in. Each mock returns the minimum shape the component requires
// to reach the render-decision branch we're exercising.
// ---------------------------------------------------------------------------

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

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			diagrams: {
				createFromChat: vi.fn(),
			},
		},
	},
}));

// `useDirectStream` is the big one. We mock it to surface a single
// assistant message with one tool call whose envelope decides the
// branch under test. Tests mutate `streamMessages` before render.
const streamMessages: Array<{
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: Date;
	toolCalls?: Array<{
		id: string;
		name: string;
		args: unknown;
		result?: unknown;
		status: "pending" | "running" | "complete" | "error";
		mcpAppResourceUri?: string;
		mcpAppConfigId?: string;
	}>;
}> = [];

vi.mock("@saas/agents/hooks/useDirectStream", () => ({
	useDirectStream: () => ({
		messages: streamMessages,
		isLoading: false,
		sendMessage: vi.fn(),
		reset: vi.fn(),
		stop: vi.fn(),
		contextInfo: {
			usage: null,
			maxTokens: 200_000,
		},
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

// Defer the SUT import until AFTER all mocks are registered so vi.mock
// hoists correctly. The dynamic-import pattern matches the existing
// ChatMessageInsertDiagramButton test file.
const { FabricDirectChat } = await import("../FabricDirectChat");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildExcalidrawMessage(
	overrides: {
		messageId?: string;
		toolCallId?: string;
		status?: "complete" | "pending" | "running" | "error";
		resourceUri?: string;
		configId?: string;
		checkpointId?: string;
		elements?: unknown;
	} = {},
) {
	const {
		messageId = "msg_assistant_1",
		toolCallId = "tc_1",
		status = "complete",
		resourceUri = "ui://excalidraw/scene-1",
		configId = "cfg_excalidraw",
		checkpointId = "cp_abc123",
		elements = [{ type: "rectangle", id: "r1" }],
	} = overrides;

	return {
		id: messageId,
		role: "assistant" as const,
		content: "",
		timestamp: new Date("2026-05-23T12:00:00Z"),
		toolCalls: [
			{
				id: toolCallId,
				name: "create_view",
				args: { elements, appState: { viewBackgroundColor: "#fff" } },
				result: { checkpointId },
				status,
				mcpAppResourceUri: resourceUri,
				mcpAppConfigId: configId,
			},
		],
	};
}

function renderFabricDirectChat() {
	// The component persists the last-used agent through React Query, so it
	// needs a client in scope. Retries off and a fresh client per render keeps
	// a failed fetch from bleeding across tests.
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<FabricDirectChat
				organizationId="org_example"
				reasoningMode="balanced"
				activeConversationId={null}
				compactMode={false}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	insertDiagramButtonMock.mockReset();
	mcpAppFrameMock.mockReset();
	streamMessages.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FabricDirectChat — F3 Excalidraw button wiring", () => {
	it('renders <ChatMessageInsertDiagramButton surface="in-feature" /> below McpAppFrame for a successful Excalidraw create_view', () => {
		streamMessages.push(buildExcalidrawMessage());

		const { queryByTestId } = renderFabricDirectChat();

		// McpAppFrame still rendered (we do not modify it).
		expect(queryByTestId("mcp-app-frame")).not.toBeNull();
		// And the button followed.
		const button = queryByTestId("chat-message-insert-diagram-button");
		expect(button).not.toBeNull();
		expect(button?.getAttribute("data-surface")).toBe("in-feature");
		expect(button?.getAttribute("data-message-id")).toBe("msg_assistant_1");

		// Guards against accidental double-wiring. We assert at-least-once
		// (React 19 + Testing Library strict-mode renders may double-invoke
		// the render function, but the per-tool-call uniqueness is what
		// matters here — the .map block emits exactly one button per
		// matching tool call).
		expect(insertDiagramButtonMock).toHaveBeenCalled();

		// The launcher-derived projectId AND the active-org organizationId
		// are both forwarded via the composed chatScope. This proves the
		// FabricDirectChat wiring composed the adapter's null organizationId
		// with the active-org context (canonical happy path of spec § 9
		// step 1).
		const props = insertDiagramButtonMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		const chatScope = props.chatScope as {
			projectId: string;
			organizationId: string;
		};
		expect(chatScope.projectId).toBe("proj_feature_1");
		expect(chatScope.organizationId).toBe("org_example");
		expect(props.organizationSlug).toBe("example-org");

		// Resolver hands back the launcher-context story editor (step 1 of
		// spec § 9). That target is forwarded verbatim — proves the
		// resolver wiring path picks the launcher-context editor for the
		// in-feature surface.
		const resolverTarget = props.resolverTarget as {
			kind: string;
			projectId: string;
			storyId?: string;
			documentLabel: string;
		};
		expect(resolverTarget.kind).toBe("story");
		expect(resolverTarget.projectId).toBe("proj_feature_1");
		expect(resolverTarget.storyId).toBe("story_F-007");
		expect(resolverTarget.documentLabel).toBe("F-007 Login flow");

		// Tool-result extraction — elements + appState from tc.args,
		// checkpointId from tc.result, resourceUri + mcpConfigId from tc.
		const toolResult = props.toolResult as {
			elements: unknown;
			appState: unknown;
			checkpointId: string;
			mcpConfigId: string;
			resourceUri: string;
		};
		expect(toolResult.elements).toEqual([{ type: "rectangle", id: "r1" }]);
		expect(toolResult.appState).toEqual({ viewBackgroundColor: "#fff" });
		expect(toolResult.checkpointId).toBe("cp_abc123");
		expect(toolResult.mcpConfigId).toBe("cfg_excalidraw");
		expect(toolResult.resourceUri).toBe("ui://excalidraw/scene-1");

		// Title derived from the launcher prompt (deriveDiagramTitle is
		// mocked to passthrough first 60 chars). Confirms the chat-scope
		// lookup -> deriveDiagramTitle wiring.
		expect(props.title).toBe("Sketch the auth state machine");
	});

	it("does NOT render the button for non-Excalidraw MCP tool calls", () => {
		// A calendar / map MCP widget passes the McpAppFrame filter
		// (mcpAppResourceUri + mcpAppConfigId + non-error) but its
		// resourceUri does NOT include "excalidraw" — the F3 gate must
		// short-circuit before rendering the button.
		streamMessages.push(
			buildExcalidrawMessage({
				resourceUri: "ui://calendar/widget-1",
			}),
		);

		const { queryByTestId } = renderFabricDirectChat();

		// McpAppFrame still mounted — F3 must not touch the existing
		// MCP render contract.
		expect(queryByTestId("mcp-app-frame")).not.toBeNull();
		expect(mcpAppFrameMock).toHaveBeenCalled();

		// Button must NOT render for non-Excalidraw resources.
		expect(queryByTestId("chat-message-insert-diagram-button")).toBeNull();
		expect(insertDiagramButtonMock).not.toHaveBeenCalled();
	});

	it("does NOT render the button for a streaming-partial Excalidraw create_view (status !== complete)", () => {
		// While the tool call is still streaming, McpAppFrame may render
		// (status !== "error" passes the existing filter), but the Insert
		// button cannot fire because the checkpointId envelope isn't
		// final yet. The F3 gate ties button render to status === "complete"
		// so the user doesn't see the Insert action during the streaming
		// preview.
		streamMessages.push(
			buildExcalidrawMessage({
				status: "running",
			}),
		);

		const { queryByTestId } = renderFabricDirectChat();

		expect(queryByTestId("mcp-app-frame")).not.toBeNull();
		expect(queryByTestId("chat-message-insert-diagram-button")).toBeNull();
		expect(insertDiagramButtonMock).not.toHaveBeenCalled();
	});
});
