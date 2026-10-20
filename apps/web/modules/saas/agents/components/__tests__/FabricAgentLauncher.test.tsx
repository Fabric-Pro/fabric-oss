import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FabricAgentLauncherProvider,
	useFabricAgentLauncher,
	useRegisterFabricAgentContext,
} from "../FabricAgentLauncher";

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user_1" } }),
}));

vi.mock("next/navigation", () => ({
	usePathname: () => "/app/projects/project_1",
}));

/**
 * The stored preferences the drawer reads (#2040). Tests set it before
 * rendering; `undefined` is a user whose preference has not resolved, which
 * the drawer treats as simple mode.
 */
const storedPreferences = vi.hoisted(() => ({
	current: undefined as
		| {
				uiMode: "simple" | "advanced";
				chatMode: "direct" | "orchestrator" | "research";
				reasoningMode: "lite" | "balanced" | "deep" | "planner";
				enabledMcpConfigIds: string[];
		  }
		| undefined,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-query")>();
	return {
		...actual,
		useQuery: vi.fn((options: { queryKey?: unknown[] }) => {
			const isConversationDetail =
				options?.queryKey?.[0] === "agents" &&
				options.queryKey[2] === "detail";
			return {
				data: isConversationDetail
					? conversationDetail.current
					: options?.queryKey?.[0] === "orchestrator-preferences"
						? storedPreferences.current
						: options?.queryKey?.[0] === "project-get"
							? projectLookup.current
							: options?.queryKey?.[0] === "chat-agent-selection"
								? storedAgentSelection.current
								: undefined,
				isLoading: isConversationDetail
					? conversationDetail.loading
					: false,
				isError: isConversationDetail
					? conversationDetail.failed
					: false,
				refetch: conversationDetail.refetch,
			};
		}),
		// The drawer invalidates the conversation cache when a turn it started
		// finishes, so the full page picks it up after an expand (#2040).
		useQueryClient: vi.fn(() => queryClientMock),
	};
});

/** The stored session the drawer was asked to reopen, as the server returns it. */
const conversationDetail = vi.hoisted(() => ({
	current: undefined as
		| {
				id: string;
				title: string | null;
				isOwn?: boolean;
				messages: unknown[];
				metadata: unknown;
		  }
		| null
		| undefined,
	loading: false,
	/** The read failed for a reason other than the conversation being gone. */
	failed: false,
	refetch: vi.fn(),
}));

/** `projects.get` for a launch that carried only the project id (F46). */
const projectLookup = vi.hoisted(() => ({
	current: undefined as { project: { name: string } } | undefined,
}));

/** The saved picker selection, as the server returns it (FR13). */
const storedAgentSelection = vi.hoisted(() => ({
	current: undefined as
		| {
				selectedAgents: Array<{ agentId: string; name: string }>;
				defaultAgent: { agentId: string; name: string } | null;
				droppedCount: number;
		  }
		| undefined,
}));

const toastMock = vi.hoisted(() => ({ message: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

const queryClientMock = vi.hoisted(() => ({
	invalidateQueries: vi.fn(),
	setQueryData: vi.fn(),
}));

const orpcClientMock = vi.hoisted(() => ({
	users: {
		orchestratorPreferences: {
			update: vi.fn(async () => ({})),
		},
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: orpcClientMock }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryOptions: () => ({ queryKey: ["project-get"] }),
			},
		},
		agents: {
			codeIndex: {
				status: {
					queryOptions: () => ({ queryKey: ["code-index-status"] }),
				},
			},
		},
	},
}));

/**
 * Both engines render through `next/dynamic`; the mock tells them apart by
 * the module their loader imports and renders the props the drawer passes.
 */
vi.mock("next/dynamic", async () => {
	const React = await import("react");

	interface MockChatProps {
		initialInput?: string;
		attachedProjectId?: string | null;
		attachedCodeContext?: {
			filePath?: string | null;
			lineStart?: number | null;
			lineEnd?: number | null;
		} | null;
		systemPrompt?: string;
		reasoningMode?: string;
		executionModeOverride?: string;
		enabledToolIds?: string[] | null;
		enabledMcpConfigIds?: string[] | null;
		compactMode?: boolean;
		telemetrySurface?: string;
		surface?: string;
		onConversationCreated?: (id: string) => void;
		onStreamingChange?: (streaming: boolean) => void;
		onProjectRemove?: () => void;
		agentPickerCatalog?: string;
		activeConversationId?: string | null;
		activeConversation?: { id: string } | null;
	}

	function mockChat(engine: "direct" | "orchestrator") {
		return function MockChat({
			initialInput,
			attachedProjectId,
			attachedCodeContext,
			systemPrompt,
			reasoningMode,
			executionModeOverride,
			enabledToolIds,
			enabledMcpConfigIds,
			compactMode,
			telemetrySurface,
			surface,
			onConversationCreated,
			onStreamingChange,
			onProjectRemove,
			agentPickerCatalog,
			activeConversationId,
			activeConversation,
		}: MockChatProps) {
			const [mockInput, setMockInput] = React.useState(
				initialInput ?? "",
			);

			React.useEffect(() => {
				setMockInput(initialInput ?? "");
			}, [initialInput]);

			return (
				<div data-testid="drawer-chat" data-engine={engine}>
					<div>mock {engine} chat</div>
					<div>initial input: {mockInput}</div>
					<div>attached project: {attachedProjectId ?? ""}</div>
					<div data-testid="system-prompt">{systemPrompt ?? ""}</div>
					<div data-testid="reasoning-mode">
						{reasoningMode ?? ""}
					</div>
					<div data-testid="execution-mode">
						{executionModeOverride ?? ""}
					</div>
					<div data-testid="mcp-ids">
						{(enabledToolIds ?? enabledMcpConfigIds ?? []).join(
							",",
						)}
					</div>
					<div data-testid="compact">
						{String(Boolean(compactMode))}
					</div>
					<div data-testid="telemetry-surface">
						{telemetrySurface ?? surface ?? ""}
					</div>
					<div>
						attached code: {attachedCodeContext?.filePath ?? ""}
					</div>
					<textarea aria-label="Message Fabric Agent" />
					<button
						type="button"
						onClick={() => onConversationCreated?.("conv_1")}
					>
						start conversation
					</button>
					<button
						type="button"
						onClick={() => onStreamingChange?.(true)}
					>
						start streaming
					</button>
					<button type="button" onClick={() => onProjectRemove?.()}>
						remove project
					</button>
					<div data-testid="picker-catalog">
						{agentPickerCatalog ?? ""}
					</div>
					<div data-testid="chat-conversation-id">
						{activeConversationId ?? ""}
					</div>
					<div data-testid="chat-conversation">
						{activeConversation?.id ?? ""}
					</div>
				</div>
			);
		};
	}

	const MockDirectChat = mockChat("direct");
	const MockOrchestratorChat = mockChat("orchestrator");

	/** The history list: one button per kind of session the tests open. */
	function MockHistory({
		onSelect,
		onDeleted,
		onBack,
	}: {
		onSelect: (session: Record<string, unknown>) => void;
		onDeleted: (id: string) => void;
		onBack: () => void;
	}) {
		const session = (id: string, title: string, mode: string | null) => ({
			id,
			title,
			metadata: mode ? { mode } : null,
			isOwn: true,
		});
		return (
			<div data-testid="mock-history">
				<button
					type="button"
					onClick={() =>
						onSelect(
							session(
								"conv_orch",
								"Quarterly plan",
								"orchestrator",
							),
						)
					}
				>
					open orchestrator session
				</button>
				<button
					type="button"
					onClick={() =>
						onSelect(
							session("conv_direct", "Debug notes", "direct"),
						)
					}
				>
					open direct session
				</button>
				<button
					type="button"
					onClick={() =>
						onSelect(
							session("conv_research", "Market scan", "research"),
						)
					}
				>
					open research session
				</button>
				<button type="button" onClick={() => onDeleted("conv_orch")}>
					delete orchestrator session
				</button>
				<button type="button" onClick={onBack}>
					back to chat
				</button>
			</div>
		);
	}

	function MockSharedSession({
		conversation,
		engine,
		onContinue,
	}: {
		conversation: { title: string | null };
		engine: string;
		onContinue: (chat: {
			id: string;
			title: string | null;
			engine: string;
		}) => void;
	}) {
		return (
			<div data-testid="shared-session" data-engine={engine}>
				<span>{conversation.title}</span>
				<button
					type="button"
					onClick={() =>
						onContinue({ id: "conv_mine", title: "Mine", engine })
					}
				>
					continue in my own chat
				</button>
			</div>
		);
	}

	return {
		default: (loader: () => unknown) => {
			const source = String(loader);
			if (source.includes("LauncherSessionHistory")) {
				return MockHistory;
			}
			if (source.includes("SharedSessionView")) {
				return MockSharedSession;
			}
			return source.includes("FabricTemporalOrchestratorChat")
				? MockOrchestratorChat
				: MockDirectChat;
		},
	};
});

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "example-org",
		basePath: "/app",
	}),
}));

afterEach(() => {
	cleanup();
	conversationDetail.current = undefined;
	conversationDetail.loading = false;
	conversationDetail.failed = false;
	storedPreferences.current = undefined;
	storedAgentSelection.current = undefined;
	vi.clearAllMocks();
});

function preferences(
	overrides: Partial<NonNullable<typeof storedPreferences.current>>,
) {
	return {
		uiMode: "simple" as const,
		chatMode: "orchestrator" as const,
		reasoningMode: "balanced" as const,
		enabledMcpConfigIds: [],
		...overrides,
	};
}

function openBareDrawer() {
	const view = render(
		<FabricAgentLauncherProvider>
			<div>page content</div>
		</FabricAgentLauncherProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: /Fabric Agent/i }));
	return view;
}

function drawerEngine() {
	return screen.getByTestId("drawer-chat").getAttribute("data-engine");
}

function expectLauncherOpen() {
	expect(screen.getByLabelText("Fabric Agent")).toHaveAttribute(
		"aria-hidden",
		"false",
	);
}

function expectLauncherClosed() {
	expect(screen.getByLabelText("Fabric Agent")).toHaveAttribute(
		"aria-hidden",
		"true",
	);
}

function LauncherHarness() {
	const { openLauncher } = useFabricAgentLauncher();

	return (
		<div>
			<button
				type="button"
				onClick={() =>
					openLauncher({
						projectId: "project_1",
						projectName: "Phoenix",
						storyId: "story_1",
						storyIdentifier: "US-1",
						storyTitle: "Ship the launcher",
						taskId: "task_1",
						taskIdentifier: "TASK-1",
						taskTitle: "Wire shortcut",
						prompt: "Review the launcher context.",
					})
				}
			>
				Open with context
			</button>
			<button
				type="button"
				onClick={() =>
					openLauncher({
						projectId: "project_1",
						projectName: "Phoenix",
						prompt: "Help me understand this module.",
						repositoryUrl: "https://github.com/acme/fabric",
						repositoryOwner: "acme",
						repositoryName: "fabric",
						codeContext: {
							filePath:
								"apps/web/modules/saas/agents/components/FabricAgentLauncher.tsx",
							lineStart: 42,
							lineEnd: 66,
							branch: "main",
							snippet:
								"export function example() { return true; }",
						},
					})
				}
			>
				Open with code context
			</button>
		</div>
	);
}

function AmbientContextHarness() {
	useRegisterFabricAgentContext({
		projectId: "ambient_project",
		projectName: "Ambient Phoenix",
		storyId: "ambient_story",
		storyIdentifier: "US-ambient",
		storyTitle: "Investigate ambient context",
		taskId: "ambient_task",
		taskIdentifier: "TASK-ambient",
		taskTitle: "Open launcher from anywhere",
		prompt: "Use the current workspace context.",
	});

	return <div>ambient context ready</div>;
}

/** A page that is a surface of agent-written pages registers where it is. */
function SurfaceContextHarness({
	surface,
	workspaceId,
}: {
	surface: "artifact" | "workspace";
	workspaceId?: string;
}) {
	useRegisterFabricAgentContext({
		projectId: "surface_project",
		projectName: "Surface Phoenix",
		surface,
		workspaceId,
	});

	return <div>surface context ready</div>;
}

/** Empties the drawer's context the way the provider's API allows. */
function ClearContextButton() {
	const { clearContext } = useFabricAgentLauncher();
	return (
		<button type="button" onClick={clearContext}>
			clear launcher context
		</button>
	);
}

describe("FabricAgentLauncher", () => {
	it("loads the drawer on first open and keeps its chat mounted after closing", async () => {
		render(
			<FabricAgentLauncherProvider>
				<div>page content</div>
			</FabricAgentLauncherProvider>,
		);

		expect(screen.queryByLabelText("Fabric Agent")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /Fabric Agent/i }));
		const chat = await screen.findByTestId("drawer-chat");

		fireEvent.keyDown(document, { key: "j", ctrlKey: true });
		expectLauncherClosed();
		expect(screen.getByTestId("drawer-chat")).toBe(chat);

		fireEvent.click(screen.getByRole("button", { name: /Fabric Agent/i }));
		expectLauncherOpen();
		expect(screen.getByTestId("drawer-chat")).toBe(chat);
	});

	it("opens from the floating shell trigger", async () => {
		render(
			<FabricAgentLauncherProvider>
				<div>page content</div>
			</FabricAgentLauncherProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: /Fabric Agent/i }));

		expectLauncherOpen();
		expect(screen.getByText("Expand")).toBeInTheDocument();
		expect(
			await screen.findByText("mock orchestrator chat"),
		).toBeInTheDocument();
	});

	/**
	 * The panel's prepended prompt is the only place that describes the surface
	 * to the model, and it outranks nothing that follows it. Copy claiming the
	 * panel is toolless, or naming a surface the UI no longer has, comes back
	 * as an answer that refuses work it can do and sends the user somewhere
	 * that does not exist.
	 */
	it("does not tell the model it is toolless or send it to a retired surface", async () => {
		render(
			<FabricAgentLauncherProvider>
				<LauncherHarness />
			</FabricAgentLauncherProvider>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /Open with context/i }),
		);

		const prompt = (await screen.findByTestId("system-prompt")).textContent;

		expect(prompt).toBeTruthy();
		// #2040 merged Nexus, Loom Direct and Loom Orchestrator into one page;
		// "Loom" survives only as an internal workflow name.
		expect(prompt).not.toMatch(/Loom/i);
		expect(prompt).not.toMatch(/lightweight/i);
		// The escape hatch the panel actually has.
		expect(prompt).toContain("Expand");
	});

	/**
	 * The contextless turn is the one that used to fall through: with no
	 * project, story or code selection there were no details to describe, the
	 * builder returned nothing, and the model introduced itself with the
	 * direct-chat activity's own opening line — "You are Fabric Loom".
	 */
	it("still frames the surface when the drawer opens with no page context", async () => {
		render(
			<FabricAgentLauncherProvider>
				<div>page content</div>
			</FabricAgentLauncherProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: /Fabric Agent/i }));

		const prompt = (await screen.findByTestId("system-prompt")).textContent;

		expect(prompt).toContain("You are Fabric Agent");
		expect(prompt).not.toMatch(/Loom/i);
	});

	it("shows visible context chips and prefilled prompt for contextual launches", async () => {
		render(
			<FabricAgentLauncherProvider>
				<LauncherHarness />
			</FabricAgentLauncherProvider>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /Open with context/i }),
		);

		expectLauncherOpen();
		expect(
			await screen.findByText("mock orchestrator chat"),
		).toBeInTheDocument();
		expect(screen.getByText("Phoenix")).toBeInTheDocument();
		expect(
			screen.getByText("US-1 · Ship the launcher"),
		).toBeInTheDocument();
		expect(screen.getByText("TASK-1 · Wire shortcut")).toBeInTheDocument();
		expect(document.body).toHaveTextContent(
			"initial input: Review the launcher context.",
		);
		expect(document.body).toHaveTextContent("attached project: project_1");
	});

	it("shows repository/code context and richer quick actions for contextual code launches", async () => {
		render(
			<FabricAgentLauncherProvider>
				<LauncherHarness />
			</FabricAgentLauncherProvider>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /Open with code context/i }),
		);

		expectLauncherOpen();
		expect(
			await screen.findByText("mock orchestrator chat"),
		).toBeInTheDocument();
		expect(screen.getByText("acme/fabric")).toBeInTheDocument();
		expect(
			screen.getByText(
				"apps/web/modules/saas/agents/components/FabricAgentLauncher.tsx:42-66",
			),
		).toBeInTheDocument();
		// The orchestrator has no code-context field; the location, branch
		// and snippet reach it through the prepended context block.
		const prompt = screen.getByTestId("system-prompt").textContent ?? "";
		expect(prompt).toContain(
			"Code file: apps/web/modules/saas/agents/components/FabricAgentLauncher.tsx:42-66",
		);
		expect(prompt).toContain("Branch: main");
		expect(prompt).toContain("export function example()");
		expect(prompt).toContain(
			"Repository URL: https://github.com/acme/fabric",
		);
		expect(
			screen.getByRole("button", { name: /Trace dependencies/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Explain architecture/i }),
		).toBeInTheDocument();

		fireEvent.click(
			screen.getByRole("button", { name: /Trace dependencies/i }),
		);

		expect(document.body).toHaveTextContent("Repository: acme/fabric");
		expect(document.body).toHaveTextContent(
			"File: apps/web/modules/saas/agents/components/FabricAgentLauncher.tsx:42-66",
		);
		expect(document.body).toHaveTextContent(
			"Trace the main dependencies, imports, and downstream effects of this code:",
		);
	});

	it("opens from Cmd/Ctrl+J", async () => {
		render(
			<FabricAgentLauncherProvider>
				<div>page content</div>
			</FabricAgentLauncherProvider>,
		);

		fireEvent.keyDown(document, {
			key: "j",
			ctrlKey: true,
		});

		expectLauncherOpen();
		expect(
			await screen.findByText("mock orchestrator chat"),
		).toBeInTheDocument();
	});

	it("uses ambient workspace context when opened globally from the keyboard shortcut", async () => {
		render(
			<FabricAgentLauncherProvider>
				<AmbientContextHarness />
			</FabricAgentLauncherProvider>,
		);

		fireEvent.keyDown(document, {
			key: "j",
			ctrlKey: true,
		});

		expectLauncherOpen();
		expect(await screen.findByText("Ambient Phoenix")).toBeInTheDocument();
		expect(screen.getByText("Ambient Phoenix")).toBeInTheDocument();
		expect(
			screen.getByText("US-ambient · Investigate ambient context"),
		).toBeInTheDocument();
		expect(
			screen.getByText("TASK-ambient · Open launcher from anywhere"),
		).toBeInTheDocument();
		expect(document.body).not.toHaveTextContent(
			"Use the current workspace context.",
		);
	});

	it("tells the agent it was opened from a project's Artifacts tab, so 'here' needs no question", async () => {
		render(
			<FabricAgentLauncherProvider>
				<SurfaceContextHarness surface="artifact" />
			</FabricAgentLauncherProvider>,
		);

		fireEvent.keyDown(document, { key: "j", ctrlKey: true });

		const prompt = (await screen.findByTestId("system-prompt")).textContent;
		expect(prompt).toContain("Project: Surface Phoenix");
		expect(prompt).toContain("the project's Artifacts tab");
		expect(prompt).not.toContain("Workspace");
	});

	it("tells the agent which Workspace page it was opened from", async () => {
		render(
			<FabricAgentLauncherProvider>
				<SurfaceContextHarness
					surface="workspace"
					workspaceId="workspace_1"
				/>
			</FabricAgentLauncherProvider>,
		);

		fireEvent.keyDown(document, { key: "j", ctrlKey: true });

		const prompt = (await screen.findByTestId("system-prompt")).textContent;
		expect(prompt).toContain(
			"the organization Workspace the user has open",
		);
		expect(prompt).toContain("workspace id: workspace_1");
		expect(prompt).toContain("fabric_update_frame");
	});

	it("tells the agent a Workspaces list is where a new Workspace starts, not a Workspace to change", async () => {
		render(
			<FabricAgentLauncherProvider>
				<SurfaceContextHarness surface="workspace" />
			</FabricAgentLauncherProvider>,
		);

		fireEvent.keyDown(document, { key: "j", ctrlKey: true });

		const prompt = (await screen.findByTestId("system-prompt")).textContent;
		expect(prompt).toContain("the organization's Workspaces list");
		expect(prompt).not.toContain("workspace id");
		expect(prompt).not.toContain("fabric_update_frame");
	});

	it("retains the Artifact origin in the launch context", async () => {
		function Opener() {
			const { openLauncher, launchContext } = useFabricAgentLauncher();
			return (
				<button
					type="button"
					onClick={() =>
						openLauncher({
							surface: "artifact",
							launchFrameId: "frame-example",
							projectId: "project-example",
						})
					}
				>
					{launchContext?.launchFrameId ?? "open artifact"}
				</button>
			);
		}
		render(
			<FabricAgentLauncherProvider>
				<Opener />
			</FabricAgentLauncherProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "open artifact" }));
		expect(
			await screen.findByRole("button", { name: "frame-example" }),
		).toBeInTheDocument();
	});

	it("keeps the surface and Workspace of an explicit launch", async () => {
		function Opener() {
			const { openLauncher } = useFabricAgentLauncher();
			return (
				<button
					type="button"
					onClick={() =>
						openLauncher({
							surface: "workspace",
							workspaceId: "workspace_2",
							prompt: "Add a refresh button.",
						})
					}
				>
					open from workspace
				</button>
			);
		}
		render(
			<FabricAgentLauncherProvider>
				<Opener />
			</FabricAgentLauncherProvider>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "open from workspace" }),
		);

		const prompt = (await screen.findByTestId("system-prompt")).textContent;
		expect(prompt).toContain("workspace id: workspace_2");
		expect(document.body).toHaveTextContent(
			"initial input: Add a refresh button.",
		);
	});

	it("does not open from Cmd/Ctrl+J while typing in an input", () => {
		render(
			<FabricAgentLauncherProvider>
				<input aria-label="Title" />
			</FabricAgentLauncherProvider>,
		);

		const input = screen.getByRole("textbox", { name: /Title/i });
		input.focus();

		fireEvent.keyDown(input, {
			key: "j",
			ctrlKey: true,
			bubbles: true,
		});

		expect(screen.queryByLabelText("Fabric Agent")).not.toBeInTheDocument();
	});
});

describe("FabricAgentLauncher — project name in the header (F46)", () => {
	function IdOnlyHarness() {
		const { openLauncher } = useFabricAgentLauncher();
		return (
			<button
				type="button"
				onClick={() => openLauncher({ projectId: "cmraw0project0id" })}
			>
				Open with project id
			</button>
		);
	}

	afterEach(() => {
		projectLookup.current = undefined;
	});

	it("never shows the raw project id while the name loads", () => {
		render(
			<FabricAgentLauncherProvider>
				<IdOnlyHarness />
			</FabricAgentLauncherProvider>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /Open with project id/i }),
		);

		expect(screen.queryByText("cmraw0project0id")).not.toBeInTheDocument();
		expect(screen.getByText("Project")).toBeInTheDocument();
	});

	it("shows the project's name once it is fetched", () => {
		projectLookup.current = { project: { name: "Phoenix" } };
		render(
			<FabricAgentLauncherProvider>
				<IdOnlyHarness />
			</FabricAgentLauncherProvider>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /Open with project id/i }),
		);

		expect(screen.getByText("Phoenix")).toBeInTheDocument();
		expect(screen.queryByText("cmraw0project0id")).not.toBeInTheDocument();
	});
});

describe("FabricAgentLauncher — engine selection (#2040)", () => {
	it("runs a simple-mode drawer chat on the orchestrator's iterative preset", () => {
		storedPreferences.current = preferences({
			uiMode: "simple",
			reasoningMode: "deep",
			enabledMcpConfigIds: ["mcp_1", "mcp_2"],
		});

		openBareDrawer();

		expect(drawerEngine()).toBe("orchestrator");
		expect(screen.getByTestId("execution-mode")).toHaveTextContent(
			"iterative",
		);
		// The user's own reasoning mode, not the old hardcoded "balanced".
		expect(screen.getByTestId("reasoning-mode")).toHaveTextContent("deep");
		// The stored MCP selection becomes the orchestrator's tool filter.
		expect(screen.getByTestId("mcp-ids")).toHaveTextContent("mcp_1,mcp_2");
		expect(screen.getByTestId("compact")).toHaveTextContent("true");
		expect(screen.getByTestId("telemetry-surface")).toHaveTextContent(
			"fabric-agent-launcher",
		);
	});

	it("follows the saved engine choice in advanced mode", () => {
		storedPreferences.current = preferences({
			uiMode: "advanced",
			chatMode: "direct",
			reasoningMode: "lite",
		});

		openBareDrawer();

		expect(drawerEngine()).toBe("direct");
		expect(screen.getByTestId("reasoning-mode")).toHaveTextContent("lite");
	});

	it("runs advanced orchestrator chats on the user's reasoning mode, not the simple preset", () => {
		storedPreferences.current = preferences({
			uiMode: "advanced",
			chatMode: "orchestrator",
			reasoningMode: "planner",
		});

		openBareDrawer();

		expect(drawerEngine()).toBe("orchestrator");
		expect(screen.getByTestId("execution-mode")).toHaveTextContent("");
		expect(screen.getByTestId("reasoning-mode")).toHaveTextContent(
			"planner",
		);
	});

	it("runs a saved Research choice on the orchestrator, since the drawer has no Research surface", () => {
		storedPreferences.current = preferences({
			uiMode: "advanced",
			chatMode: "research",
		});

		openBareDrawer();

		expect(drawerEngine()).toBe("orchestrator");
	});

	it("keeps an open Direct conversation on Direct when the mode switches to simple", () => {
		storedPreferences.current = preferences({
			uiMode: "advanced",
			chatMode: "direct",
		});
		const { rerender } = openBareDrawer();
		fireEvent.click(
			screen.getByRole("button", { name: "start conversation" }),
		);

		storedPreferences.current = preferences({ uiMode: "simple" });
		rerender(
			<FabricAgentLauncherProvider>
				<div>page content</div>
			</FabricAgentLauncherProvider>,
		);

		expect(drawerEngine()).toBe("direct");

		// A fresh chat is free to take the current mode's engine.
		fireEvent.click(
			screen.getByRole("button", { name: "Reset conversation" }),
		);
		expect(drawerEngine()).toBe("orchestrator");
	});

	it("switches engines with the mode while no conversation has started", () => {
		storedPreferences.current = preferences({
			uiMode: "advanced",
			chatMode: "direct",
		});
		const { rerender } = openBareDrawer();
		expect(drawerEngine()).toBe("direct");

		storedPreferences.current = preferences({ uiMode: "simple" });
		rerender(
			<FabricAgentLauncherProvider>
				<div>page content</div>
			</FabricAgentLauncherProvider>,
		);

		expect(drawerEngine()).toBe("orchestrator");
	});

	it("prefills the orchestrator composer from a quick-action chip", () => {
		render(
			<FabricAgentLauncherProvider>
				<LauncherHarness />
			</FabricAgentLauncherProvider>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /Open with context/i }),
		);

		fireEvent.click(screen.getByRole("button", { name: /Catch me up/i }));

		expect(drawerEngine()).toBe("orchestrator");
		expect(document.body).toHaveTextContent(
			"initial input: Catch me up on this project.",
		);
		expect(document.body).toHaveTextContent("- Project: Phoenix");
	});

	it("gives the orchestrator the feature and task ids it has no field for", () => {
		render(
			<FabricAgentLauncherProvider>
				<LauncherHarness />
			</FabricAgentLauncherProvider>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /Open with context/i }),
		);

		const prompt = screen.getByTestId("system-prompt").textContent ?? "";
		expect(prompt).toContain(
			"Feature: US-1 · Ship the launcher (feature id: story_1)",
		);
		expect(prompt).toContain(
			"Task: TASK-1 · Wire shortcut (task id: task_1)",
		);
		expect(document.body).toHaveTextContent("attached project: project_1");
	});

	/**
	 * The prompt is prepended to the engine's own instructions. A claim about
	 * what the panel cannot run contradicts the orchestrator it now runs on.
	 */
	it("makes no claim about what the drawer can or cannot run", () => {
		openBareDrawer();

		const prompt = screen.getByTestId("system-prompt").textContent ?? "";
		expect(prompt).not.toMatch(/orchestration/i);
		expect(prompt).not.toMatch(/does not run/i);
		expect(prompt).not.toMatch(/reasoning modes/i);
	});

	describe("interface mode control (#2040)", () => {
		function modeButton(name: "Simple" | "Advanced") {
			return within(
				screen.getByRole("group", { name: "Interface mode" }),
			).getByRole("button", { name: new RegExp(`^${name}$`, "i") });
		}

		it("shows the stored mode and writes a switch to the shared cache and the server", () => {
			storedPreferences.current = preferences({ uiMode: "simple" });
			openBareDrawer();

			expect(modeButton("Simple")).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			fireEvent.click(modeButton("Advanced"));

			expect(
				orpcClientMock.users.orchestratorPreferences.update,
			).toHaveBeenCalledWith({
				uiMode: "advanced",
				organizationId: "example-org",
			});
			const [key, updater] = queryClientMock.setQueryData.mock
				.calls[0] as [unknown, (previous: unknown) => unknown];
			expect(key).toEqual(["orchestrator-preferences", "example-org"]);
			expect(updater(preferences({ uiMode: "simple" }))).toMatchObject({
				uiMode: "advanced",
			});
		});

		it("is held while a turn streams", () => {
			storedPreferences.current = preferences({ uiMode: "simple" });
			openBareDrawer();

			fireEvent.click(
				screen.getByRole("button", { name: "start streaming" }),
			);

			expect(modeButton("Advanced")).toBeDisabled();
			fireEvent.click(modeButton("Advanced"));
			expect(
				orpcClientMock.users.orchestratorPreferences.update,
			).not.toHaveBeenCalled();
		});

		it("keeps an open conversation on its engine when the mode changes", () => {
			storedPreferences.current = preferences({
				uiMode: "advanced",
				chatMode: "direct",
			});
			const view = openBareDrawer();
			expect(drawerEngine()).toBe("direct");
			fireEvent.click(
				screen.getByRole("button", { name: "start conversation" }),
			);

			storedPreferences.current = preferences({ uiMode: "simple" });
			view.rerender(
				<FabricAgentLauncherProvider>
					<div>page content</div>
				</FabricAgentLauncherProvider>,
			);

			expect(modeButton("Simple")).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			expect(drawerEngine()).toBe("direct");
		});
	});

	it("drops only the project when the user removes it, keeping the chat", () => {
		render(
			<FabricAgentLauncherProvider>
				<LauncherHarness />
			</FabricAgentLauncherProvider>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /Open with context/i }),
		);
		expect(document.body).toHaveTextContent("attached project: project_1");
		const chatBefore = screen.getByTestId("drawer-chat");

		fireEvent.click(screen.getByRole("button", { name: "remove project" }));

		expect(document.body).not.toHaveTextContent(
			"attached project: project_1",
		);
		expect(screen.getByTestId("system-prompt").textContent).not.toContain(
			"Project: Phoenix",
		);
		// Same chat instance: the conversation was not reset.
		expect(screen.getByTestId("drawer-chat")).toBe(chatBefore);
		expect(screen.getByTestId("system-prompt").textContent).toContain(
			"Feature: US-1",
		);
	});

	describe("reset keeps the project (#2928)", () => {
		function openWithContext() {
			render(
				<FabricAgentLauncherProvider>
					<LauncherHarness />
				</FabricAgentLauncherProvider>,
			);
			fireEvent.click(
				screen.getByRole("button", { name: /Open with context/i }),
			);
		}

		it("starts a fresh chat on the same project, dropping the rest", () => {
			openWithContext();
			const chatBefore = screen.getByTestId("drawer-chat");

			fireEvent.click(
				screen.getByRole("button", { name: "Reset conversation" }),
			);

			const chatAfter = screen.getByTestId("drawer-chat");
			expect(chatAfter).not.toBe(chatBefore);
			expect(document.body).toHaveTextContent(
				"attached project: project_1",
			);
			const systemPrompt =
				screen.getByTestId("system-prompt").textContent;
			expect(systemPrompt).toContain("Project: Phoenix");
			expect(systemPrompt).not.toContain("Feature: US-1");
			expect(document.body).not.toHaveTextContent(
				"Review the launcher context.",
			);
		});

		it("still drops the project from the context chip's clear button", () => {
			openWithContext();

			fireEvent.click(
				screen.getByRole("button", { name: "Clear context" }),
			);

			expect(document.body).not.toHaveTextContent(
				"attached project: project_1",
			);
		});

		it("does not bring back a project the user removed", () => {
			// The page has a project too, so neither may come back.
			render(
				<FabricAgentLauncherProvider>
					<AmbientContextHarness />
					<LauncherHarness />
				</FabricAgentLauncherProvider>,
			);
			fireEvent.click(
				screen.getByRole("button", { name: /Open with context/i }),
			);
			fireEvent.click(
				screen.getByRole("button", { name: "remove project" }),
			);

			fireEvent.click(
				screen.getByRole("button", { name: "Reset conversation" }),
			);

			const expectNoProject = () => {
				expect(document.body).not.toHaveTextContent(
					"attached project: project_1",
				);
				expect(document.body).not.toHaveTextContent(
					"attached project: ambient_project",
				);
			};
			expectNoProject();

			// A bare reopen fills only a `null` context from the page.
			fireEvent.keyDown(document, { key: "j", ctrlKey: true });
			expectLauncherClosed();
			fireEvent.keyDown(document, { key: "j", ctrlKey: true });
			expectLauncherOpen();
			expectNoProject();

			fireEvent.click(screen.getByRole("button", { name: "Close" }));
			fireEvent.click(
				screen.getByRole("button", { name: /Open Fabric Agent/i }),
			);
			expectLauncherOpen();
			expectNoProject();
		});

		it("takes the page's project when the drawer holds no context", () => {
			render(
				<FabricAgentLauncherProvider>
					<AmbientContextHarness />
					<ClearContextButton />
				</FabricAgentLauncherProvider>,
			);
			fireEvent.keyDown(document, { key: "j", ctrlKey: true });
			fireEvent.click(
				screen.getByRole("button", { name: "clear launcher context" }),
			);
			expect(document.body).not.toHaveTextContent(
				"attached project: ambient_project",
			);

			fireEvent.click(
				screen.getByRole("button", { name: "Reset conversation" }),
			);

			expect(document.body).toHaveTextContent(
				"attached project: ambient_project",
			);
		});
	});

	it("lists models only in simple mode and the full catalog in advanced", () => {
		storedPreferences.current = preferences({ uiMode: "simple" });
		const view = openBareDrawer();
		expect(screen.getByTestId("picker-catalog")).toHaveTextContent(
			"models",
		);

		storedPreferences.current = preferences({ uiMode: "advanced" });
		view.rerender(
			<FabricAgentLauncherProvider>
				<div>page content</div>
			</FabricAgentLauncherProvider>,
		);
		expect(screen.getByTestId("picker-catalog")).toHaveTextContent("all");
	});

	describe("saved agent no longer available (FR13)", () => {
		it("tells the user once the drawer opens, whichever engine it runs", () => {
			storedPreferences.current = preferences({ uiMode: "simple" });
			storedAgentSelection.current = {
				selectedAgents: [],
				defaultAgent: { agentId: "model:default", name: "Default" },
				droppedCount: 1,
			};
			render(
				<FabricAgentLauncherProvider>
					<div>page content</div>
				</FabricAgentLauncherProvider>,
			);
			expect(toastMock.message).not.toHaveBeenCalled();

			fireEvent.click(
				screen.getByRole("button", { name: /Fabric Agent/i }),
			);

			expect(drawerEngine()).toBe("orchestrator");
			expect(toastMock.message).toHaveBeenCalledTimes(1);
			expect(toastMock.message).toHaveBeenCalledWith(
				"Your saved agent is no longer available.",
				expect.objectContaining({
					id: "saved-agent-unavailable",
					description: "Using Default for this chat.",
				}),
			);
		});

		it("stays quiet when nothing was dropped", () => {
			storedAgentSelection.current = {
				selectedAgents: [],
				defaultAgent: null,
				droppedCount: 0,
			};
			openBareDrawer();

			expect(toastMock.message).not.toHaveBeenCalled();
		});
	});
});

describe("FabricAgentLauncher — conversation history", () => {
	const ownSession = (id: string, title: string, mode: string) => ({
		id,
		title,
		isOwn: true,
		messages: [],
		metadata: { mode },
	});

	function openHistory() {
		fireEvent.click(
			screen.getByRole("button", { name: "Conversation history" }),
		);
	}

	async function reopen(label: string) {
		openHistory();
		fireEvent.click(await screen.findByText(label));
	}

	it("opens the history from the header and returns to the chat, which stays mounted", async () => {
		openBareDrawer();
		const chat = screen.getByTestId("drawer-chat");

		openHistory();

		expect(await screen.findByTestId("mock-history")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Conversation history" }),
		).toHaveAttribute("aria-pressed", "true");
		expect(chat).toBeInTheDocument();
		expect(chat.parentElement).toHaveAttribute("hidden");
		fireEvent.click(screen.getByText("back to chat"));

		expect(screen.queryByTestId("mock-history")).toBeNull();
		expect(screen.getByTestId("drawer-chat")).toBe(chat);
		expect(chat.parentElement).not.toHaveAttribute("hidden");
	});

	it("puts focus back on the history button when the history is left by Back to chat", async () => {
		openBareDrawer();
		openHistory();
		await screen.findByTestId("mock-history");

		fireEvent.click(screen.getByText("back to chat"));

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Conversation history" }),
			).toHaveFocus(),
		);
	});

	it("puts focus in the chat's input once a conversation chosen from the history is showing", async () => {
		conversationDetail.current = ownSession(
			"conv_orch",
			"Quarterly plan",
			"orchestrator",
		);
		openBareDrawer();

		await reopen("open orchestrator session");

		await waitFor(() =>
			expect(
				screen.getByRole("textbox", { name: "Message Fabric Agent" }),
			).toHaveFocus(),
		);
	});

	it("waits for the chat to be there before focusing its input, when the conversation is still loading", async () => {
		conversationDetail.loading = true;
		const view = openBareDrawer();
		await reopen("open orchestrator session");
		expect(screen.queryByRole("textbox")).toBeNull();

		conversationDetail.loading = false;
		conversationDetail.current = ownSession(
			"conv_orch",
			"Quarterly plan",
			"orchestrator",
		);
		view.rerender(
			<FabricAgentLauncherProvider>
				<div>page content</div>
			</FabricAgentLauncherProvider>,
		);

		await waitFor(() =>
			expect(
				screen.getByRole("textbox", { name: "Message Fabric Agent" }),
			).toHaveFocus(),
		);
	});

	it("moves nothing when the history is closed with its own button", async () => {
		openBareDrawer();
		openHistory();
		await screen.findByTestId("mock-history");
		const toggle = screen.getByRole("button", {
			name: "Conversation history",
		});
		toggle.focus();

		fireEvent.click(toggle);

		expect(toggle).toHaveFocus();
	});

	it("reopens an Orchestrator session on the Orchestrator, with its id and conversation", async () => {
		storedPreferences.current = preferences({
			uiMode: "advanced",
			chatMode: "direct",
		});
		conversationDetail.current = ownSession(
			"conv_orch",
			"Quarterly plan",
			"orchestrator",
		);
		openBareDrawer();
		expect(drawerEngine()).toBe("direct");

		await reopen("open orchestrator session");

		expect(drawerEngine()).toBe("orchestrator");
		expect(screen.getByTestId("chat-conversation-id")).toHaveTextContent(
			"conv_orch",
		);
		expect(screen.getByTestId("chat-conversation")).toHaveTextContent(
			"conv_orch",
		);
		expect(screen.queryByTestId("mock-history")).toBeNull();
	});

	it("reopens a Direct session on Direct even where a new chat would run the Orchestrator", async () => {
		storedPreferences.current = preferences({ uiMode: "simple" });
		conversationDetail.current = ownSession(
			"conv_direct",
			"Debug notes",
			"direct",
		);
		openBareDrawer();
		expect(drawerEngine()).toBe("orchestrator");

		await reopen("open direct session");

		expect(drawerEngine()).toBe("direct");
	});

	it("says a reopened Direct chat stays on Direct in simple mode, and New chat starts a fresh one", async () => {
		storedPreferences.current = preferences({ uiMode: "simple" });
		conversationDetail.current = ownSession(
			"conv_direct",
			"Debug notes",
			"direct",
		);
		openBareDrawer();
		expect(screen.queryByTestId("engine-mismatch-notice")).toBeNull();

		await reopen("open direct session");

		const notice = screen.getByRole("status");
		expect(notice).toBe(screen.getByTestId("engine-mismatch-notice"));
		expect(notice).toHaveTextContent(
			"This chat uses Direct chat, which it was started on. Start a new chat to use the Advisor.",
		);
		expect(drawerEngine()).toBe("direct");

		fireEvent.click(screen.getByRole("button", { name: "New chat" }));

		expect(screen.queryByTestId("engine-mismatch-notice")).toBeNull();
		expect(drawerEngine()).toBe("orchestrator");
	});

	it("adds no engine notice for an orchestrator conversation in simple mode", async () => {
		storedPreferences.current = preferences({ uiMode: "simple" });
		conversationDetail.current = ownSession(
			"conv_orch",
			"Quarterly plan",
			"orchestrator",
		);
		openBareDrawer();

		await reopen("open orchestrator session");

		expect(drawerEngine()).toBe("orchestrator");
		expect(screen.queryByTestId("engine-mismatch-notice")).toBeNull();
	});

	it("adds no engine notice for a Direct conversation in advanced mode", async () => {
		storedPreferences.current = preferences({
			uiMode: "advanced",
			chatMode: "orchestrator",
		});
		conversationDetail.current = ownSession(
			"conv_direct",
			"Debug notes",
			"direct",
		);
		openBareDrawer();

		await reopen("open direct session");

		expect(drawerEngine()).toBe("direct");
		expect(screen.queryByTestId("engine-mismatch-notice")).toBeNull();
	});

	it("reopens a Research session on Direct, since the drawer has no Research surface", async () => {
		storedPreferences.current = preferences({
			uiMode: "advanced",
			chatMode: "research",
		});
		conversationDetail.current = ownSession(
			"conv_research",
			"Market scan",
			"research",
		);
		openBareDrawer();

		await reopen("open research session");

		expect(drawerEngine()).toBe("direct");
	});

	it("starts the chat over for the session it reopens, rather than carrying the last one in", async () => {
		storedPreferences.current = preferences({ uiMode: "simple" });
		conversationDetail.current = ownSession(
			"conv_orch",
			"Quarterly plan",
			"orchestrator",
		);
		openBareDrawer();
		const before = screen.getByTestId("drawer-chat");

		await reopen("open orchestrator session");

		expect(screen.getByTestId("drawer-chat")).not.toBe(before);
	});

	it("says that the conversation continues with the context of the page the drawer is on now", async () => {
		conversationDetail.current = ownSession(
			"conv_orch",
			"Quarterly plan",
			"orchestrator",
		);
		openBareDrawer();
		expect(screen.queryByTestId("resumed-session-note")).toBeNull();

		await reopen("open orchestrator session");

		const note = screen.getByTestId("resumed-session-note");
		expect(note).toHaveTextContent("Quarterly plan");
		expect(note).toHaveTextContent(
			"This conversation continues with the context of the page you are on now.",
		);
	});

	it("carries the reopened session to the full page on Expand", async () => {
		conversationDetail.current = ownSession(
			"conv_orch",
			"Quarterly plan",
			"orchestrator",
		);
		openBareDrawer();

		await reopen("open orchestrator session");

		expect(screen.getByRole("link", { name: "Expand" })).toHaveAttribute(
			"href",
			"/app/agents/fabric-ai?c=conv_orch",
		);
	});

	it("does not reopen a session while a reply is being written, and says why", async () => {
		openBareDrawer();
		fireEvent.click(
			screen.getByRole("button", { name: "start streaming" }),
		);
		const chat = screen.getByTestId("drawer-chat");

		await reopen("open orchestrator session");

		expect(toastMock.message).toHaveBeenCalledWith(
			"Wait for the reply to finish",
			expect.objectContaining({ description: expect.any(String) }),
		);
		expect(screen.getByTestId("mock-history")).toBeInTheDocument();
		expect(chat).toBeInTheDocument();
		expect(screen.queryByTestId("resumed-session-note")).toBeNull();
	});

	it("waits for the session to load before showing a chat", async () => {
		conversationDetail.loading = true;
		openBareDrawer();

		await reopen("open orchestrator session");

		expect(screen.queryByTestId("drawer-chat")).toBeNull();
		expect(screen.getByText(/Loading Fabric Agent/)).toBeInTheDocument();
	});

	it("says so, and offers a new chat, when the conversation is gone", async () => {
		conversationDetail.current = null;
		openBareDrawer();

		await reopen("open orchestrator session");

		expect(screen.getByRole("alert")).toHaveTextContent(
			"That conversation is no longer available.",
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Start a new chat" }),
		);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByTestId("chat-conversation-id")).toHaveTextContent(
			"",
		);
	});

	it("says it could not be loaded, which is not that it is gone, and offers to try again", async () => {
		conversationDetail.failed = true;
		openBareDrawer();

		await reopen("open orchestrator session");

		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("Could not load this conversation.");
		expect(alert).not.toHaveTextContent(/no longer available/);
		expect(screen.queryByTestId("drawer-chat")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(conversationDetail.refetch).toHaveBeenCalledTimes(1);
	});

	it("keeps the chat when a refresh of the open conversation fails after it was loaded", async () => {
		conversationDetail.current = ownSession(
			"conv_orch",
			"Quarterly plan",
			"orchestrator",
		);
		openBareDrawer();
		await reopen("open orchestrator session");
		const chat = screen.getByTestId("drawer-chat");

		conversationDetail.failed = true;
		fireEvent.click(
			screen.getByRole("button", { name: "start conversation" }),
		);

		expect(screen.getByTestId("drawer-chat")).toBe(chat);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("shows a session someone else shared read-only, with no chat in its place", async () => {
		conversationDetail.current = {
			...ownSession("conv_orch", "Their notes", "orchestrator"),
			isOwn: false,
		};
		openBareDrawer();

		await reopen("open orchestrator session");

		expect(screen.getByTestId("shared-session")).toHaveTextContent(
			"Their notes",
		);
		expect(screen.queryByTestId("drawer-chat")).toBeNull();
		expect(screen.queryByTestId("resumed-session-note")).toBeNull();
	});

	it("opens the reader's own chat when they continue from a shared conversation", async () => {
		conversationDetail.current = {
			...ownSession("conv_orch", "Their notes", "orchestrator"),
			isOwn: false,
		};
		openBareDrawer();
		await reopen("open orchestrator session");
		conversationDetail.current = ownSession("conv_mine", "Mine", "direct");

		fireEvent.click(screen.getByText("continue in my own chat"));

		expect(screen.queryByTestId("shared-session")).toBeNull();
		expect(screen.getByTestId("chat-conversation-id")).toHaveTextContent(
			"conv_mine",
		);
	});

	it.each([
		["simple", "orchestrator", "orchestrator"],
		["advanced", "orchestrator", "orchestrator"],
		["advanced", "direct", "direct"],
		["advanced", "research", "orchestrator"],
	] as const)(
		"offers the %s-mode reader (saved engine %s) a chat on %s, not on the engine the owner used",
		async (uiMode, chatMode, expected) => {
			storedPreferences.current = preferences({ uiMode, chatMode });
			conversationDetail.current = {
				...ownSession(
					"conv_theirs",
					"Their notes",
					expected === "direct" ? "orchestrator" : "direct",
				),
				isOwn: false,
			};
			openBareDrawer();
			await reopen("open orchestrator session");

			expect(screen.getByTestId("shared-session")).toHaveAttribute(
				"data-engine",
				expected,
			);
		},
	);

	it("runs the chat continued from a shared conversation on the reader's engine, not on Direct", async () => {
		storedPreferences.current = preferences({
			uiMode: "advanced",
			chatMode: "orchestrator",
		});
		conversationDetail.current = {
			...ownSession("conv_theirs", "Their notes", "direct"),
			isOwn: false,
		};
		openBareDrawer();
		await reopen("open direct session");
		conversationDetail.current = {
			id: "conv_mine",
			title: "Mine",
			isOwn: true,
			messages: [],
			metadata: null,
		};

		fireEvent.click(screen.getByText("continue in my own chat"));

		expect(drawerEngine()).toBe("orchestrator");
		expect(screen.getByTestId("chat-conversation-id")).toHaveTextContent(
			"conv_mine",
		);
	});

	it("runs it on Direct when that is the reader's engine, whatever the owner used", async () => {
		storedPreferences.current = preferences({
			uiMode: "advanced",
			chatMode: "direct",
		});
		conversationDetail.current = {
			...ownSession("conv_theirs", "Their notes", "orchestrator"),
			isOwn: false,
		};
		openBareDrawer();
		await reopen("open orchestrator session");
		conversationDetail.current = {
			id: "conv_mine",
			title: "Mine",
			isOwn: true,
			messages: [],
			metadata: null,
		};

		fireEvent.click(screen.getByText("continue in my own chat"));

		expect(drawerEngine()).toBe("direct");
	});

	it("starts a fresh chat when the open session is deleted from the history", async () => {
		conversationDetail.current = ownSession(
			"conv_orch",
			"Quarterly plan",
			"orchestrator",
		);
		openBareDrawer();
		await reopen("open orchestrator session");
		expect(screen.getByTestId("chat-conversation-id")).toHaveTextContent(
			"conv_orch",
		);

		openHistory();
		fireEvent.click(await screen.findByText("delete orchestrator session"));

		expect(screen.getByTestId("chat-conversation-id")).toHaveTextContent(
			"",
		);
		expect(screen.queryByTestId("resumed-session-note")).toBeNull();
	});

	it("keeps a new chat's behaviour: no conversation is handed to a chat that was not reopened", () => {
		openBareDrawer();

		expect(screen.getByTestId("chat-conversation-id")).toHaveTextContent(
			"",
		);
		expect(screen.getByTestId("chat-conversation")).toHaveTextContent("");
	});
});
