import {
	cleanup,
	fireEvent,
	render,
	screen,
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
		useQuery: vi.fn((options: { queryKey?: unknown[] }) => ({
			data:
				options?.queryKey?.[0] === "orchestrator-preferences"
					? storedPreferences.current
					: options?.queryKey?.[0] === "chat-agent-selection"
						? storedAgentSelection.current
						: undefined,
			isLoading: false,
		})),
		// The drawer invalidates the conversation cache when a turn it started
		// finishes, so the full page picks it up after an expand (#2040).
		useQueryClient: vi.fn(() => queryClientMock),
	};
});

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
				</div>
			);
		};
	}

	const MockDirectChat = mockChat("direct");
	const MockOrchestratorChat = mockChat("orchestrator");

	return {
		default: (loader: () => unknown) =>
			String(loader).includes("FabricTemporalOrchestratorChat")
				? MockOrchestratorChat
				: MockDirectChat,
	};
});

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		basePath: "/app",
	}),
}));

afterEach(() => {
	cleanup();
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

describe("FabricAgentLauncher", () => {
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
		expect(document.body).toHaveTextContent(
			"initial input: Use the current workspace context.",
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

		expectLauncherClosed();
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
			).toHaveBeenCalledWith({ uiMode: "advanced" });
			const [key, updater] = queryClientMock.setQueryData.mock
				.calls[0] as [unknown, (previous: unknown) => unknown];
			expect(key).toEqual(["orchestrator-preferences", null]);
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
