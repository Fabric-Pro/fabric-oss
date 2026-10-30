import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The read projection is real; this integration test needs no database client.
vi.mock("../../../../../../../../packages/database/prisma/client", () => ({
	db: {},
}));

const calls = vi.hoisted(() => ({ order: [] as string[] }));

const conversationHook = vi.hoisted(() => ({
	createConversation: vi.fn(),
	saveExecution: vi.fn(),
}));

const orpc = vi.hoisted(() => ({
	attach: vi.fn(),
	get: vi.fn(),
	update: vi.fn(),
	updateSettings: vi.fn(),
	removeMessage: vi.fn(),
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

// The options the chat passed to the hook, so a test can drive the
// callbacks the real hook would call.
const streamOptions = vi.hoisted(() => ({
	current: null as null | {
		onTurnRefused?: (content: string) => string | undefined;
	},
}));

vi.mock("../../../hooks/useOrchestratorStream", () => ({
	useOrchestratorStream: (options: {
		onTurnRefused?: (content: string) => string | undefined;
	}) => {
		streamOptions.current = options;
		return streamState.current;
	},
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
		agents: {
			conversations: {
				get: orpc.get,
				update: orpc.update,
				updateSettings: orpc.updateSettings,
				removeMessage: orpc.removeMessage,
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

// `COPILOTKIT_ORCHESTRATOR_CHAT` off: the chat runs over the stream route.
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
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

// Image shaping draws on a canvas, which jsdom lacks; the file passes as is.
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
		ActiveContextIndicator: () => null,
	};
});

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

const responseRenders = vi.hoisted(() => [] as string[]);
vi.mock("@/components/ai-elements/response", () => ({
	Response: ({ children }: { children: ReactNode }) => {
		responseRenders.push(String(children));
		return <div>{children}</div>;
	},
}));

const { FabricTemporalOrchestratorChat } = await import(
	"../FabricTemporalOrchestratorChat"
);

beforeEach(() => {
	streamState.current = idleStream();
	responseRenders.length = 0;
	conversationHook.saveExecution.mockResolvedValue(undefined);
	orpc.update.mockResolvedValue({});
	orpc.updateSettings.mockResolvedValue({ id: "conv_example" });
	window.HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const records = Array.from({ length: 4 }, (_, index) => ({
	id: `exec_${index}`,
	userMessage: `question ${index}`,
	finalResponse: `answer ${index}`,
	stepResults: [],
	completedAt: "2026-10-01T10:00:00.000Z",
	truncated: "output_limit",
}));
const conversation = {
	id: "conv_example",
	messages: [],
	metadata: { mode: "orchestrator", executions: records },
};
function ui(source = conversation) {
	return (
		<FabricTemporalOrchestratorChat
			reasoningMode="balanced"
			activeConversationId="conv_example"
			activeConversation={source}
		/>
	);
}
function counts() {
	return records.map(
		(record) =>
			responseRenders.filter((text) => text === record.finalResponse)
				.length,
	);
}
async function loaded() {
	const view = render(ui());
	await screen.findByText("answer 3");
	return view;
}

describe("orchestrator completed-turn render cost", () => {
	it("skips completed bodies while the live answer streams and refreshes shared render inputs", async () => {
		streamState.current = idleStream({
			isLoading: true,
			isRunning: true,
			messages: [
				{ id: "live_user", role: "user", content: "live question" },
				{
					id: "live_answer",
					role: "assistant",
					content: "Part",
					isStreaming: true,
				},
			],
		});
		const view = await loaded();
		const before = counts();
		expect(before.every((count) => count > 0)).toBe(true);
		for (const content of ["Partial", "Partial answer"]) {
			streamState.current = {
				...streamState.current,
				messages: (
					streamState.current.messages as Array<
						Record<string, unknown>
					>
				).map((message) =>
					message.id === "live_answer"
						? { ...message, content }
						: message,
				),
			};
			view.rerender(ui());
		}
		expect(counts()).toEqual(before);
		streamState.current = { ...streamState.current, isLoading: false };
		view.rerender(ui());
		expect(counts()).toEqual(before.map((count) => count + 1));
	});
	it("calls the latest send handler after the completed row skips a render", async () => {
		const first = vi.fn(async () => null);
		streamState.current = idleStream({ sendMessage: first });
		const view = await loaded();
		const before = counts();
		const latest = vi.fn(async () => null);
		streamState.current = { ...streamState.current, sendMessage: latest };
		view.rerender(ui());
		expect(counts()).toEqual(before);
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		});
		await waitFor(() => expect(latest).toHaveBeenCalled());
		expect(first).not.toHaveBeenCalled();
	});
	it("retains sibling identity when persisted history grows while idle", async () => {
		const view = await loaded();
		const before = counts();
		view.rerender(
			ui({
				...conversation,
				metadata: {
					...conversation.metadata,
					executions: [
						...records,
						{
							...records[0],
							id: "exec_new",
							finalResponse: "new answer",
						},
					],
				},
			}),
		);
		await screen.findByText("new answer");
		// The former last row changes its Continue affordance; earlier rows stay still.
		expect(counts()).toEqual(
			before.map((count, index) => count + (index === 3 ? 1 : 0)),
		);
	});
});
