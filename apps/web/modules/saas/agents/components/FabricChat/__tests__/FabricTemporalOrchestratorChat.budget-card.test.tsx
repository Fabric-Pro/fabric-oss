/**
 * The orchestrator chat's token-allowance card is decided by the turn's
 * status, not by whether the stream carried a stop: the live event and a
 * reconnect both carry the turn row's stored stop for every terminal status,
 * so a turn that used its allowance and was then stopped holds the payload
 * with status "cancelled", and shows no budget card. A completed turn with
 * the same payload shows the card. The stream hook is mocked to that state.
 */

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamState = vi.hoisted(() => ({
	current: {} as Record<string, unknown>,
}));

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
								queryOptions: () => ({ queryKey: ["mock"] }),
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
		useQuery: () => ({ data: undefined, isLoading: false }),
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
		ChatInput: ({ headerSlot }: { headerSlot?: ReactNode }) => (
			<div>{headerSlot}</div>
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

	it.each(["cancelled", "failed"])(
		"shows no card for a %s turn, though it carries the stored stop",
		(status) => {
			renderAt(status, BUDGET_STOP);
			expect(screen.queryByText(CARD_TITLE)).toBeNull();
		},
	);
});
