/**
 * The approval card a tool result asks the chat to show.
 *
 * The chat has one confirmation card (the AI Elements `Confirmation`). Any tool
 * that needs the person's yes answers with `requiresConfirmation: true`, the
 * tool and the exact arguments, and the card is drawn from that: the draft as
 * its body for a scheduled workflow, the plain arguments for anything else. A
 * request that names no tool has nothing to approve and draws no card.
 * Approving goes back through the conversation, carrying the call the card
 * showed; cancelling sends nothing.
 *
 * `FabricDirectChat` is mounted as a thin harness, as in the Excalidraw
 * button test: the heavy hooks are stubbed so the message list reaches the
 * card, and the real card components render.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

// COPILOTKIT_DIRECT_CHAT off: the chat runs on the Direct stream route.
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
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
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { diagrams: { createFromChat: vi.fn() } } },
}));

interface StreamMessage {
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
	}>;
}
const streamMessages: StreamMessage[] = [];
const sendMessageMock = vi.fn();

vi.mock("@saas/agents/hooks/useDirectStream", () => ({
	useDirectStream: () => ({
		messages: streamMessages,
		isLoading: false,
		sendMessage: sendMessageMock,
		reset: vi.fn(),
		stop: vi.fn(),
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
	useToolSuggestions: () => ({ suggestions: [], isLoading: false }),
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

const DRAFT = {
	kind: "workflow",
	name: "Weekly work item digest",
	description: null,
	schedule: {
		cron: "0 9 * * 1",
		timezone: "Europe/Berlin",
		description: "every Monday at 09:00 (Europe/Berlin)",
	},
	prompt: "Summarise the open work items for the project.",
	mcpServers: [{ configId: "cfg-1", name: "Example Tracker" }],
	builtInTools: ["project-context"],
	project: { id: "proj_1", name: "Example Project" },
	outputTitle: "Weekly digest",
	outputFormat: "html",
	steps: [],
	problems: [],
};

function conversationWith(result: unknown, toolName: string) {
	streamMessages.length = 0;
	streamMessages.push(
		{
			id: "msg_user_1",
			role: "user",
			content: "Every Monday summarise the work items",
			timestamp: new Date("2026-10-14T09:00:00Z"),
		},
		{
			id: "msg_assistant_1",
			role: "assistant",
			content: "",
			timestamp: new Date("2026-10-14T09:00:01Z"),
			toolCalls: [
				{
					id: "tc_1",
					name: toolName,
					args: {},
					result,
					status: "complete",
				},
			],
		},
	);
}

function renderChat() {
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
	streamMessages.length = 0;
	sendMessageMock.mockReset();
});

describe("a workflow draft", () => {
	const createResult = {
		requiresConfirmation: true,
		toolName: "fabric_create_workflow",
		args: { preset: { name: "Weekly work item digest" } },
		draft: DRAFT,
		message: "needs approval",
	};

	it("is the body of the one confirmation card: when it runs, what it does, who it may call and where it publishes", () => {
		conversationWith(createResult, "fabric_create_workflow");

		renderChat();

		const card = screen.getByRole("alert");
		expect(
			within(card).getByRole("heading", {
				name: "Create workflow: Weekly work item digest",
			}),
		).toBeInTheDocument();
		expect(card).toHaveTextContent("every Monday at 09:00 (Europe/Berlin)");
		expect(card).toHaveTextContent("0 9 * * 1 · Europe/Berlin");
		expect(card).toHaveTextContent(
			"Summarise the open work items for the project.",
		);
		expect(card).toHaveTextContent("Example Tracker");
		expect(card).toHaveTextContent("project-context");
		expect(card).toHaveTextContent("Example Project");
		expect(card).toHaveTextContent("Weekly digest");
		expect(card).toHaveTextContent("runs it once now");
		expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
	});

	it("approving sends the call the card showed, exactly, through the conversation", () => {
		conversationWith(createResult, "fabric_create_workflow");
		renderChat();

		fireEvent.click(screen.getByRole("button", { name: "Approve" }));

		expect(sendMessageMock).toHaveBeenCalledTimes(1);
		const call = sendMessageMock.mock.calls[0];
		expect(call[0]).toBe(
			"Approved: create workflow “Weekly work item digest”.",
		);
		expect(call[2]).toEqual({
			approvedToolCall: {
				toolName: "fabric_create_workflow",
				args: { preset: { name: "Weekly work item digest" } },
			},
		});
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("cancelling sends nothing and takes the card away", () => {
		conversationWith(createResult, "fabric_create_workflow");
		renderChat();

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(sendMessageMock).not.toHaveBeenCalled();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("lists what would stop it going live and does not let it be approved", () => {
		conversationWith(
			{
				...createResult,
				draft: {
					...DRAFT,
					problems: [
						"The schedule runs every 5 minutes; the shortest allowed is 15",
					],
				},
			},
			"fabric_create_workflow",
		);

		renderChat();

		expect(screen.getByRole("alert")).toHaveTextContent(
			"the shortest allowed is 15",
		);
		expect(screen.getAllByRole("alert")).toHaveLength(1);
		expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
	});
});

describe("any other tool that needs approval", () => {
	it("renders the same card naming the action and the workflow it acts on", () => {
		conversationWith(
			{
				requiresConfirmation: true,
				toolName: "fabric_publish_workflow",
				args: { workflowId: "wf-1" },
				draft: {
					kind: "workflow-action",
					workflowId: "wf-1",
					workflowName: "Nightly digest",
					description: "Posts the digest",
					status: "DRAFT",
				},
			},
			"fabric_publish_workflow",
		);

		renderChat();

		const card = screen.getByRole("alert");
		expect(
			within(card).getByRole("heading", {
				name: "Publish workflow: Nightly digest",
			}),
		).toBeInTheDocument();
		expect(card).toHaveTextContent("Posts the digest");
		expect(card).toHaveTextContent("publishes the workflow");

		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		expect(sendMessageMock.mock.calls[0][2]).toEqual({
			approvedToolCall: {
				toolName: "fabric_publish_workflow",
				args: { workflowId: "wf-1" },
			},
		});
	});

	it("shows the arguments of a tool with no draft, nested ones by their path", () => {
		conversationWith(
			{
				requiresConfirmation: true,
				toolName: "fabric_share_page",
				args: {
					frameId: "frame-1",
					note: "for the team",
					nested: { a: 1 },
				},
			},
			"fabric_share_page",
		);

		renderChat();

		const card = screen.getByRole("alert");
		expect(
			within(card).getByRole("heading", { name: "Share page" }),
		).toBeInTheDocument();
		expect(card).toHaveTextContent("frameId");
		expect(card).toHaveTextContent("for the team");
		// A value the person approves is never hidden from them, however deep.
		expect(card).toHaveTextContent("nested.a1");
	});
});

describe("the actions a workflow can be taken through", () => {
	it.each([
		[
			"fabric_unpublish_workflow",
			"Unpublish workflow: Nightly digest",
			"stops its schedule",
		],
		[
			"fabric_pause_workflow",
			"Pause workflow: Nightly digest",
			"pauses the workflow's schedule",
		],
		[
			"fabric_resume_workflow",
			"Resume workflow: Nightly digest",
			"resumes the workflow's schedule",
		],
		[
			"fabric_execute_workflow",
			"Run workflow: Nightly digest",
			"starts one run now",
		],
	])("%s asks in its own words", (toolName, title, consequence) => {
		conversationWith(
			{
				requiresConfirmation: true,
				toolName,
				args: { workflowId: "wf-1" },
				draft: {
					kind: "workflow-action",
					workflowId: "wf-1",
					workflowName: "Nightly digest",
				},
			},
			toolName,
		);

		renderChat();

		const card = screen.getByRole("alert");
		expect(
			within(card).getByRole("heading", { name: title }),
		).toBeInTheDocument();
		expect(card).toHaveTextContent(consequence);
	});
});

describe("a page that is given tools", () => {
	it("names what the page will be able to call, as whoever opens it, before the person approves", () => {
		conversationWith(
			{
				requiresConfirmation: true,
				toolName: "fabric_create_frame",
				args: {
					title: "Delivery status",
					runtimeTools: ["fabric_list_workflows", "fabric_get_frame"],
				},
			},
			"fabric_create_frame",
		);

		renderChat();

		const card = screen.getByRole("alert");
		expect(
			within(card).getByRole("heading", { name: "Create frame" }),
		).toBeInTheDocument();
		expect(card).toHaveTextContent(
			"lets it call fabric_list_workflows, fabric_get_frame as whoever opens it",
		);
		expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
	});
});

describe("a request that names no tool and no arguments", () => {
	it("has nothing to approve, so it draws no card", () => {
		conversationWith(
			{
				requiresConfirmation: true,
				workflowId: "wf-1",
				workflowName: "Nightly digest",
				message: "Ready to execute workflow",
			},
			"execute_workflow",
		);

		renderChat();

		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByRole("button", { name: "Execute" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
	});
});

describe("results that ask for nothing", () => {
	it("draw no card", () => {
		conversationWith({ workflows: [] }, "fabric_list_workflows");

		renderChat();

		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
	});
});
