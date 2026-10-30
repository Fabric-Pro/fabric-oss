/**
 * `FabricDirectChat` over its two transports (`COPILOTKIT_DIRECT_CHAT`).
 *
 * Off, the chat runs `useDirectStream` and saves each turn from the browser
 * exactly as before. On, for a member who may save conversations, it runs
 * `useDirectRuntimeStream`: the runtime creates the conversation under the
 * chat's thread id and saves every turn, so the chat adopts the conversation
 * when the runtime says it started and never creates or writes it itself. A
 * project guest stays on the stream route with the flag on.
 *
 * Same thin harness as the tool-approval test, with both stream hooks
 * stubbed so the test sees which one the chat runs.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({
	flag: false,
	userRole: "member" as string | null,
	isGuest: false,
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "COPILOTKIT_DIRECT_CHAT" && access.flag,
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org_example",
		organizationSlug: "example-org",
		organizationName: "Example Organization",
		basePath: "/app/example-org",
		isOrgContext: true,
		isPersonalContext: false,
		isOrganizationAdmin: false,
		isGuest: access.isGuest,
		userRole: access.userRole,
		loaded: true,
		organization: { id: "org_example", slug: "example-org" },
	}),
}));

vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/ChatMessageInsertDiagramButton",
	() => ({ ChatMessageInsertDiagramButton: () => null }),
);
vi.mock("@/components/ai-elements/McpAppFrame", () => ({
	McpAppFrame: () => null,
}));
vi.mock("@saas/agents/components/FabricAgentLauncher", () => ({
	useFabricAgentLauncher: () => ({
		applyToDocument: null,
		launchContext: { projectId: "proj_1" },
		isOpen: false,
		openLauncher: vi.fn(),
		closeLauncher: vi.fn(),
		clearContext: vi.fn(),
		registerAmbientContext: vi.fn(() => () => {}),
		registerDocumentEditor: vi.fn(() => () => {}),
	}),
	useRegisterFabricAgentContext: vi.fn(),
	FabricAgentLauncherProvider: ({
		children,
	}: {
		children: React.ReactNode;
	}) => children,
}));
const fakeEditor = { on: vi.fn(), off: vi.fn() } as unknown as Editor;
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/useActiveTipTapEditor",
	() => ({
		useActiveTipTapEditor: vi.fn(() => ({
			kind: "story" as const,
			editor: fakeEditor,
			projectId: "proj_1",
			documentLabel: "F-007",
			storyId: "story_1",
		})),
	}),
);
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/useChatScopedProject",
	() => ({
		useChatScopedProjectFromLauncher: () => ({
			projectId: "proj_1",
			organizationId: null,
			lastUserPromptForMessage: () => "",
		}),
	}),
);
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/deriveDiagramTitle",
	() => ({ deriveDiagramTitle: () => "Untitled" }),
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
const updateConversationMock = vi.fn();
const attachProjectMock = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: {
			conversations: {
				create: (...args: unknown[]) => createConversationMock(...args),
				addMessage: (...args: unknown[]) => addMessageMock(...args),
				update: (...args: unknown[]) => updateConversationMock(...args),
			},
		},
		projects: {
			conversations: {
				attach: (...args: unknown[]) => attachProjectMock(...args),
			},
			diagrams: { createFromChat: vi.fn() },
		},
		users: {
			chatAgentSelection: {
				get: vi.fn(async () => ({
					selectedAgents: [],
					defaultAgent: null,
				})),
				set: vi.fn(),
			},
		},
	},
}));

interface StreamMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: Date;
	isStreaming?: boolean;
	streamStatus?: "streaming" | "completed" | "error" | "cancelled";
}
const streamMessages: StreamMessage[] = [];
const streamResult = () => ({
	messages: streamMessages,
	isLoading: false,
	sendMessage: vi.fn(),
	reset: vi.fn(),
	stop: vi.fn(),
	restoreContextUsage: vi.fn(),
	contextInfo: { usage: null, maxTokens: 200_000 },
});
const legacyHookMock = vi.fn((_options: unknown) => streamResult());
let runtimeOptions: { onConversationStarted?: (id: string) => void } = {};
const runtimeHookMock = vi.fn(
	(options: { onConversationStarted?: (id: string) => void }) => {
		runtimeOptions = options;
		return streamResult();
	},
);
vi.mock("@saas/agents/hooks/useDirectStream", () => ({
	useDirectStream: (options: unknown) => legacyHookMock(options),
}));
vi.mock("@saas/agents/hooks/useDirectRuntimeStream", () => ({
	useDirectRuntimeStream: (options: {
		onConversationStarted?: (id: string) => void;
	}) => runtimeHookMock(options),
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
	useToolSuggestions: () => ({ suggestions: [], isLoading: false }),
}));
vi.mock("@saas/agents/lib/derive-trajectory", () => ({
	deriveTrajectorySteps: () => [],
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
	() => ({ SkillSuggestionChips: () => null }),
);
vi.mock("@saas/agents/components/FabricChat/TrajectorySteps", () => ({
	TrajectorySteps: () => null,
}));
vi.mock("@/components/ai-elements/checkpoint", () => ({
	CheckpointCreateButton: () => null,
	CheckpointHistory: () => null,
	CheckpointProvider: ({ children }: { children: React.ReactNode }) =>
		children,
	createCheckpoint: vi.fn(),
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
vi.mock("@/components/ai-elements/sources", () => ({ Sources: () => null }));
vi.mock("@saas/agents/components/StoppedIndicator", () => ({
	StoppedIndicator: () => null,
}));
vi.mock("@saas/shared/components/FabricLogo", () => ({
	FabricLogo: () => null,
}));

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
	ResizeObserverStub;

const { FabricDirectChat } = await import("../FabricDirectChat");

function finishedTurn() {
	streamMessages.length = 0;
	streamMessages.push(
		{
			id: "msg_user_1",
			role: "user",
			content: "What changed?",
			timestamp: new Date("2026-10-30T09:00:00Z"),
		},
		{
			id: "msg_assistant_1",
			role: "assistant",
			content: "Two things changed.",
			timestamp: new Date("2026-10-30T09:00:01Z"),
			isStreaming: false,
			streamStatus: "completed",
		},
	);
}

function renderChat(
	props: Partial<React.ComponentProps<typeof FabricDirectChat>> = {},
) {
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
				{...props}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	access.flag = false;
	access.userRole = "member";
	access.isGuest = false;
	streamMessages.length = 0;
	runtimeOptions = {};
	legacyHookMock.mockClear();
	runtimeHookMock.mockClear();
	createConversationMock
		.mockReset()
		.mockResolvedValue({ id: "conv_client_created" });
	addMessageMock.mockReset().mockResolvedValue({});
	updateConversationMock.mockReset().mockResolvedValue({});
	attachProjectMock.mockReset().mockResolvedValue({});
});

describe("FabricDirectChat transport", () => {
	it("runs the Direct stream hook and saves the turn from the browser while the flag is off", async () => {
		finishedTurn();
		const onConversationSaved = vi.fn();

		renderChat({ onConversationSaved });

		expect(legacyHookMock).toHaveBeenCalled();
		expect(runtimeHookMock).not.toHaveBeenCalled();
		await waitFor(() => expect(createConversationMock).toHaveBeenCalled());
		await waitFor(() => expect(addMessageMock).toHaveBeenCalled());
		await waitFor(() => expect(onConversationSaved).toHaveBeenCalled());
	});

	it("runs the runtime hook with the flag on and never writes the conversation itself", async () => {
		access.flag = true;
		finishedTurn();
		const onConversationSaved = vi.fn();

		renderChat({ onConversationSaved });

		expect(runtimeHookMock).toHaveBeenCalled();
		expect(legacyHookMock).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(onConversationSaved).toHaveBeenCalledTimes(1),
		);
		expect(createConversationMock).not.toHaveBeenCalled();
		expect(addMessageMock).not.toHaveBeenCalled();
	});

	it("adopts the conversation the runtime started, with the chat's project attached", async () => {
		access.flag = true;
		const onConversationCreated = vi.fn();

		renderChat({
			onConversationCreated,
			attachedProjectId: "proj_example",
		});
		await act(async () => {
			runtimeOptions.onConversationStarted?.("thread_example_1");
		});

		expect(onConversationCreated).toHaveBeenCalledWith("thread_example_1");
		expect(attachProjectMock).toHaveBeenCalledWith({
			conversationId: "thread_example_1",
			projectId: "proj_example",
			organizationId: "org_example",
		});
		// The chat's tool selection is written onto the adopted conversation.
		await waitFor(() =>
			expect(updateConversationMock).toHaveBeenCalledWith(
				expect.objectContaining({ id: "thread_example_1" }),
			),
		);
		expect(createConversationMock).not.toHaveBeenCalled();
	});

	it("keeps a project guest on the Direct stream hook with the flag on", () => {
		access.flag = true;
		access.isGuest = true;
		access.userRole = null;

		renderChat();

		expect(legacyHookMock).toHaveBeenCalled();
		expect(runtimeHookMock).not.toHaveBeenCalled();
	});
});
