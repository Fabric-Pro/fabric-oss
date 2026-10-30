/**
 * Opening a conversation whose turn is still running (a reload mid-turn)
 * reattaches the chat to it. The real stream hook runs against a scripted
 * stream route; the read projection is real; the conversation hook's save is
 * mocked so the test sees exactly what the chat writes.
 *
 * - A turn waiting on approval shows its Approve card again, and approving
 *   it reaches that turn.
 * - A running turn's answer streams in and is saved once, under its own
 *   execution id, with the stored question taken over rather than repeated.
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
import { hydrateConversationTurnResults } from "../../../../../../../../packages/database/prisma/queries/conversation-turn-results";

vi.mock("../../../../../../../../packages/database/prisma/client", () => ({
	db: {},
}));

const conversationHook = vi.hoisted(() => ({
	createConversation: vi.fn(),
	saveExecution: vi.fn(),
}));

vi.mock("../../../hooks/useOrchestratorPartyKit", () => ({
	useOrchestratorPartyKit: () => ({
		isConnected: false,
		toolCalls: [],
		stepProgress: undefined,
		currentPhase: "idle",
		reset: vi.fn(),
		notifyStepStart: vi.fn(),
	}),
}));

vi.mock("../../../lib/cancel-telemetry", () => ({
	emitCancelEvent: vi.fn(),
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
		projects: { conversations: { attach: vi.fn() } },
		agents: {
			conversations: {
				get: vi.fn(async () => ({ messages: [] })),
				update: vi.fn(),
				updateSettings: vi.fn(async () => ({ id: "conv" })),
				removeMessage: vi.fn(),
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

const { FabricTemporalOrchestratorChat } = await import(
	"../FabricTemporalOrchestratorChat"
);

const BASE = "/api/agents/fabric-ai/orchestrator-temporal";
const STREAM_URL = `${BASE}/stream`;
const EXECUTION_ID = "orch-aaaaaaaa-0000-4000-8000-0000000000b1";
const CONVERSATION_ID = "conv_running";
const QUESTION = "Publish the weekly status page";
const STARTED = new Date("2026-10-01T10:00:00.000Z");

function makeSseResponse() {
	const encoder = new TextEncoder();
	const queue: Array<{ value?: Uint8Array; done?: boolean }> = [];
	let resolveNext: (() => void) | null = null;
	const read = () =>
		new Promise<{ value?: Uint8Array; done?: boolean }>((resolve) => {
			const drain = () => {
				const next = queue.shift();
				if (next) {
					resolve({ value: next.value, done: next.done ?? false });
					return true;
				}
				return false;
			};
			if (drain()) {
				return;
			}
			resolveNext = () => {
				drain();
			};
		});
	const push = (entry: { value?: Uint8Array; done?: boolean }) => {
		queue.push(entry);
		const r = resolveNext;
		resolveNext = null;
		r?.();
	};
	return {
		response: {
			ok: true,
			status: 200,
			body: { getReader: () => ({ read }) },
			json: async () => ({}),
			headers: new Headers(),
		},
		send: (event: Record<string, unknown>) =>
			push({ value: encoder.encode(`data: ${JSON.stringify(event)}\n`) }),
		end: () => push({ done: true }),
	};
}

interface Call {
	url: string;
	body: Record<string, unknown>;
}

function installFetch(streamResponses: unknown[]): Call[] {
	const calls: Call[] = [];
	let next = 0;
	global.fetch = vi.fn((input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : (input as Request).url;
		calls.push({
			url,
			body: init?.body ? JSON.parse(String(init.body)) : {},
		});
		if (url !== STREAM_URL) {
			return Promise.resolve({
				ok: true,
				status: 200,
				json: async () => ({ success: true }),
			} as Response);
		}
		const scripted = streamResponses[next++];
		if (scripted === undefined) {
			return Promise.reject(new Error("unexpected stream POST"));
		}
		return Promise.resolve(scripted as Response);
	}) as unknown as typeof fetch;
	return calls;
}

/**
 * The conversation as the chat reads it mid-turn: a new conversation's
 * first question, seeded when it was created, and its turn still running.
 */
function runningConversation() {
	const seed = {
		id: "msg_seed",
		role: "user",
		content: QUESTION,
		timestamp: STARTED.toISOString(),
	};
	const projected = hydrateConversationTurnResults(
		{ messages: [seed], metadata: { mode: "orchestrator" } },
		[
			{
				id: "turn_running",
				executionId: EXECUTION_ID,
				generation: 1,
				status: "ACTIVE",
				questionText: QUESTION,
				responseText: null,
				terminalAt: null,
				terminalReason: null,
				createdAt: STARTED,
				limitSignalSummary: null,
			},
		],
	);
	return { id: CONVERSATION_ID, ...projected };
}

const originalFetch = global.fetch;

beforeEach(() => {
	conversationHook.createConversation.mockResolvedValue({ id: "conv_new" });
	conversationHook.saveExecution.mockResolvedValue(undefined);
	window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	global.fetch = originalFetch;
	vi.clearAllMocks();
});

function renderChat() {
	return render(
		<FabricTemporalOrchestratorChat
			reasoningMode="balanced"
			organizationId="org-example-1"
			activeConversationId={CONVERSATION_ID}
			activeConversation={runningConversation()}
		/>,
	);
}

describe("FabricTemporalOrchestratorChat — a turn still running when the conversation is opened", () => {
	it("shows a pending approval again after a reload, and approving it reaches that turn", async () => {
		const window = makeSseResponse();
		const calls = installFetch([window.response]);
		renderChat();

		await waitFor(() => {
			expect(calls.filter((c) => c.url === STREAM_URL)).toHaveLength(1);
		});
		const reconnect = calls.find((c) => c.url === STREAM_URL);
		expect(reconnect?.body).toMatchObject({
			executionId: EXECUTION_ID,
			conversationId: CONVERSATION_ID,
		});
		expect(reconnect?.body).not.toHaveProperty("message");
		expect(screen.getAllByText(QUESTION)).toHaveLength(1);
		expect(
			screen.queryByText(
				"Still running when this conversation was opened",
			),
		).not.toBeInTheDocument();

		await act(async () => {
			window.send({
				type: "started",
				executionId: EXECUTION_ID,
				resumed: true,
			});
			window.send({
				type: "approval_required",
				approvalId: "approval-1",
				stepId: "step-1",
				reason: "MEDIUM RISK: Publish the page to the workspace",
			});
		});

		const approve = await screen.findByRole("button", { name: "Approve" });
		expect(
			screen.getByText("Publish the page to the workspace"),
		).toBeInTheDocument();
		await act(async () => {
			fireEvent.click(approve);
		});
		await waitFor(() => {
			expect(
				calls.find((c) => c.url === `${BASE}/approve`)?.body,
			).toMatchObject({ executionId: EXECUTION_ID, approved: true });
		});
		await waitFor(() => {
			expect(
				screen.queryByRole("button", { name: "Approve" }),
			).not.toBeInTheDocument();
		});

		await act(async () => {
			window.send({ type: "approval_resolved" });
			window.send({
				type: "completed",
				status: "completed",
				response: "The page is published.",
			});
			window.end();
		});
		expect(
			await screen.findByText("The page is published."),
		).toBeInTheDocument();
		await waitFor(() => {
			expect(conversationHook.saveExecution).toHaveBeenCalledTimes(1);
		});
		const { execution } = conversationHook.saveExecution.mock.calls[0][0];
		expect(execution).toMatchObject({
			id: EXECUTION_ID,
			status: "complete",
		});
		expect(execution.approvalHistory).toEqual([
			expect.objectContaining({ approved: true }),
		]);
	});

	it("streams a running turn's answer in after a reload and saves it once, taking over the stored question", async () => {
		const window = makeSseResponse();
		const calls = installFetch([window.response]);
		renderChat();

		await waitFor(() => {
			expect(calls.some((c) => c.url === STREAM_URL)).toBe(true);
		});
		await act(async () => {
			window.send({
				type: "started",
				executionId: EXECUTION_ID,
				resumed: true,
			});
			window.send({ type: "text_delta", content: "Drafting the page" });
		});
		expect(
			await screen.findByText("Drafting the page"),
		).toBeInTheDocument();
		expect(conversationHook.saveExecution).not.toHaveBeenCalled();

		await act(async () => {
			window.send({
				type: "completed",
				status: "completed",
				response: "Here is the weekly status page.",
			});
			window.end();
		});
		expect(
			await screen.findByText("Here is the weekly status page."),
		).toBeInTheDocument();
		expect(screen.getAllByText(QUESTION)).toHaveLength(1);

		await waitFor(() => {
			expect(conversationHook.saveExecution).toHaveBeenCalledTimes(1);
		});
		const saved = conversationHook.saveExecution.mock.calls[0][0];
		expect(saved.conversationId).toBe(CONVERSATION_ID);
		expect(saved.execution).toMatchObject({
			id: EXECUTION_ID,
			userMessage: QUESTION,
			finalResponse: "Here is the weekly status page.",
			startedAt: STARTED.toISOString(),
		});
		expect(saved.execution).not.toHaveProperty("inProgress");
		expect(
			saved.messages.map((m: { id: string; role: string }) => [
				m.role,
				m.id,
			]),
		).toEqual([
			["user", "msg_seed"],
			["assistant", expect.any(String)],
		]);
		expect(saved.messages[0].content).toBe(QUESTION);

		// Settling afterwards neither saves again nor reattaches.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		expect(conversationHook.saveExecution).toHaveBeenCalledTimes(1);
		expect(calls.filter((c) => c.url === STREAM_URL)).toHaveLength(1);
	});

	it("stops the attached turn by its id", async () => {
		const window = makeSseResponse();
		const calls = installFetch([window.response]);
		renderChat();
		await waitFor(() => {
			expect(calls.some((c) => c.url === STREAM_URL)).toBe(true);
		});

		await act(async () => {
			fireEvent.keyDown(document, { key: "Escape" });
		});

		await waitFor(() => {
			expect(
				calls.find((c) => c.url === `${BASE}/cancel`)?.body,
			).toMatchObject({
				executionId: EXECUTION_ID,
				conversationId: CONVERSATION_ID,
			});
		});
		await act(async () => {
			window.end();
		});
	});
});
