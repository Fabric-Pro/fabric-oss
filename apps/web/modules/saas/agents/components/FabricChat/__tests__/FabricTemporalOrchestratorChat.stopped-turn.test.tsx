/**
 * A stopped turn's partial answer stays inside that turn: under its own
 * question, shown once, and never below a later question or answer. The
 * completed entry and the saved turn carry the text the user saw.
 *
 * The stream and conversation hooks are mocked; everything the component
 * decides on its own runs for real.
 */

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

const { FabricTemporalOrchestratorChat } = await import(
	"../FabricTemporalOrchestratorChat"
);

beforeEach(() => {
	calls.order = [];
	streamState.current = idleStream();
	conversationHook.createConversation.mockImplementation(async () => {
		calls.order.push("createConversation");
		return { id: "conv_new" };
	});
	conversationHook.saveExecution.mockResolvedValue(undefined);
	orpc.attach.mockImplementation(async () => {
		calls.order.push("attach");
	});
	orpc.get.mockResolvedValue({ messages: [] });
	orpc.update.mockResolvedValue({});
	orpc.updateSettings.mockResolvedValue({ id: "conv" });
	orpc.removeMessage.mockResolvedValue({ removed: true });
	window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

async function send(text: string) {
	fireEvent.change(screen.getByLabelText("Message"), {
		target: { value: text },
	});
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
	});
}

const question1 = {
	id: "u1",
	role: "user",
	content: "QUESTION_ONE",
	timestamp: new Date(),
};
const stoppedAnswer1 = {
	id: "a1",
	role: "assistant",
	content: "PARTIAL_ANSWER_ONE",
	timestamp: new Date(),
	isStreaming: false,
	streamStatus: "cancelled",
	cancelledAt: "2026-10-16T10:00:00.000Z",
};

function render1() {
	return render(<FabricTemporalOrchestratorChat reasoningMode="balanced" />);
}

/** Sends question 1 and has the hook report it stopped with partial text. */
async function stopFirstTurn(rerender: (ui: ReactNode) => void) {
	await send("QUESTION_ONE");
	streamState.current = idleStream({
		isComplete: true,
		messages: [question1, stoppedAnswer1],
		state: {
			...(idleStream().state as Record<string, unknown>),
			status: "cancelled",
			executionId: "exec_1",
			result: null,
		},
	});
	rerender(<FabricTemporalOrchestratorChat reasoningMode="balanced" />);
	await waitFor(() =>
		expect(conversationHook.saveExecution).toHaveBeenCalled(),
	);
}

function occurrences(text: string) {
	return document.body.innerHTML.split(text).length - 1;
}

function position(text: string) {
	return document.body.innerHTML.indexOf(text);
}

describe("FabricTemporalOrchestratorChat — a stopped turn", () => {
	it("keeps the stopped answer under its own question when the next question runs", async () => {
		const { rerender } = render1();
		await stopFirstTurn(rerender);

		await send("QUESTION_TWO");
		streamState.current = idleStream({
			isLoading: true,
			isRunning: true,
			currentPhase: "thinking",
			messages: [
				question1,
				stoppedAnswer1,
				{
					id: "u2",
					role: "user",
					content: "QUESTION_TWO",
					timestamp: new Date(),
				},
				{
					id: "a2",
					role: "assistant",
					content: "ANSWER_TWO",
					timestamp: new Date(),
					isStreaming: true,
				},
			],
			state: {
				...(idleStream().state as Record<string, unknown>),
				status: "running",
				executionId: "exec_2",
			},
		});
		rerender(<FabricTemporalOrchestratorChat reasoningMode="balanced" />);

		expect(occurrences("PARTIAL_ANSWER_ONE")).toBe(1);
		expect(occurrences("QUESTION_ONE")).toBe(1);
		const q1 = position("QUESTION_ONE");
		const a1 = position("PARTIAL_ANSWER_ONE");
		const q2 = position("QUESTION_TWO");
		const a2 = position("ANSWER_TWO");
		expect(q1).toBeGreaterThan(-1);
		expect(q1).toBeLessThan(a1);
		expect(a1).toBeLessThan(q2);
		expect(q2).toBeLessThan(a2);
		// The completed entry keeps the Stopped mark the live turn showed.
		expect(occurrences("— responseStopped")).toBe(1);
	});

	it("shows the stopped answer live, once, before the next question is sent", async () => {
		const { rerender } = render1();
		await stopFirstTurn(rerender);

		expect(occurrences("PARTIAL_ANSWER_ONE")).toBe(1);
		expect(position("QUESTION_ONE")).toBeLessThan(
			position("PARTIAL_ANSWER_ONE"),
		);
		expect(occurrences("— responseStopped")).toBe(1);
	});

	it("saves the partial answer the user saw, not a cancellation placeholder", async () => {
		const { rerender } = render1();
		await stopFirstTurn(rerender);

		const saved = conversationHook.saveExecution.mock.calls[0][0] as {
			execution: { finalResponse: string; status: string };
			messages: Array<{
				role: string;
				content: string;
				streamStatus?: string;
				cancelledAt?: string;
			}>;
		};
		expect(saved.execution.finalResponse).toBe("PARTIAL_ANSWER_ONE");
		expect(saved.execution.status).toBe("cancelled");
		const assistant = saved.messages.find((m) => m.role === "assistant");
		expect(assistant).toMatchObject({
			content: "PARTIAL_ANSWER_ONE",
			streamStatus: "cancelled",
			cancelledAt: stoppedAnswer1.cancelledAt,
		});
	});

	it("still saves the cancellation note when the turn was stopped before any text", async () => {
		const { rerender } = render1();
		await send("QUESTION_ONE");
		streamState.current = idleStream({
			isComplete: true,
			messages: [question1, { ...stoppedAnswer1, content: "" }],
			state: {
				...(idleStream().state as Record<string, unknown>),
				status: "cancelled",
				executionId: "exec_1",
				result: null,
			},
		});
		rerender(<FabricTemporalOrchestratorChat reasoningMode="balanced" />);
		await waitFor(() =>
			expect(conversationHook.saveExecution).toHaveBeenCalled(),
		);

		const saved = conversationHook.saveExecution.mock.calls[0][0] as {
			execution: { finalResponse: string };
		};
		expect(saved.execution.finalResponse).toBe(
			"Workflow was cancelled by user.",
		);
	});
	it.each([
		["with the same text on the stopped message", "SERVER_ANSWER"],
		["with no text on the stopped message", ""],
	])(
		"shows a server-cancelled turn's answer once, %s",
		async (_label, messageText) => {
			const { rerender } = render1();
			await send("QUESTION_ONE");
			// A cancellation that arrives through the stream: `completed`
			// with status "cancelled" sets the result's response and the
			// stopped message's text.
			streamState.current = idleStream({
				isComplete: true,
				messages: [
					question1,
					{ ...stoppedAnswer1, content: messageText },
				],
				state: {
					...(idleStream().state as Record<string, unknown>),
					status: "cancelled",
					executionId: "exec_1",
					result: { response: "SERVER_ANSWER", status: "cancelled" },
				},
			});
			rerender(
				<FabricTemporalOrchestratorChat reasoningMode="balanced" />,
			);

			expect(occurrences("SERVER_ANSWER")).toBe(1);
			expect(occurrences("— responseStopped")).toBe(1);
			expect(position("QUESTION_ONE")).toBeLessThan(
				position("SERVER_ANSWER"),
			);
		},
	);
});
