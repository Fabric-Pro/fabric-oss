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
import { getInterfaceModeChrome } from "../../../lib/interface-mode-chrome";

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
	useEffectiveOrganizationId: (provided?: string | null) =>
		provided ?? "org_example",
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
const updateConversationMock = vi.fn();
const selectionMock = vi.fn();
const instanceGetMock = vi.fn();
const detachProjectMock = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agentTemplates: {
			instances: {
				get: (...args: unknown[]) => instanceGetMock(...args),
			},
		},
		projects: {
			diagrams: { createFromChat: vi.fn() },
			conversations: {
				getProject: vi.fn(async () => null),
				attach: vi.fn(),
				detach: (...args: unknown[]) => detachProjectMock(...args),
			},
		},
		agents: {
			conversations: {
				create: (...args: unknown[]) => createConversationMock(...args),
				addMessage: (...args: unknown[]) => addMessageMock(...args),
				update: (...args: unknown[]) => updateConversationMock(...args),
			},
		},
		users: {
			chatAgentSelection: {
				get: (...args: unknown[]) => selectionMock(...args),
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

vi.mock("@saas/agents/lib/direct-chat-tools", async (importOriginal) => ({
	getSelectedConversationToolIds: (
		await importOriginal<typeof import("../../../lib/direct-chat-tools")>()
	).getSelectedConversationToolIds,
	mergeDirectConversationMetadata: (
		await importOriginal<typeof import("../../../lib/direct-chat-tools")>()
	).mergeDirectConversationMetadata,
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
	ActiveContextIndicator: (props: {
		projectId?: string | null;
		onProjectRemove?: () => void;
	}) =>
		props.projectId ? (
			<button
				type="button"
				aria-label="remove project"
				onClick={props.onProjectRemove}
			>
				{props.projectId}
			</button>
		) : null,
	AgentModelPicker: (props: {
		onToggleAgent: (agent: {
			agentId: string;
			name: string;
			modelOverride?: string;
		}) => void;
	}) => (
		<>
			<button
				type="button"
				onClick={() => props.onToggleAgent(restoredAgent)}
			>
				choose other agent
			</button>
			<button
				type="button"
				onClick={() =>
					props.onToggleAgent({
						agentId: "model:example-model",
						name: "Example Model",
						modelOverride: "example-model",
					})
				}
			>
				choose model
			</button>
			<button
				type="button"
				onClick={() =>
					props.onToggleAgent({
						agentId: `template-instance:${savedAgent.id}`,
						name: savedAgent.name,
					})
				}
			>
				choose saved agent
			</button>
		</>
	),
	ChatInput: (props: {
		onSend: (prompt: string) => void;
		headerSlot?: React.ReactNode;
	}) => (
		<>
			{" "}
			{props.headerSlot}
			<button
				type="button"
				onClick={() => props.onSend("third question")}
			>
				send
			</button>
		</>
	),
	ChatWelcome: (props: { composer?: React.ReactNode }) => props.composer,
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

let renderRealVersionIdentity = false;
vi.mock(
	"@saas/agents/components/FabricChat/shared/AgentVersionIdentity",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../shared/AgentVersionIdentity")
			>();
		return {
			AgentVersionIdentity: (
				props: React.ComponentProps<typeof actual.AgentVersionIdentity>,
			) =>
				renderRealVersionIdentity ? (
					<actual.AgentVersionIdentity {...props} />
				) : (
					<span
						data-testid="agent-identity"
						data-instance-id={props.instanceId}
					>
						{props.name ?? "Agent"}
					</span>
				),
		};
	},
);
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
	renderRealVersionIdentity = false;
	selectionMock.mockReset().mockResolvedValue(null);
	instanceGetMock.mockReset().mockResolvedValue({ instance: projectAgent });
	detachProjectMock.mockReset().mockResolvedValue({});
	createConversationMock.mockReset();
	addMessageMock.mockReset();
	updateConversationMock.mockReset().mockResolvedValue({});
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

function harness(
	props: Partial<React.ComponentProps<typeof FabricDirectChat>> = {},
) {
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
				{...props}
			/>
		</QueryClientProvider>
	);
	return { ui, queryClient };
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

const projectAgent = {
	id: "example-agent",
	name: "Example Agent",
	sId: "example-stable-agent",
	version: 1,
	status: "ARCHIVED",
	organizationId: "org_example",
	template: { instructions: "Use project context." },
	toolConnections: {
		"project-context": { enabled: true, projectId: "example-project" },
	},
	workspaceIds: [],
};
const restoredAgent = {
	agentId: "template-instance:example-agent",
	name: "Example Agent",
};

describe("FabricDirectChat instance selection context", () => {
	it("inherits sidebar MCP bindings for an unconfigured dedicated instance", async () => {
		instanceGetMock.mockResolvedValue({
			instance: { ...projectAgent, toolConnections: {} },
		});
		const { ui } = harness({
			instanceId: "example-agent",
			enabledMcpConfigIds: ["example-sidebar-mcp"],
		});
		const view = render(ui("conv_old", convOld));
		await sendAndSettle(view);
		expect(streamBodies[0].enabledMcpConfigIds).toEqual([
			"example-sidebar-mcp",
		]);
	});
	it("restricts restored selected-agent MCP access while its UI configuration query is pending", async () => {
		selectionMock.mockResolvedValue({ selectedAgents: [restoredAgent] });
		instanceGetMock.mockImplementationOnce(() => new Promise(() => {}));
		instanceGetMock.mockResolvedValue({
			instance: { ...projectAgent, toolConnections: {} },
		});
		const { ui } = harness({
			enabledMcpConfigIds: ["example-sidebar-mcp"],
		});
		const view = render(ui("conv_old", convOld));
		await waitFor(() => expect(instanceGetMock).toHaveBeenCalledTimes(1));
		await sendAndSettle(view);
		expect(streamBodies[0].instanceId).toBe("example-agent");
		expect(streamBodies[0].enabledMcpConfigIds).toEqual([]);
	});

	it("restores an identity-only selection, displays its project, and sends its configured tools", async () => {
		selectionMock.mockResolvedValue({ selectedAgents: [restoredAgent] });
		const { ui } = harness();
		const view = render(ui("conv_old", convOld));
		await waitFor(() =>
			expect(view.container.textContent).toContain("example-project"),
		);
		await sendAndSettle(view);
		expect(streamBodies[0]).toMatchObject({
			instanceId: "example-agent",
			projectId: "example-project",
		});
		expect(streamBodies[0].enabledFabricToolIds).toContain(
			"project_rag_query",
		);
	});
	it("sends during asynchronous restoration only after resolving the instance binding", async () => {
		selectionMock.mockResolvedValue({ selectedAgents: [restoredAgent] });
		let finish!: (value: { instance: typeof projectAgent }) => void;
		const pending = new Promise<{ instance: typeof projectAgent }>(
			(resolve) => {
				finish = resolve;
			},
		);
		instanceGetMock.mockReturnValue(pending);
		const { ui } = harness();
		const view = render(ui("conv_old", convOld));
		await waitFor(() => expect(instanceGetMock).toHaveBeenCalled());
		await act(async () => {
			fireEvent.click(view.getByRole("button", { name: "send" }));
		});
		expect(streamBodies).toEqual([]);
		await act(async () => {
			finish({ instance: projectAgent });
		});
		await waitFor(() =>
			expect(streamBodies[0]?.projectId).toBe("example-project"),
		);
	});
	it("keeps an attached project ahead of the restored agent default", async () => {
		selectionMock.mockResolvedValue({ selectedAgents: [restoredAgent] });
		const { ui } = harness({
			attachedProjectId: "example-attached-project",
		});
		const view = render(ui("conv_old", convOld));
		await waitFor(() => expect(instanceGetMock).toHaveBeenCalled());
		await sendAndSettle(view);
		expect(streamBodies[0].projectId).toBe("example-attached-project");
	});
	it("does not restore the agent project after the user removes it", async () => {
		selectionMock.mockResolvedValue({ selectedAgents: [restoredAgent] });
		const { ui } = harness();
		const view = render(ui(null, null));
		await waitFor(() =>
			expect(view.container.textContent).toContain("example-project"),
		);
		await act(async () => {
			fireEvent.click(
				view.getByRole("button", { name: "remove project" }),
			);
		});
		expect(view.container.textContent).not.toContain("example-project");
		createConversationMock.mockResolvedValue({
			conversation: { id: "example-conversation" },
		});
		await sendAndSettle(view);
		expect(streamBodies[0].projectId).toBeNull();
	});
	it("applies the default again when opening another conversation after removal", async () => {
		selectionMock.mockResolvedValue({ selectedAgents: [restoredAgent] });
		const { ui } = harness();
		const view = render(ui("conv_old", convOld));
		await waitFor(() =>
			expect(view.container.textContent).toContain("example-project"),
		);
		await act(async () => {
			fireEvent.click(
				view.getByRole("button", { name: "remove project" }),
			);
		});
		await waitFor(() =>
			expect(view.container.textContent).not.toContain("example-project"),
		);
		view.rerender(ui("conv_A", convA));
		await waitFor(() =>
			expect(view.container.textContent).toContain("example-project"),
		);
	});
	it.each([false, true])(
		"ignores a delayed project removal after changing conversations (return to origin: %s)",
		async (returnToOrigin) => {
			selectionMock.mockResolvedValue({
				selectedAgents: [restoredAgent],
			});
			let finishDetach!: (value: object) => void;
			detachProjectMock.mockReturnValue(
				new Promise((resolve) => {
					finishDetach = resolve;
				}),
			);
			const onProjectRemove = vi.fn();
			const { ui } = harness({ onProjectRemove });
			const view = render(ui("conv_old", convOld));
			await waitFor(() =>
				expect(view.container.textContent).toContain("example-project"),
			);
			await act(async () => {
				fireEvent.click(
					view.getByRole("button", { name: "remove project" }),
				);
			});
			expect(detachProjectMock).toHaveBeenCalledWith({
				conversationId: "conv_old",
				organizationId: "org_example",
			});
			view.rerender(ui("conv_A", convA));
			await waitFor(() =>
				expect(view.container.textContent).toContain("question in A"),
			);
			if (returnToOrigin) {
				view.rerender(ui("conv_old", convOld));
				await waitFor(() =>
					expect(view.container.textContent).toContain(
						"second answer",
					),
				);
			}
			await act(async () => {
				finishDetach({});
			});
			await sendAndSettle(view);
			expect
				.soft(view.container.textContent)
				.toContain("example-project");
			expect.soft(streamBodies[0].projectId).toBe("example-project");
			expect.soft(onProjectRemove).not.toHaveBeenCalled();
		},
	);
});

const savedAgent = {
	...projectAgent,
	id: "example-saved-agent",
	name: "Saved Agent",
	status: "ACTIVE",
	version: 2,
	toolConnections: {
		"project-context": {
			enabled: true,
			projectId: "example-saved-project",
		},
		"create-story": { enabled: true },
	},
};

function mockVersionedInstances() {
	instanceGetMock.mockImplementation(
		async ({ id, sId }: { id?: string; sId?: string }) => ({
			instance:
				id === savedAgent.id || sId === savedAgent.sId
					? savedAgent
					: projectAgent,
		}),
	);
	createConversationMock.mockResolvedValue({ id: "example-new-chat" });
}

describe("FabricDirectChat dedicated instance scope", () => {
	it("persists an explicit picker override in an existing conversation", async () => {
		mockVersionedInstances();
		const { ui } = harness({ instanceId: savedAgent.id });
		const view = render(
			ui("conv_old", {
				...convOld,
				metadata: { instanceId: savedAgent.id },
			}),
		);
		fireEvent.click(
			view.getByRole("button", { name: "choose other agent" }),
		);
		await sendAndSettle(view);
		expect(streamBodies[0].instanceId).toBe(projectAgent.id);
		await waitFor(() =>
			expect(updateConversationMock).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "conv_old",
					metadata: expect.objectContaining({
						instanceId: streamBodies[0].instanceId,
					}),
				}),
			),
		);
	});
	it("reopens the explicitly chosen concrete version from saved conversation metadata", async () => {
		mockVersionedInstances();
		const launched = harness({ instanceId: savedAgent.id });
		const view = render(launched.ui(null, null));
		fireEvent.click(
			view.getByRole("button", { name: "choose other agent" }),
		);
		await sendAndSettle(view);
		const metadata = createConversationMock.mock.calls[0][0].metadata;
		expect(metadata.instanceId).toBe(streamBodies[0].instanceId);
		view.unmount();
		// FabricAIClient restores this concrete metadata ID when no URL ID is present.
		const restored = harness({ instanceId: metadata.instanceId });
		restored.queryClient.setQueryData(
			["chat-agent-selection", "user_1", "org_example"],
			{
				selectedAgents: [
					{
						agentId: `template-instance:${savedAgent.id}`,
						name: savedAgent.name,
					},
				],
				defaultAgent: null,
			},
		);
		const reopened = render(
			restored.ui("conv_old", { ...convOld, metadata }),
		);
		await sendAndSettle(reopened);
		expect(streamBodies[1].instanceId).toBe(projectAgent.id);
	});
	it("shows the same authorized version it dispatches after launch and an explicit picker change", async () => {
		renderRealVersionIdentity = true;
		mockVersionedInstances();
		const { ui, queryClient } = harness({ instanceId: savedAgent.id });
		queryClient.setQueryData(
			["chat-agent-selection", "user_1", "org_example"],
			{
				selectedAgents: [restoredAgent],
				defaultAgent: null,
			},
		);
		const view = render(ui(null, null));
		await waitFor(() =>
			expect(view.container.textContent).toContain("Saved Agent · v2"),
		);
		await sendAndSettle(view);
		expect(streamBodies[0].instanceId).toBe(savedAgent.id);
		fireEvent.click(
			view.getByRole("button", { name: "choose other agent" }),
		);
		await waitFor(() =>
			expect(view.container.textContent).toContain("Example Agent · v1"),
		);
		expect(view.container.textContent).not.toContain("Saved Agent · v2");
		await sendAndSettle(view);
		expect(streamBodies[1].instanceId).toBe(projectAgent.id);
	});
	it("shows the authorized dedicated version with the picker hidden and dispatches that instance", async () => {
		renderRealVersionIdentity = true;
		mockVersionedInstances();
		const { ui } = harness({
			instanceId: savedAgent.id,
			showAgentPicker: false,
		});
		const view = render(ui(null, null));
		await waitFor(() =>
			expect(view.container.textContent).toContain("Saved Agent · v2"),
		);
		await sendAndSettle(view);
		expect(streamBodies[0].instanceId).toBe(savedAgent.id);
		expect(view.container.textContent).toContain("Saved Agent · v2");
	});
	it.each(["simple", "advanced"] as const)(
		"uses the launched saved version instead of a cached global selection in %s mode",
		async (mode) => {
			mockVersionedInstances();
			const chrome = getInterfaceModeChrome(mode);
			const { ui, queryClient } = harness({
				instanceId: savedAgent.id,
				enabledFabricToolIds: [
					"project_rag_query",
					"fabric_create_story",
				],
				showAgentPicker: chrome.showAgentPicker,
				agentPickerCatalog: chrome.agentPickerCatalog,
			});
			queryClient.setQueryData(
				["chat-agent-selection", "user_1", "org_example"],
				{
					selectedAgents: [restoredAgent],
					defaultAgent: null,
				},
			);
			const view = render(ui(null, null));
			await sendAndSettle(view);
			expect.soft(streamBodies[0].instanceId).toBe(savedAgent.id);
			expect
				.soft(
					view
						.getByTestId("agent-identity")
						.getAttribute("data-instance-id"),
				)
				.toBe(streamBodies[0].instanceId);
			expect
				.soft(streamBodies[0].projectId)
				.toBe("example-saved-project");
			expect
				.soft(streamBodies[0].enabledFabricToolIds)
				.toContain("fabric_create_story");
			expect.soft(selectionMock).not.toHaveBeenCalled();
			expect
				.soft(
					createConversationMock.mock.calls[0][0].metadata.instanceId,
				)
				.toBe(savedAgent.id);
		},
	);
	it("keeps a restored conversation pinned to its concrete older version", async () => {
		mockVersionedInstances();
		const { ui, queryClient } = harness({ instanceId: projectAgent.id });
		queryClient.setQueryData(
			["chat-agent-selection", "user_1", "org_example"],
			{
				selectedAgents: [
					{
						agentId: `template-instance:${savedAgent.id}`,
						name: "Saved Agent",
					},
				],
				defaultAgent: null,
			},
		);
		const pinnedConversation = {
			...convOld,
			metadata: { instanceId: projectAgent.id },
		};
		const view = render(ui("conv_old", pinnedConversation));
		await sendAndSettle(view);
		expect(streamBodies[0].instanceId).toBe(projectAgent.id);
		expect(streamBodies[0].enabledFabricToolIds).not.toContain(
			"fabric_create_story",
		);
	});
	it("does not replace a dedicated instance with the global default agent", async () => {
		mockVersionedInstances();
		const { ui, queryClient } = harness({ instanceId: savedAgent.id });
		queryClient.setQueryData(
			["chat-agent-selection", "user_1", "org_example"],
			{
				selectedAgents: [],
				defaultAgent: restoredAgent,
			},
		);
		const view = render(ui(null, null));
		await sendAndSettle(view);
		expect(streamBodies[0].instanceId).toBe(savedAgent.id);
	});
	it("allows an explicit picker choice to override the dedicated instance", async () => {
		mockVersionedInstances();
		const { ui } = harness({ instanceId: savedAgent.id });
		const view = render(ui(null, null));
		fireEvent.click(
			view.getByRole("button", { name: "choose other agent" }),
		);
		await waitFor(() =>
			expect(view.container.textContent).toContain("Example Agent"),
		);
		await sendAndSettle(view);
		expect(streamBodies[0].instanceId).toBe(projectAgent.id);
		expect(
			view.getByTestId("agent-identity").getAttribute("data-instance-id"),
		).toBe(streamBodies[0].instanceId);
		expect(streamBodies[0].projectId).toBe("example-project");
		expect(
			createConversationMock.mock.calls[0][0].metadata.instanceId,
		).toBe(streamBodies[0].instanceId);
		expect(streamBodies[0].enabledFabricToolIds).not.toContain(
			"fabric_create_story",
		);
	});
});

describe("FabricDirectChat clears an obsolete conversation instance pin", () => {
	it.each(["clear", "model"] as const)(
		"removes the pin after %s and reopens without the old instance",
		async (choice) => {
			mockVersionedInstances();
			selectionMock.mockResolvedValue({
				selectedAgents: [restoredAgent],
				defaultAgent: null,
			});
			const { ui } = harness();
			const view = render(
				ui("conv_old", {
					...convOld,
					metadata: { instanceId: projectAgent.id, custom: true },
				}),
			);
			await waitFor(() =>
				expect(
					view.getByRole("button", { name: "Clear Example Agent" }),
				).toBeTruthy(),
			);
			fireEvent.click(
				view.getByRole("button", {
					name:
						choice === "clear"
							? "Clear Example Agent"
							: "choose model",
				}),
			);
			await sendAndSettle(view);
			expect(streamBodies[0]).not.toHaveProperty("instanceId");
			if (choice === "model") {
				expect(streamBodies[0].modelOverride).toBe("example-model");
			}
			const lastUpdate = updateConversationMock.mock.calls.at(-1);
			expect(lastUpdate).toBeDefined();
			const metadata = lastUpdate?.[0].metadata;
			expect.soft(metadata).not.toHaveProperty("instanceId");
			expect(metadata.custom).toBe(true);
			view.unmount();
			selectionMock.mockResolvedValue({
				selectedAgents:
					choice === "model"
						? [
								{
									agentId: "model:example-model",
									name: "Example Model",
									modelOverride: "example-model",
								},
							]
						: [],
				defaultAgent: null,
			});
			const reopened = harness({ instanceId: metadata.instanceId });
			const reopenedView = render(
				reopened.ui("conv_old", { ...convOld, metadata }),
			);
			await sendAndSettle(reopenedView);
			expect(streamBodies[1]).not.toHaveProperty("instanceId");
		},
	);
});

describe("FabricDirectChat orders conversation metadata writes", () => {
	it.each(["saved", "clear"] as const)(
		"keeps the final %s choice when an earlier update is delayed",
		async (choice) => {
			mockVersionedInstances();
			let persisted: Record<string, unknown> = {};
			let finishEarlier!: () => void;
			updateConversationMock.mockImplementation(
				async (input: { metadata: Record<string, unknown> }) => {
					persisted = input.metadata;
				},
			);
			const { ui } = harness();
			const view = render(ui("conv_old", convOld));
			await waitFor(() =>
				expect(updateConversationMock).toHaveBeenCalled(),
			);
			updateConversationMock.mockImplementation(
				(input: { metadata: Record<string, unknown> }) =>
					input.metadata.instanceId === projectAgent.id
						? new Promise<void>((resolve) => {
								finishEarlier = () => {
									persisted = input.metadata;
									resolve();
								};
							})
						: Promise.resolve().then(() => {
								persisted = input.metadata;
							}),
			);
			fireEvent.click(
				view.getByRole("button", { name: "choose other agent" }),
			);
			await waitFor(() => expect(finishEarlier).toBeDefined());
			fireEvent.click(
				view.getByRole("button", {
					name:
						choice === "saved"
							? "choose saved agent"
							: "Clear Example Agent",
				}),
			);
			await act(async () => {
				await Promise.resolve();
			});
			await act(async () => {
				finishEarlier();
			});
			await waitFor(() =>
				choice === "saved"
					? expect(persisted.instanceId).toBe(savedAgent.id)
					: expect(persisted).not.toHaveProperty("instanceId"),
			);
			await sendAndSettle(view);
			expect(streamBodies[0].instanceId).toBe(
				choice === "saved" ? savedAgent.id : undefined,
			);
		},
	);
	it("recovers a queued choice after the preceding update rejects", async () => {
		mockVersionedInstances();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		let persisted: Record<string, unknown> = {};
		let rejectEarlier!: () => void;
		updateConversationMock.mockImplementation(
			async (input: { metadata: Record<string, unknown> }) => {
				persisted = input.metadata;
			},
		);
		const { ui } = harness();
		const view = render(ui("conv_old", convOld));
		await waitFor(() => expect(updateConversationMock).toHaveBeenCalled());
		updateConversationMock.mockImplementation(
			(input: { metadata: Record<string, unknown> }) =>
				input.metadata.instanceId === projectAgent.id
					? new Promise<void>((_, reject) => {
							rejectEarlier = () =>
								reject(new Error("Example update failure"));
						})
					: Promise.resolve().then(() => {
							persisted = input.metadata;
						}),
		);
		fireEvent.click(
			view.getByRole("button", { name: "choose other agent" }),
		);
		await waitFor(() => expect(rejectEarlier).toBeDefined());
		fireEvent.click(
			view.getByRole("button", { name: "choose saved agent" }),
		);
		await act(async () => {
			rejectEarlier();
		});
		await waitFor(() => expect(persisted.instanceId).toBe(savedAgent.id));
		expect(error).toHaveBeenCalled();
	});
	it("lets another conversation save independently and keeps captured target IDs", async () => {
		mockVersionedInstances();
		const persisted = new Map<string, Record<string, unknown>>();
		let finishEarlier!: () => void;
		updateConversationMock.mockImplementation(
			async (input: {
				id: string;
				metadata: Record<string, unknown>;
			}) => {
				persisted.set(input.id, input.metadata);
			},
		);
		const { ui } = harness();
		const view = render(ui("conv_old", convOld));
		await waitFor(() => expect(persisted.has("conv_old")).toBe(true));
		updateConversationMock.mockImplementation(
			(input: { id: string; metadata: Record<string, unknown> }) =>
				input.id === "conv_old"
					? new Promise<void>((resolve) => {
							finishEarlier = () => {
								persisted.set(input.id, input.metadata);
								resolve();
							};
						})
					: Promise.resolve().then(() => {
							persisted.set(input.id, input.metadata);
						}),
		);
		fireEvent.click(
			view.getByRole("button", { name: "choose other agent" }),
		);
		await waitFor(() => expect(finishEarlier).toBeDefined());
		view.rerender(ui("conv_A", convA));
		await waitFor(() =>
			expect(persisted.get("conv_A")?.instanceId).toBe(projectAgent.id),
		);
		expect(persisted.get("conv_old")).not.toHaveProperty("instanceId");
		await act(async () => {
			finishEarlier();
		});
		await waitFor(() =>
			expect(persisted.get("conv_old")?.instanceId).toBe(projectAgent.id),
		);
		expect(persisted.get("conv_A")?.instanceId).toBe(projectAgent.id);
	});
});

it("orders writes across remounts of the same conversation", async () => {
	mockVersionedInstances();
	let persisted: Record<string, unknown> = {};
	let finishEarlier!: () => void;
	updateConversationMock.mockImplementation(
		async (input: { metadata: Record<string, unknown> }) => {
			persisted = input.metadata;
		},
	);
	const first = harness();
	const view = render(first.ui("conv_old", convOld));
	await waitFor(() => expect(updateConversationMock).toHaveBeenCalled());
	updateConversationMock.mockImplementation(
		(input: { metadata: Record<string, unknown> }) =>
			input.metadata.instanceId === projectAgent.id
				? new Promise<void>((resolve) => {
						finishEarlier = () => {
							persisted = input.metadata;
							resolve();
						};
					})
				: Promise.resolve().then(() => {
						persisted = input.metadata;
					}),
	);
	fireEvent.click(view.getByRole("button", { name: "choose other agent" }));
	await waitFor(() => expect(finishEarlier).toBeDefined());
	view.unmount();
	const second = harness({ instanceId: savedAgent.id });
	render(second.ui("conv_old", convOld));
	await act(async () => {
		await Promise.resolve();
	});
	await act(async () => {
		finishEarlier();
	});
	await waitFor(() => expect(persisted.instanceId).toBe(savedAgent.id));
});

it.each(["clear", "model"] as const)(
	"preserves a dedicated instance pin when the picker chooses %s",
	async (choice) => {
		mockVersionedInstances();
		const { ui } = harness({ instanceId: savedAgent.id });
		const view = render(
			ui("conv_old", {
				...convOld,
				metadata: { instanceId: savedAgent.id },
			}),
		);
		if (choice === "clear") {
			fireEvent.click(
				view.getByRole("button", { name: "choose other agent" }),
			);
			fireEvent.click(
				view.getByRole("button", { name: "Clear Example Agent" }),
			);
		} else {
			fireEvent.click(view.getByRole("button", { name: "choose model" }));
		}
		await sendAndSettle(view);
		expect(streamBodies[0].instanceId).toBe(savedAgent.id);
		expect(
			updateConversationMock.mock.calls.at(-1)?.[0].metadata.instanceId,
		).toBe(savedAgent.id);
	},
);

it("resets the selection when production instance keys remount a generic or dedicated chat", async () => {
	const nextAgent = {
		...savedAgent,
		id: "example-next-agent",
		name: "Next Agent",
		version: 3,
	};
	mockVersionedInstances();
	instanceGetMock.mockImplementation(
		async ({ id, sId }: { id?: string; sId?: string }) => ({
			instance:
				id === nextAgent.id
					? nextAgent
					: id === savedAgent.id || sId
						? savedAgent
						: projectAgent,
		}),
	);
	selectionMock.mockResolvedValue({
		selectedAgents: [restoredAgent],
		defaultAgent: null,
	});
	const { queryClient } = harness();
	// FabricAIClient uses distinct generic/instance keys and includes the concrete ID.
	const surface = (instanceId?: string) => (
		<QueryClientProvider client={queryClient}>
			<FabricDirectChat
				key={
					instanceId
						? `agent-direct-${instanceId}-example-session`
						: "direct-example-session"
				}
				organizationId="org_example"
				reasoningMode="balanced"
				instanceId={instanceId}
			/>
		</QueryClientProvider>
	);
	const view = render(surface());
	await waitFor(() =>
		expect(
			view.getByRole("button", { name: "Clear Example Agent" }),
		).toBeTruthy(),
	);
	view.rerender(surface(savedAgent.id));
	await sendAndSettle(view);
	expect(streamBodies[0].instanceId).toBe(savedAgent.id);
	expect(
		view.getByTestId("agent-identity").getAttribute("data-instance-id"),
	).toBe(savedAgent.id);
	expect(
		createConversationMock.mock.calls.at(-1)?.[0].metadata.instanceId,
	).toBe(savedAgent.id);
	fireEvent.click(view.getByRole("button", { name: "choose other agent" }));
	await sendAndSettle(view);
	expect(streamBodies[1].instanceId).toBe(projectAgent.id);
	view.rerender(surface(nextAgent.id));
	await sendAndSettle(view);
	expect(streamBodies[2].instanceId).toBe(nextAgent.id);
	expect(
		view.getByTestId("agent-identity").getAttribute("data-instance-id"),
	).toBe(nextAgent.id);
	expect(
		createConversationMock.mock.calls.at(-1)?.[0].metadata.instanceId,
	).toBe(nextAgent.id);
});
