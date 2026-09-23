/**
 * The project pill on a new chat is the host's (review F45).
 *
 * The Orchestrator fills its own copy of the attached project from the open
 * conversation. Leaving that conversation for a new chat reset the thread but
 * not that copy, so the previous conversation's project stayed on screen in the
 * Orchestrator while the page — and Direct, after an engine switch — held
 * none: switching engines looked like it dropped the project.
 */

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ order: [] as string[] }));

const conversationHook = vi.hoisted(() => ({
	createConversation: vi.fn(),
	saveExecution: vi.fn(),
}));

const orpc = vi.hoisted(() => ({
	attach: vi.fn(),
	get: vi.fn(),
	update: vi.fn(),
}));

const streamState = vi.hoisted(() => ({
	current: {} as Record<string, unknown>,
}));

function idleStream(overrides: Record<string, unknown> = {}) {
	return {
		messages: [],
		isLoading: false,
		state: {
			status: "idle",
			executionId: null,
			plan: null,
			result: null,
			pendingApproval: null,
			pendingClarification: null,
			answeredClarifications: [],
			contextCompactions: [],
			limitSignals: [],
			handoffRecommended: null,
		},
		sendMessage: vi.fn(async () => {
			calls.order.push("sendMessage");
			return null;
		}),
		sendApproval: vi.fn(),
		sendClarification: vi.fn(),
		sendFollowUp: vi.fn(),
		reset: vi.fn(),
		isRunning: false,
		isAwaitingApproval: false,
		isComplete: false,
		isFollowUpEnabled: false,
		currentPhase: "idle",
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
		...overrides,
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
				createConversation: conversationHook.createConversation,
				saveExecution: conversationHook.saveExecution,
				convertStepResults: () => [],
			}),
		};
	},
);

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { conversations: { attach: orpc.attach } },
		agents: { conversations: { get: orpc.get, update: orpc.update } },
		ai: { documents: {} },
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: new Proxy(
		{},
		{
			get: () =>
				new Proxy(
					{},
					{
						get: () => ({
							queryOptions: () => ({ queryKey: ["mock"] }),
							getProject: {
								queryOptions: () => ({
									queryKey: ["getProject"],
								}),
							},
						}),
					},
				),
		},
	),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-query")>();
	return {
		...actual,
		// The conversation's stored project, for whichever conversation the
		// chat has open.
		useQuery: (options: { queryKey?: unknown[]; enabled?: boolean }) => ({
			data:
				options.queryKey?.[0] === "getProject" && options.enabled
					? { project: { id: "project_from_conversation" } }
					: undefined,
			isLoading: false,
		}),
		useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
		useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	};
});

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { name: "Test User", image: null } }),
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: null,
		isOrganizationAdmin: false,
	}),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
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

// The composer's own behaviour is covered elsewhere; here it only has to
// carry text in and a send out.
vi.mock("../shared", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../shared")>();
	return {
		...actual,
		ChatInput: ({
			value,
			onChange,
			onSend,
			headerSlot,
		}: {
			value: string;
			onChange: (value: string) => void;
			onSend: () => void;
			headerSlot?: ReactNode;
		}) => (
			<div>
				<textarea
					aria-label="Message"
					value={value}
					onChange={(event) => onChange(event.target.value)}
				/>
				<button type="button" onClick={onSend}>
					Send
				</button>
				{headerSlot}
			</div>
		),
		ActiveContextIndicator: ({
			projectId,
		}: {
			projectId?: string | null;
		}) => <span data-testid="project-pill">{projectId ?? ""}</span>,
	};
});

vi.mock("../shared/ActiveContextIndicator", () => ({
	ActiveContextIndicator: ({ projectId }: { projectId?: string | null }) => (
		<span data-testid="project-pill">{projectId ?? ""}</span>
	),
}));

// Stands in for the Chat-tools dialog: one click picks one server.
vi.mock("../ConversationToolPicker", () => ({
	ConversationToolPicker: ({
		onChange,
	}: {
		onChange: (ids: string[]) => void;
	}) => (
		<button type="button" onClick={() => onChange(["mcp_1"])}>
			pick chat tool
		</button>
	),
}));

const { FabricTemporalOrchestratorChat } = await import(
	"../FabricTemporalOrchestratorChat"
);

beforeEach(() => {
	streamState.current = idleStream();
	window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function pill() {
	return screen.getByTestId("project-pill").textContent;
}

describe("FabricTemporalOrchestratorChat — project pill after New", () => {
	it("drops the previous conversation's project on a new chat", () => {
		const view = render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_old"
				attachedProjectId={null}
			/>,
		);
		expect(pill()).toBe("project_from_conversation");

		view.rerender(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId={null}
				attachedProjectId={null}
			/>,
		);

		expect(pill()).toBe("");
	});

	it("keeps the project the page holds for the new chat", () => {
		const view = render(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId="conv_old"
				attachedProjectId="project_picked"
			/>,
		);
		expect(pill()).toBe("project_picked");

		view.rerender(
			<FabricTemporalOrchestratorChat
				reasoningMode="balanced"
				activeConversationId={null}
				attachedProjectId="project_picked"
			/>,
		);

		expect(pill()).toBe("project_picked");
	});
});
