/** Live and hydrated stop cards use the latest terminal turn. */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamState = vi.hoisted(() => {
	const invalidate = vi.fn();
	return {
		current: {} as Record<string, unknown>,
		invalidate,
		queryClient: { invalidateQueries: invalidate },
	};
});

const BUDGET_STOP = {
	kind: "token_allowance",
	allowance: 500_000,
	measured: 476_000,
	outstanding: 0,
	enforcement: "ENFORCED",
	stopReason: "allowance_exhausted",
};

function streamAt(status: string, budgetStop: unknown) {
	return {
		messages: [],
		isLoading: false,
		state: {
			status,
			turnId: "example-live-turn",
			turnGeneration: 1,
			executionId: "orch-exec-example",
			plan: null,
			result: { response: "What I found so far." },
			pendingApproval: null,
			pendingClarification: null,
			answeredClarifications: [],
			contextCompactions: [],
			limitSignals: [],
			handoffRecommended: undefined,
			budgetStop,
		},
		sendMessage: vi.fn(async () => null),
		sendApproval: vi.fn(),
		sendClarification: vi.fn(),
		sendFollowUp: vi.fn(),
		reset: vi.fn(),
		isRunning: false,
		isAwaitingApproval: false,
		isComplete: true,
		isFollowUpEnabled: false,
		currentPhase: "complete",
		progressMessage: "",
		currentStep: null,
		completedSteps: 0,
		totalSteps: 0,
		stepResults: [],
		streamingToolCalls: [],
		planningAudit: null,
		artifacts: [],
		partykitStepProgress: null,
		stop: vi.fn(),
	};
}

vi.mock("../../../hooks/useOrchestratorStream", () => ({
	useOrchestratorStream: () => streamState.current,
}));

vi.mock(
	"../../../hooks/useOrchestratorConversation",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../hooks/useOrchestratorConversation")
			>();
		return {
			...actual,
			useOrchestratorConversation: () => ({
				createConversation: vi.fn(async () => ({ id: "conv_example" })),
				saveExecution: vi.fn(async () => undefined),
				convertStepResults: () => [],
			}),
		};
	},
);

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		mcp: { tools: { list: vi.fn(async () => ({ tools: [] })) } },
		projects: { conversations: { attach: vi.fn(async () => ({})) } },
		agents: {
			conversations: {
				get: vi.fn(async () => ({ messages: [] })),
				update: vi.fn(async () => ({})),
				updateSettings: vi.fn(async () => ({ id: "conv_example" })),
				removeMessage: vi.fn(async () => ({ removed: true })),
			},
		},
		ai: { documents: {} },
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const path = (keys: string[]): unknown =>
		new Proxy(
			{},
			{
				get: (_t, key) =>
					key === "queryOptions"
						? () => ({ queryKey: keys })
						: path([...keys, String(key)]),
			},
		);
	return { orpc: path([]) };
});

vi.mock("@tanstack/react-query", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-query")>();
	return {
		...actual,
		useQuery: (options: { queryKey?: unknown[] }) => ({
			data: options.queryKey?.includes("try-workspace")
				? {
						id: "example-agent",
						agentId: "example-agent",
						displayName: "Example agent",
						deploymentUrl: "https://example.com/agent",
					}
				: options.queryKey?.includes("orchestrator-preferences")
					? {
							uiMode: "advanced",
							chatMode: "orchestrator",
							reasoningMode: "balanced",
							enabledMcpConfigIds: [],
						}
					: undefined,
			isLoading: false,
		}),
		useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
		useQueryClient: () => streamState.queryClient,
	};
});

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: "example-user", name: "Example User", image: null },
	}),
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: null,
		isOrganizationAdmin: false,
	}),
}));

vi.mock("next-intl", () => ({
	useTranslations: () =>
		Object.assign((key: string) => key, { raw: () => [] }),
}));

vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/useChatScopedProject",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("@saas/projects/components/excalidraw-auto-insert/useChatScopedProject")
			>();
		return {
			...actual,
			useChatScopedProjectFromOrchestratorStream: () => null,
		};
	},
);

vi.mock("@saas/projects/lib/image-upload-utils", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@saas/projects/lib/image-upload-utils")
		>();
	return {
		...actual,
		prepareImageForAi: async (file: File) => ({ ok: true, file }),
	};
});

vi.mock("../shared", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../shared")>();
	return {
		...actual,
		ChatInput: ({
			headerSlot,
			onSend,
		}: {
			headerSlot?: ReactNode;
			onSend?: (text: string) => unknown;
		}) => (
			<div>
				{headerSlot}
				<button
					type="button"
					onClick={() => onSend?.("Example request")}
				>
					Send fixture
				</button>
			</div>
		),
		ActiveContextIndicator: () => null,
	};
});

vi.mock("../ConversationToolPicker", () => ({
	ConversationToolPicker: () => null,
}));

const { FabricTemporalOrchestratorChat } = await import(
	"../FabricTemporalOrchestratorChat"
);

const CARD_TITLE = "This answer used its token allowance";

beforeEach(() => {
	window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function renderAt(status: string, budgetStop: unknown) {
	streamState.current = streamAt(status, budgetStop);
	render(
		<FabricTemporalOrchestratorChat
			organizationId="org_example"
			reasoningMode="balanced"
			activeConversationId="conv_example"
		/>,
	);
}

describe("FabricTemporalOrchestratorChat — the token-allowance card", () => {
	it("shows the card for a completed turn that used its allowance", () => {
		renderAt("completed", BUDGET_STOP);
		expect(screen.getByText(CARD_TITLE)).toBeTruthy();
	});

	it.each(["running", "awaiting_approval"])(
		"shows no card for a %s turn, though it carries a stop",
		(status) => {
			renderAt(status, BUDGET_STOP);
			expect(screen.queryByText(CARD_TITLE)).toBeNull();
		},
	);
});

describe("latest stopped turn after reload", () => {
	const source = {
		id: "example-stopped-turn",
		executionId: "example-old-execution",
		status: "LIMITED",
		budgetStop: { version: 1, kind: "round_limit", used: 30, limit: 30 },
		responseText: "Progress from the server",
	};
	function reload(latestTurn: unknown) {
		streamState.current = streamAt("idle", undefined);
		return render(
			<FabricTemporalOrchestratorChat
				organizationId="example-org"
				reasoningMode="balanced"
				activeConversationId="example-conversation"
				activeConversation={
					{
						id: "example-conversation",
						messages: [],
						metadata: { mode: "orchestrator", latestTurn },
					} as never
				}
			/>,
		);
	}
	it.each([
		{ version: 1, kind: "round_limit", used: 30, limit: 30 },
		{ version: 1, kind: "time_limit", used: 2700, limit: 2700 },
	])(
		"renders the latest stopped turn and sends Continue with its turn id: %j",
		async (budgetStop) => {
			reload({ ...source, budgetStop });
			fireEvent.click(
				screen.getByRole("button", { name: "Continue", exact: true }),
			);
			await waitFor(() =>
				expect(streamState.current.sendMessage).toHaveBeenCalled(),
			);
			const call = vi.mocked(
				streamState.current.sendMessage as ReturnType<typeof vi.fn>,
			).mock.calls[0];
			expect(call[0]).toBe("Continue");
			expect(call.at(-1)).toMatchObject({
				conversationId: "example-conversation",
				continueFromTurnId: source.id,
			});
		},
	);
	it.each([
		{
			...source,
			id: "example-next-turn",
			status: "ACTIVE",
			budgetStop: null,
		},
		{ ...source, status: "ACTIVE" },
		{ ...source, budgetStop: { version: 1, kind: "future" } },
	])("shows no card for latest turn %j", (latest) => {
		reload(latest);
		expect(
			screen.queryByText("This answer reached its step limit"),
		).toBeNull();
	});
});

describe("sibling orchestrator surfaces", () => {
	it("renders the budget card inside the MCP try dialog", async () => {
		streamState.current = streamAt("completed", BUDGET_STOP);
		const { McpChatDialog } = await import(
			"@saas/mcp/components/McpChatDialog"
		);
		const { TooltipProvider } = await import("@ui/components/tooltip");
		render(
			<TooltipProvider>
				<McpChatDialog
					open
					onOpenChange={vi.fn()}
					organizationId="example-org"
					config={{ id: "example-mcp", displayName: "Example MCP" }}
				/>
			</TooltipProvider>,
		);
		// The dialog creates the conversation on send; the durable card requires that conversation.
		expect(
			screen.getByRole("heading", { name: "Try Example MCP" }),
		).toBeTruthy();
		expect(screen.queryByText(CARD_TITLE)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Send fixture" }));
		await waitFor(() => expect(screen.getByText(CARD_TITLE)).toBeTruthy());
		fireEvent.click(
			screen.getByRole("button", { name: "Continue", exact: true }),
		);
		await waitFor(() =>
			expect(
				vi
					.mocked(
						streamState.current.sendMessage as ReturnType<
							typeof vi.fn
						>,
					)
					.mock.calls.at(-1)
					?.at(-1),
			).toMatchObject({ continueFromTurnId: "example-live-turn" }),
		);
	});
	it("renders the registered-agent try workspace through the shared chat", async () => {
		streamState.current = streamAt("completed", BUDGET_STOP);
		const { RegisteredAgentTryWorkspace } = await import(
			"../../RegisteredAgentTryWorkspace"
		);
		render(
			<RegisteredAgentTryWorkspace
				agentId="example-agent"
				basePath="/app/example-org"
				organizationId="example-org"
			/>,
		);
		expect(screen.getByText("Example agent")).toBeTruthy();
		expect(screen.queryByText(CARD_TITLE)).toBeNull();
	});
});

vi.mock("next/dynamic", () => ({
	default: (loader: () => Promise<unknown>) =>
		String(loader).includes("FabricTemporalOrchestratorChat")
			? (
					props: React.ComponentProps<
						typeof FabricTemporalOrchestratorChat
					>,
				) => <FabricTemporalOrchestratorChat {...props} />
			: () => null,
}));
vi.mock("@saas/shared/contexts/SidebarCollapseContext", () => ({
	useSidebarCollapse: () => ({ isCollapsed: false }),
}));
vi.mock("@saas/shared/contexts/FullscreenContext", () => ({
	useFullscreen: () => ({ isFullscreen: false, setIsFullscreen: vi.fn() }),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "example-org",
		organizationSlug: "example-org",
		organizationName: "Example organization",
		basePath: "/app/example-org",
	}),
	useEffectiveOrganizationId: () => "example-org",
	useOrganizationSlug: () => "example-org",
	useAccountBasePath: () => "/app/example-org",
	useContextPath: () => "/app/example-org/libraries",
}));
vi.mock("../../../hooks/useConversationHistory", () => ({
	generateMessageId: () => `example-message-${crypto.randomUUID()}`,
	useConversationDetail: () => ({
		data: undefined,
		isLoading: false,
		isError: false,
		refetch: vi.fn(),
	}),
	useConversationHistory: () => ({
		conversations: [],
		isLoadingDetail: false,
		activeConversationId: "example-conversation",
		activeConversation: {
			id: "example-conversation",
			isOwn: true,
			messages: [],
			metadata: {
				mode: "orchestrator",
				executions: [],
				latestTurn: {
					id: "example-stopped-turn",
					executionId: "example-stopped-execution",
					generation: 1,
					status: "LIMITED",
					budgetStop: {
						version: 1,
						kind: "round_limit",
						used: 30,
						limit: 30,
					},
					responseText: "Server progress",
				},
			},
		},
		selectConversation: vi.fn(),
		refetchList: vi.fn(),
	}),
}));
vi.mock("../../../hooks/useWorkspaceFiles", () => ({
	useWorkspaceFiles: () => ({
		files: [],
		isLoading: false,
		refetch: vi.fn(),
	}),
}));
vi.mock("../../../hooks/useWorkflowTemplateStream", () => ({
	useWorkflowTemplateStream: () => ({
		isLoading: false,
		reset: vi.fn(),
		sendQuery: vi.fn(),
	}),
}));
vi.mock("../../../hooks/useSavedAgentUnavailableNotice", () => ({
	useSavedAgentUnavailableNotice: vi.fn(),
}));
vi.mock("../../OrchestratorConfigPanel", () => ({
	useOrchestratorConfig: () => ({
		enabledAgentIds: [],
		enabledMcpConfigIds: [],
		enabledWorkspaceIds: [],
		enabledFabricToolIds: [],
		enabledIntegrationIds: [],
		prioritizedToolIds: [],
		prioritizedAgentIds: [],
		prioritizedMcpConfigIds: [],
		prioritizedIntegrationIds: [],
	}),
}));
vi.mock("../../fabric-ai/components", () => ({
	ConversationHistoryPanel: () => null,
	FramesPanel: () => null,
}));

it("renders the full Fabric AI page with the real shared stop card", async () => {
	streamState.current = streamAt("idle", undefined);
	const { default: FabricAIClient } = await import(
		"../../fabric-ai/FabricAIClient"
	);
	render(<FabricAIClient initialPreferences={null} />);
	await waitFor(() =>
		expect(
			screen.getByText("This answer reached its step limit"),
		).toBeTruthy(),
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Continue", exact: true }),
	);
	await waitFor(() =>
		expect(
			vi
				.mocked(
					streamState.current.sendMessage as ReturnType<typeof vi.fn>,
				)
				.mock.calls.at(-1)
				?.at(-1),
		).toMatchObject({
			continueFromTurnId: "example-stopped-turn",
			conversationId: "example-conversation",
		}),
	);
});

it("renders the drawer with the real stop card and continues in its created conversation", async () => {
	streamState.current = streamAt("completed", BUDGET_STOP);
	const { FabricAgentLauncherProvider } = await import(
		"../../FabricAgentLauncher"
	);
	render(
		<FabricAgentLauncherProvider>
			<span>Example page</span>
		</FabricAgentLauncherProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: /Fabric Agent/i }));
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "Send fixture" }),
		).toBeTruthy(),
	);
	fireEvent.click(screen.getByRole("button", { name: "Send fixture" }));
	await waitFor(() => expect(screen.getByText(CARD_TITLE)).toBeTruthy());
	fireEvent.click(
		screen.getByRole("button", { name: "Continue", exact: true }),
	);
	await waitFor(() =>
		expect(
			vi
				.mocked(
					streamState.current.sendMessage as ReturnType<typeof vi.fn>,
				)
				.mock.calls.at(-1)
				?.at(-1),
		).toMatchObject({
			conversationId: "conv_example",
			continueFromTurnId: "example-live-turn",
		}),
	);
});

it("hides an older live stop when the server's latest turn is running", () => {
	streamState.current = streamAt("completed", {
		version: 1,
		kind: "round_limit",
		used: 30,
		limit: 30,
	});
	render(
		<FabricTemporalOrchestratorChat
			reasoningMode="balanced"
			activeConversationId="example-conversation"
			activeConversation={
				{
					id: "example-conversation",
					messages: [],
					metadata: {
						mode: "orchestrator",
						latestTurn: {
							id: "example-newer-turn",
							executionId: "example-newer-execution",
							generation: 2,
							status: "ACTIVE",
							budgetStop: null,
						},
					},
				} as never
			}
		/>,
	);
	expect(screen.queryByText("This answer reached its step limit")).toBeNull();
});

it.each(["completed", "failed", "cancelled"])(
	"refreshes saved turn metadata after %s",
	async (status) => {
		streamState.current = {
			...streamAt("running", undefined),
			isRunning: true,
			isComplete: false,
		};
		const props = {
			organizationId: "example-org",
			activeConversationId: "example-conversation",
		};
		const view = render(<FabricTemporalOrchestratorChat {...props} />);
		streamState.invalidate.mockClear();
		streamState.current = streamAt(status, undefined);
		view.rerender(<FabricTemporalOrchestratorChat {...props} />);
		await waitFor(() =>
			expect(streamState.invalidate).toHaveBeenCalledWith({
				queryKey: [
					"orchestrator-conversation-meta",
					"example-conversation",
					"example-org",
				],
			}),
		);
	},
);

it("refreshes metadata for a new finished execution without a status transition", async () => {
	streamState.current = streamAt("completed", undefined);
	const props = {
		organizationId: "example-org",
		activeConversationId: "example-conversation",
	};
	const view = render(<FabricTemporalOrchestratorChat {...props} />);
	streamState.invalidate.mockClear();
	const next = streamAt("completed", undefined);
	next.state.executionId = "example-next-execution";
	streamState.current = next;
	view.rerender(<FabricTemporalOrchestratorChat {...props} />);
	await waitFor(() =>
		expect(streamState.invalidate).toHaveBeenCalledWith({
			queryKey: [
				"orchestrator-conversation-meta",
				"example-conversation",
				"example-org",
			],
		}),
	);
});
