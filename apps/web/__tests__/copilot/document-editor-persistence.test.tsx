/**
 * Tests for `<CopilotPersistenceHook>`.
 *
 * Guards FR-2 ("persistence runs on stream completion only, never on
 * streaming deltas") which exists to prevent the write-amplification
 * risk of ~600 row updates per 30s generation if persistence fired on
 * each delta. AC-5/AC-6/AC-7: stream-completion only / spill on cap /
 * cancellation captured.
 *
 * What we cover
 * -------------
 * The hook is a side-effect-only React component that subscribes to
 * CopilotKit's live messages context + chat-loading flag and persists
 * each terminal-state turn via `appendTurnForDocument`. We mock BOTH
 * CopilotKit hooks and the mutation so we can drive the lifecycle
 * deterministically:
 *
 *   1. Stream completion (`status.code === "Success"`)        → 1 call
 *   2. Stream error (`status.code === "Failed"`)              → 1 call
 *   3. Stream cancellation (`isLoading: true → false` while
 *      the most-recent message is still `Pending`)            → 1 call
 *   4. Streaming delta (`status.code === "Pending"`)          → 0 calls
 *   5. Same message id observed twice                          → 1 call
 *   6. Lazy-create response surfaces `onConversationIdResolved`
 *   7. Spill response surfaces `onSpilled`
 *   8. CONFLICT "history is disabled" swallowed silently       → no toast
 *   9. CONFLICT 50/day cap surfaces as toast
 *
 * Why we mock the CopilotKit hooks
 * --------------------------------
 * The runtime hooks require a `<CopilotKit>` provider with a runtime URL
 * and an active session — there is no test fixture for that in this repo
 * and the spec sets the persistence-hook test as a unit boundary
 * (procedure tests in Group B cover the DB write path with a real
 * Postgres). Mocking the hooks gives us deterministic control of every
 * lifecycle edge we need to assert FR-2 against.
 */

import { AssistantThreadProvider } from "@saas/shared/components/copilot/assistant-thread";
import { CopilotChatSessionProvider } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import { act, render as rtlRender } from "@testing-library/react";

// Every component under test reads its CopilotKit chat state from
// `<CopilotChatSessionProvider>` (one `useCopilotChatInternal()` per surface —
// see the provider's doc-comment and Fizzy #2389), so each render mounts the
// real provider over this file's mocked `useCopilotChatInternal`.
function render(ui: Parameters<typeof rtlRender>[0]) {
	return rtlRender(ui, { wrapper: CopilotChatSessionProvider });
}

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — shared between the factories and the test bodies so the
// same vi.fn instances surface in both places. The `current` wrappers let
// each test mutate the values the next render sees without re-defining
// the mocks.
// ---------------------------------------------------------------------------

const traceState = vi.hoisted(() => ({
	current: {} as Record<string, unknown>,
}));

const runAgent = vi.hoisted(() => ({
	handlers: new Set<Record<string, (...args: any[]) => void>>(),
	get state() {
		return traceState.current;
	},
	subscribe: vi.fn((handler: Record<string, (...args: any[]) => void>) => {
		runAgent.handlers.add(handler);
		return { unsubscribe: () => runAgent.handlers.delete(handler) };
	}),
}));
vi.mock("@copilotkit/react-core/v2/context", () => ({
	useCopilotKit: () => ({
		copilotkit: {
			agents: { project_document_generator: runAgent },
			subscribe: () => ({ unsubscribe: () => {} }),
		},
	}),
}));
function runEvent(name: string, params: object = {}) {
	act(() => {
		for (const handler of runAgent.handlers) {
			handler[name]?.(params);
		}
	});
}

const { mockMessagesRef, mockIsLoadingRef, mockMutateAsync, mockToastError } =
	vi.hoisted(() => ({
		mockMessagesRef: { current: [] as Array<Record<string, unknown>> },
		mockIsLoadingRef: { current: false },
		mockMutateAsync: vi.fn(),
		mockToastError: vi.fn(),
	}));

// CopilotKit 1.52 — the persistence hook reads the live messages array
// and the chat-loading flag from `useCopilotChatInternal()`. That hook is
// the same one `<CopilotSidebar>` itself uses (see `react-ui/.../Messages.tsx`
// line ~1529), so subscribing here observes exactly what the user sees.
//
// Why not the other CopilotKit hooks:
//   - `useCopilotChat()` Omits `messages` / `setMessages` from its public
//     return type (`Omit<UseCopilotChatReturn$1, "messages" | ...>` in
//     `index.d.mts` line ~967), so destructuring `messages` yields undefined.
//   - `useCopilotMessagesContext()` holds a SEPARATE `useState([])` (line
//     ~548 of the shipped `.mjs`) that the runtime stream never writes
//     into; reading from it always returns the empty seed.
//   - `useCopilotChatHeadless_c()` is premium-licensed — without a public
//     API key it returns `createNonFunctionalReturn()` (empty state).
vi.mock("@copilotkit/react-core", () => ({
	useCopilotChatInternal: () => ({
		messages: mockMessagesRef.current,
		isLoading: mockIsLoadingRef.current,
		setMessages: vi.fn(),
	}),
}));

vi.mock("@saas/projects/hooks/useDocumentAssistantHistory", () => ({
	useAppendDocumentAssistantTurn: () => ({
		mutateAsync: mockMutateAsync,
	}),
}));

vi.mock("sonner", () => ({
	toast: {
		error: (...args: unknown[]) => mockToastError(...args),
		success: vi.fn(),
	},
}));

import {
	CopilotPersistenceHook,
	computeFingerprint,
} from "../../modules/saas/projects/components/copilot/CopilotPersistenceHook";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MakeMessageOptions {
	id: string;
	role?: "user" | "assistant" | "system";
	content?: string;
	code: "Pending" | "Success" | "Failed";
	createdAt?: string;
}

/**
 * Legacy GraphQL compatibility fixture. Production AG-UI trace tests below
 * use plain messages and agent lifecycle events instead.
 * Build a structural CopilotKit `TextMessage`-shaped object. The
 * runtime ships a class with discriminator methods; we replicate the
 * shape with plain objects so the test doesn't import the runtime
 * package (which transitively pulls in GraphQL / Apollo wiring that
 * blows up in jsdom).
 */
function makeTextMessage(opts: MakeMessageOptions) {
	return {
		id: opts.id,
		role: opts.role ?? "assistant",
		content: opts.content ?? "",
		createdAt: opts.createdAt ?? "2026-05-19T12:00:00.000Z",
		status: { code: opts.code },
		isTextMessage: () => true,
		isActionExecutionMessage: () => false,
		isResultMessage: () => false,
		isAgentStateMessage: () => false,
		isImageMessage: () => false,
	};
}

interface RenderOptions {
	conversationId?: string | null;
	onConversationIdResolved?: ReturnType<typeof vi.fn>;
	onSpilled?: ReturnType<typeof vi.fn>;
	requestedVisibility?: "SHARED" | "PRIVATE";
}

function renderHook(options: RenderOptions = {}) {
	const onConversationIdResolved =
		options.onConversationIdResolved ?? vi.fn();
	const onSpilled = options.onSpilled ?? vi.fn();
	const utils = render(
		<CopilotPersistenceHook
			documentRefKind="PROJECT_DOCUMENT"
			documentRefId="doc-1"
			projectId="proj-1"
			organizationId="org-1"
			conversationId={options.conversationId ?? null}
			onConversationIdResolved={onConversationIdResolved}
			onSpilled={onSpilled}
			requestedVisibility={options.requestedVisibility ?? "SHARED"}
			agentId="project_document_generator"
		/>,
	) as ReturnType<typeof render> & {
		rerender: (ui: ReactNode) => void;
	};
	return { ...utils, onConversationIdResolved, onSpilled };
}

function flushMicrotasks() {
	// `mutateAsync` resolves in a microtask; tests assert on its
	// side-effects (toast / callbacks). Wrapping a single Promise resolve
	// in act() flushes both the microtask and React's effect commit queue
	// so the assertions are stable.
	return act(async () => {
		await Promise.resolve();
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CopilotPersistenceHook — stream-completion persistence (FR-2)", () => {
	// The hook logs via `console` (not `@repo/logs`) because it runs in the
	// browser bundle, where the pino transport in `@repo/logs` would pull in
	// node:fs and break the module graph. We spy on console.info/console.warn
	// to assert the two best-effort log lines without polluting test output.
	let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
	let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		mockMessagesRef.current = [];
		mockIsLoadingRef.current = false;
		mockMutateAsync.mockReset();
		mockToastError.mockReset();
		consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		mockMutateAsync.mockResolvedValue({
			conversationId: "conv-new",
			persistedAt: "2026-05-19T12:00:01.000Z",
		});
	});

	afterEach(() => {
		consoleInfoSpy.mockRestore();
		consoleWarnSpy.mockRestore();
	});

	it("fires exactly once on stream completion (status.code === 'Success')", async () => {
		mockMessagesRef.current = [
			makeTextMessage({
				id: "m-1",
				role: "assistant",
				content: "Done.",
				code: "Success",
			}),
		];
		renderHook();
		await flushMicrotasks();
		expect(mockMutateAsync).toHaveBeenCalledTimes(1);
		const [call] = mockMutateAsync.mock.calls;
		expect(call[0]).toMatchObject({
			conversationId: null,
			scope: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
				projectId: "proj-1",
				organizationId: "org-1",
			},
			message: expect.objectContaining({
				id: "m-1",
				role: "assistant",
				content: "Done.",
				streamStatus: "completed",
				agentId: "project_document_generator",
			}),
			agentId: "project_document_generator",
			requestedVisibility: "SHARED",
		});
	});

	it("fires exactly once on stream error (status.code === 'Failed')", async () => {
		mockMessagesRef.current = [
			makeTextMessage({
				id: "m-2",
				role: "assistant",
				content: "Oops.",
				code: "Failed",
			}),
		];
		renderHook();
		await flushMicrotasks();
		expect(mockMutateAsync).toHaveBeenCalledTimes(1);
		expect(mockMutateAsync.mock.calls[0][0].message).toMatchObject({
			id: "m-2",
			streamStatus: "error",
		});
	});

	it("fires exactly once on stream cancellation (isLoading true → false while last message is Pending)", async () => {
		// Start with a pending message and isLoading true — nothing should
		// be persisted yet.
		mockMessagesRef.current = [
			makeTextMessage({
				id: "m-3",
				role: "assistant",
				content: "Half wri",
				code: "Pending",
			}),
		];
		mockIsLoadingRef.current = true;
		const { rerender } = renderHook();
		await flushMicrotasks();
		expect(mockMutateAsync).not.toHaveBeenCalled();

		// User clicks stop — isLoading flips false while message remains
		// Pending (CopilotKit 1.52 has no `Cancelled` status code).
		mockIsLoadingRef.current = false;
		rerender(
			<CopilotPersistenceHook
				documentRefKind="PROJECT_DOCUMENT"
				documentRefId="doc-1"
				projectId="proj-1"
				organizationId="org-1"
				conversationId={null}
				onConversationIdResolved={vi.fn()}
				onSpilled={vi.fn()}
				requestedVisibility="SHARED"
				agentId="project_document_generator"
			/>,
		);
		await flushMicrotasks();
		expect(mockMutateAsync).toHaveBeenCalledTimes(1);
		expect(mockMutateAsync.mock.calls[0][0].message).toMatchObject({
			id: "m-3",
			streamStatus: "cancelled",
		});
		expect(mockMutateAsync.mock.calls[0][0].message.cancelledAt).toBeTypeOf(
			"string",
		);
	});

	it("NEVER fires on streaming deltas (status.code === 'Pending') — FR-2 hard guarantee", async () => {
		// Simulate several "delta" ticks — each tick replaces the same
		// message id with a longer partial content while status stays
		// Pending. The hook MUST NOT enqueue any of them.
		const { rerender } = renderHook();
		for (let i = 0; i < 50; i++) {
			mockMessagesRef.current = [
				makeTextMessage({
					id: "m-stream",
					role: "assistant",
					content: "x".repeat(i + 1),
					code: "Pending",
				}),
			];
			rerender(
				<CopilotPersistenceHook
					documentRefKind="PROJECT_DOCUMENT"
					documentRefId="doc-1"
					projectId="proj-1"
					organizationId="org-1"
					conversationId={null}
					onConversationIdResolved={vi.fn()}
					onSpilled={vi.fn()}
					requestedVisibility="SHARED"
					agentId="project_document_generator"
				/>,
			);
			await flushMicrotasks();
		}
		expect(mockMutateAsync).toHaveBeenCalledTimes(0);
	});

	it("is idempotent on duplicate message id (server-id idempotency + local guard)", async () => {
		const completed = makeTextMessage({
			id: "m-dup",
			role: "assistant",
			content: "Done.",
			code: "Success",
		});
		mockMessagesRef.current = [completed];
		const { rerender } = renderHook();
		await flushMicrotasks();
		expect(mockMutateAsync).toHaveBeenCalledTimes(1);

		// Same array re-observed (e.g. parent re-render) — the local
		// `Set<string>` guard must prevent a second submission.
		mockMessagesRef.current = [completed];
		rerender(
			<CopilotPersistenceHook
				documentRefKind="PROJECT_DOCUMENT"
				documentRefId="doc-1"
				projectId="proj-1"
				organizationId="org-1"
				conversationId={null}
				onConversationIdResolved={vi.fn()}
				onSpilled={vi.fn()}
				requestedVisibility="SHARED"
				agentId="project_document_generator"
			/>,
		);
		await flushMicrotasks();
		expect(mockMutateAsync).toHaveBeenCalledTimes(1);
	});

	it("propagates `onConversationIdResolved` when the procedure lazy-creates a row", async () => {
		mockMutateAsync.mockResolvedValueOnce({
			conversationId: "conv-fresh",
			persistedAt: "2026-05-19T12:00:01.000Z",
		});
		mockMessagesRef.current = [
			makeTextMessage({
				id: "m-first",
				role: "user",
				content: "Tighten the intro.",
				code: "Success",
			}),
		];
		const onResolved = vi.fn();
		renderHook({
			conversationId: null,
			onConversationIdResolved: onResolved,
		});
		await flushMicrotasks();
		expect(onResolved).toHaveBeenCalledWith("conv-fresh");
	});

	it("propagates `onSpilled` when the procedure returns a continuation id", async () => {
		mockMutateAsync.mockResolvedValueOnce({
			conversationId: "conv-cont",
			persistedAt: "2026-05-19T12:00:01.000Z",
			spilledTo: "conv-cont",
		});
		mockMessagesRef.current = [
			makeTextMessage({
				id: "m-spill",
				role: "assistant",
				content: "Continuation turn.",
				code: "Success",
			}),
		];
		const onSpilled = vi.fn();
		renderHook({
			conversationId: "conv-original",
			onSpilled,
		});
		await flushMicrotasks();
		expect(onSpilled).toHaveBeenCalledWith("conv-cont");
	});

	it("silently swallows CONFLICT 'history is disabled' (no toast, no rethrow)", async () => {
		mockMutateAsync.mockRejectedValueOnce(
			new Error(
				"Document assistant history is disabled for this organization",
			),
		);
		mockMessagesRef.current = [
			makeTextMessage({
				id: "m-disabled",
				role: "assistant",
				content: "Done.",
				code: "Success",
			}),
		];
		renderHook();
		await flushMicrotasks();
		expect(mockToastError).not.toHaveBeenCalled();
		expect(consoleWarnSpy).not.toHaveBeenCalled();
		expect(consoleInfoSpy).toHaveBeenCalled();
		expect(consoleInfoSpy.mock.calls[0]?.[0]).toMatch(
			/feature flag disabled/i,
		);
	});

	it("surfaces the 50/day cap CONFLICT via sonner toast.error", async () => {
		mockMutateAsync.mockRejectedValueOnce(
			new Error(
				"You've started 50 conversations on this document today — try again tomorrow or continue the most recent thread.",
			),
		);
		mockMessagesRef.current = [
			makeTextMessage({
				id: "m-cap",
				role: "user",
				content: "Another turn.",
				code: "Success",
			}),
		];
		renderHook();
		await flushMicrotasks();
		expect(mockToastError).toHaveBeenCalledTimes(1);
		expect(mockToastError.mock.calls[0][0]).toMatch(/50 conversations/);
	});

	// -----------------------------------------------------------------------
	// Concurrency — serialised persist queue
	// -----------------------------------------------------------------------

	it("serialises parallel terminal messages so the second call sees the first's resolved conversationId", async () => {
		// Real-world race: a single generation produces (user turn,
		// assistant turn) in quick succession. Without serialisation BOTH
		// calls would launch with conversationId === null and the server
		// would lazy-create TWO conversations (one per message).
		//
		// We resolve the first mutateAsync with a lazy-created id, then
		// assert that the second call carries that id forward instead of
		// re-creating.
		let firstCallResolve: (value: unknown) => void = () => {};
		const firstCallPromise = new Promise((resolve) => {
			firstCallResolve = resolve;
		});
		mockMutateAsync.mockImplementationOnce(() => firstCallPromise);
		mockMutateAsync.mockResolvedValueOnce({
			conversationId: "conv-lazy-created",
			persistedAt: "2026-05-19T12:00:02.000Z",
		});

		mockMessagesRef.current = [
			makeTextMessage({
				id: "user-msg",
				role: "user",
				content: "Tighten the intro.",
				code: "Success",
			}),
			makeTextMessage({
				id: "assistant-msg",
				role: "assistant",
				content: "Done.",
				code: "Success",
			}),
		];
		renderHook({ conversationId: null });
		await flushMicrotasks();

		// Only the first call should be in flight — the worker is awaiting
		// it before pulling the second message off the queue.
		expect(mockMutateAsync).toHaveBeenCalledTimes(1);
		expect(mockMutateAsync.mock.calls[0][0]).toMatchObject({
			conversationId: null,
			message: expect.objectContaining({ id: "user-msg" }),
		});

		// Resolve the first call → the worker should now drain the
		// assistant message with the freshly-resolved conversation id.
		await act(async () => {
			firstCallResolve({
				conversationId: "conv-lazy-created",
				persistedAt: "2026-05-19T12:00:01.000Z",
			});
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(mockMutateAsync).toHaveBeenCalledTimes(2);
		expect(mockMutateAsync.mock.calls[1][0]).toMatchObject({
			conversationId: "conv-lazy-created",
			message: expect.objectContaining({ id: "assistant-msg" }),
		});
	});
});

// ---------------------------------------------------------------------------
// The CopilotKit thread offered as the conversation's id (`assistant-thread`)
// ---------------------------------------------------------------------------

describe("CopilotPersistenceHook — thread id as the conversation id", () => {
	const THREAD = "thread-example-0001";

	function renderInThread(
		conversationId: string | null,
		thread: { threadId: string } | null = { threadId: THREAD },
	) {
		return rtlRender(
			<CopilotPersistenceHook
				documentRefKind="PROJECT_DOCUMENT"
				documentRefId="doc-1"
				projectId="proj-1"
				organizationId="org-1"
				conversationId={conversationId}
				onConversationIdResolved={vi.fn()}
				onSpilled={vi.fn()}
				requestedVisibility="SHARED"
				agentId="project_document_generator"
			/>,
			{
				wrapper: ({ children }) => (
					<AssistantThreadProvider
						value={thread && { ...thread, startNewThread: vi.fn() }}
					>
						<CopilotChatSessionProvider>
							{children}
						</CopilotChatSessionProvider>
					</AssistantThreadProvider>
				),
			},
		);
	}

	beforeEach(() => {
		mockIsLoadingRef.current = false;
		mockMutateAsync.mockReset().mockResolvedValue({
			conversationId: THREAD,
			persistedAt: "2026-05-19T12:00:01.000Z",
		});
		mockMessagesRef.current = [
			makeTextMessage({
				id: "user-msg",
				role: "user",
				content: "Tighten the intro.",
				code: "Success",
			}),
			makeTextMessage({
				id: "assistant-msg",
				role: "assistant",
				content: "Done.",
				code: "Success",
			}),
		];
		vi.spyOn(console, "info").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("offers the thread id for the conversation the first turn creates, and only then", async () => {
		renderInThread(null);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(mockMutateAsync).toHaveBeenCalledTimes(2);
		expect(mockMutateAsync.mock.calls[0][0]).toMatchObject({
			conversationId: null,
			proposedConversationId: THREAD,
			message: expect.objectContaining({ id: "user-msg" }),
		});
		expect(mockMutateAsync.mock.calls[1][0]).toMatchObject({
			conversationId: THREAD,
			message: expect.objectContaining({ id: "assistant-msg" }),
		});
		expect(mockMutateAsync.mock.calls[1][0]).not.toHaveProperty(
			"proposedConversationId",
		);
	});

	it("offers nothing for a turn of an existing conversation", async () => {
		renderInThread("conv-existing");
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(mockMutateAsync).toHaveBeenCalledTimes(2);
		for (const [input] of mockMutateAsync.mock.calls) {
			expect(input).toMatchObject({ conversationId: "conv-existing" });
			expect(input).not.toHaveProperty("proposedConversationId");
		}
	});

	it("offers nothing outside an assistant mount", async () => {
		renderInThread(null, null);
		await act(async () => {
			await Promise.resolve();
		});

		expect(mockMutateAsync.mock.calls[0][0]).toMatchObject({
			conversationId: null,
		});
		expect(mockMutateAsync.mock.calls[0][0]).not.toHaveProperty(
			"proposedConversationId",
		);
	});
});

// ---------------------------------------------------------------------------
// `computeFingerprint` — pure helper covering the effect-dep contract
// ---------------------------------------------------------------------------

describe("computeFingerprint — effect dependency stability", () => {
	it("returns the empty-array sentinel for empty / undefined inputs", () => {
		expect(computeFingerprint(undefined)).toBe("0::");
		expect(computeFingerprint([])).toBe("0::");
	});

	it("distinguishes a Pending → Success transition on the trailing message", () => {
		const pending = computeFingerprint([
			// biome-ignore lint/suspicious/noExplicitAny: structural fixture
			{ id: "m-1", status: { code: "Pending" } } as any,
		]);
		const success = computeFingerprint([
			// biome-ignore lint/suspicious/noExplicitAny: structural fixture
			{ id: "m-1", status: { code: "Success" } } as any,
		]);
		expect(pending).not.toBe(success);
	});

	it("distinguishes appending a second message even when the trailing entry's status is unchanged", () => {
		const one = computeFingerprint([
			// biome-ignore lint/suspicious/noExplicitAny: structural fixture
			{ id: "m-1", status: { code: "Success" } } as any,
		]);
		const two = computeFingerprint([
			// biome-ignore lint/suspicious/noExplicitAny: structural fixture
			{ id: "m-1", status: { code: "Success" } } as any,
			// biome-ignore lint/suspicious/noExplicitAny: structural fixture
			{ id: "m-2", status: { code: "Pending" } } as any,
		]);
		expect(one).not.toBe(two);
	});

	it("captures the second-to-last status so a (user-Success, assistant-Success) tick differs from (user-Success, assistant-Pending)", () => {
		const trailingPending = computeFingerprint([
			// biome-ignore lint/suspicious/noExplicitAny: structural fixture
			{ id: "user", status: { code: "Success" } } as any,
			// biome-ignore lint/suspicious/noExplicitAny: structural fixture
			{ id: "asst", status: { code: "Pending" } } as any,
		]);
		const trailingSuccess = computeFingerprint([
			// biome-ignore lint/suspicious/noExplicitAny: structural fixture
			{ id: "user", status: { code: "Success" } } as any,
			// biome-ignore lint/suspicious/noExplicitAny: structural fixture
			{ id: "asst", status: { code: "Success" } } as any,
		]);
		expect(trailingPending).not.toBe(trailingSuccess);
	});

	it("returns the same fingerprint for two renders with identical contents (no spurious re-walk)", () => {
		const a = computeFingerprint([
			// biome-ignore lint/suspicious/noExplicitAny: structural fixture
			{ id: "m-1", status: { code: "Pending" } } as any,
			// biome-ignore lint/suspicious/noExplicitAny: structural fixture
			{ id: "m-2", status: { code: "Pending" } } as any,
		]);
		const b = computeFingerprint([
			// biome-ignore lint/suspicious/noExplicitAny: structural fixture
			{ id: "m-1", status: { code: "Pending" } } as any,
			// biome-ignore lint/suspicious/noExplicitAny: structural fixture
			{ id: "m-2", status: { code: "Pending" } } as any,
		]);
		expect(a).toBe(b);
	});
});

it("saves the final bounded trace on the reply after the stream settles", async () => {
	mockMutateAsync.mockReset();
	mockMutateAsync.mockResolvedValue({ conversationId: "conv-new" });
	const user = { id: "trace-user", role: "user", content: "help" };
	const reply = { id: "trace-reply", role: "assistant", content: "done" };
	mockMessagesRef.current = [
		user,
		reply,
		{ id: "result", role: "tool", toolCallId: "tool-0", content: "ok" },
		{
			id: "failed-result",
			role: "tool",
			toolCallId: "tool-2",
			content: "Error: failed",
		},
	];
	mockIsLoadingRef.current = true;
	traceState.current = {};
	const view = renderHook();
	runEvent("onRunInitialized");
	await flushMicrotasks();
	expect(
		mockMutateAsync.mock.calls.some(([v]) => v.message.id === reply.id),
	).toBe(false);
	traceState.current = {
		messages: [user, reply],
		reasoningByTurn: { 1: { text: "final reasoning", durationMs: 42 } },
		toolCallsByTurn: {
			1: Array.from({ length: 150 }, (_, i) => ({
				id: `tool-${i}`,
				name: i === 1 ? "write_document_local" : "search",
				status: "pending",
				startedAt: 1,
				args: { secret: true },
				result: "private",
			})),
		},
	};
	runEvent("onRunFinishedEvent", { outcome: "success" });
	runEvent("onRunFinalized");
	mockIsLoadingRef.current = false;
	view.rerender(
		<CopilotPersistenceHook
			documentRefKind="PROJECT_DOCUMENT"
			documentRefId="doc-1"
			projectId="proj-1"
			organizationId="org-1"
			conversationId="conv-new"
			onConversationIdResolved={() => {}}
			onSpilled={() => {}}
			requestedVisibility="SHARED"
			agentId="project_document_generator"
		/>,
	);
	await flushMicrotasks();
	const saved = mockMutateAsync.mock.calls.find(
		([v]) => v.message.id === reply.id,
	)?.[0].message;
	expect(saved).toMatchObject({
		reasoningText: "final reasoning",
		reasoningDurationMs: 42,
	});
	expect(saved.metadata.fabricAssistantToolTrace).toHaveLength(100);
	expect(saved.metadata.fabricAssistantToolTrace[0]).toEqual({
		id: "tool-0",
		name: "search",
		status: "success",
		startedAt: 1,
	});
	expect(saved.metadata.fabricAssistantToolTrace[1].status).toBe("waiting");
	expect(saved.metadata.fabricAssistantToolTrace[2].status).toBe("error");
	expect(JSON.stringify(saved.metadata)).not.toMatch(
		/secret|private|final reasoning/,
	);
});

it("saves stopped tools including unresolved confirmations", async () => {
	mockMutateAsync.mockReset();
	mockMutateAsync.mockResolvedValue({ conversationId: "conv-new" });
	const user = { id: "stop-user", role: "user", content: "help" };
	const reply = { id: "stop-reply", role: "assistant", content: "partial" };
	mockMessagesRef.current = [user, reply];
	traceState.current = {
		messages: [user, reply],
		toolCallsByTurn: {
			1: [
				{
					id: "stopped",
					name: "search",
					status: "pending",
					startedAt: 1,
				},
				{
					id: "waiting",
					name: "apply_document_patches",
					status: "pending",
					startedAt: 2,
				},
			],
		},
	};
	mockIsLoadingRef.current = true;
	const view = renderHook();
	await flushMicrotasks();
	runEvent("onRunInitialized");
	runEvent("onRunErrorEvent", { event: { code: "abort" } });
	runEvent("onRunFinalized");
	mockIsLoadingRef.current = false;
	view.rerender(
		<CopilotPersistenceHook
			documentRefKind="PROJECT_DOCUMENT"
			documentRefId="doc-1"
			projectId="proj-1"
			organizationId="org-1"
			conversationId="conv-new"
			onConversationIdResolved={() => {}}
			onSpilled={() => {}}
			requestedVisibility="SHARED"
			agentId="project_document_generator"
		/>,
	);
	await flushMicrotasks();
	const saved = mockMutateAsync.mock.calls.find(
		([v]) => v.message.id === reply.id,
	)?.[0].message;
	expect(saved.streamStatus).toBe("cancelled");
	expect(saved.metadata.fabricAssistantToolTrace).toEqual([
		{
			id: "stopped",
			name: "search",
			status: "stopped",
			startedAt: 1,
		},
		{
			id: "waiting",
			name: "apply_document_patches",
			status: "stopped",
			startedAt: 2,
		},
	]);
});

it("persists a frontend answer on an already saved parent reply", async () => {
	mockMutateAsync.mockReset();
	mockMutateAsync.mockResolvedValue({ conversationId: "conv-new" });
	const user = { id: "question-user", role: "user", content: "help" };
	const reply = {
		id: "question-reply",
		role: "assistant",
		content: "A question",
	};
	const sibling = {
		id: "question-call",
		role: "assistant",
		toolCalls: [
			{ id: "question-id", name: "ask_clarifying_question", args: {} },
		],
	};
	mockMessagesRef.current = [user, reply, sibling];
	traceState.current = {
		messages: [user, reply],
		toolCallsByTurn: {
			1: [
				{
					id: "question-id",
					name: "ask_clarifying_question",
					status: "pending",
				},
			],
		},
	};
	mockIsLoadingRef.current = true;
	const view = renderHook();
	await flushMicrotasks();
	const rerender = () =>
		view.rerender(
			<CopilotPersistenceHook
				documentRefKind="PROJECT_DOCUMENT"
				documentRefId="doc-1"
				projectId="proj-1"
				organizationId="org-1"
				conversationId="conv-new"
				onConversationIdResolved={() => {}}
				onSpilled={() => {}}
				requestedVisibility="SHARED"
				agentId="project_document_generator"
			/>,
		);
	mockIsLoadingRef.current = false;
	rerender();
	await flushMicrotasks();
	expect(
		mockMutateAsync.mock.calls.find(([v]) => v.message.id === reply.id)?.[0]
			.message.metadata.fabricAssistantToolTrace[0].status,
	).toBe("waiting");
	mockMutateAsync.mockClear();
	mockMessagesRef.current = [
		...mockMessagesRef.current,
		{
			id: "answer",
			role: "tool",
			toolCallId: "question-id",
			content: '{"answered":true,"answer":"Yes"}',
		},
		{ id: "next-user", role: "user", content: "continue" },
	];
	traceState.current = {};
	rerender();
	await flushMicrotasks();
	expect(
		mockMutateAsync.mock.calls.find(([v]) => v.message.id === reply.id)?.[0]
			.message.toolCalls,
	).toEqual([
		expect.objectContaining({
			id: "question-id",
			status: "success",
			result: '{"answered":true,"answer":"Yes"}',
		}),
	]);
});

for (const failure of ["onRunErrorEvent", "onRunFailed"]) {
	it(`saves plain AG-UI errors after finalization: ${failure}`, async () => {
		mockMutateAsync.mockReset();
		mockMutateAsync.mockResolvedValue({ conversationId: "conv-new" });
		const user = { id: "error-user", role: "user", content: "help" };
		const reply = {
			id: "error-reply",
			role: "assistant",
			content: "partial",
		};
		mockMessagesRef.current = [user, reply];
		traceState.current = {};
		mockIsLoadingRef.current = true;
		const view = renderHook();
		runEvent("onRunInitialized");
		runEvent(failure, {
			event: { code: "server_error" },
			error: new Error("failed"),
		});
		mockIsLoadingRef.current = false;
		view.rerender(
			<CopilotPersistenceHook
				documentRefKind="PROJECT_DOCUMENT"
				documentRefId="doc-1"
				projectId="proj-1"
				organizationId="org-1"
				conversationId="conv-new"
				onConversationIdResolved={() => {}}
				onSpilled={() => {}}
				requestedVisibility="SHARED"
				agentId="project_document_generator"
			/>,
		);
		await flushMicrotasks();
		expect(
			mockMutateAsync.mock.calls.some(([v]) => v.message.id === reply.id),
		).toBe(false);
		traceState.current = {
			messages: [user, reply],
			toolCallsByTurn: {
				1: [
					{
						id: "cut-off",
						name: "search_project_knowledge",
						status: "pending",
					},
				],
			},
		};
		runEvent("onRunFinalized");
		await flushMicrotasks();
		const saved = mockMutateAsync.mock.calls.find(
			([v]) => v.message.id === reply.id,
		)?.[0].message;
		expect(saved.streamStatus).toBe("error");
		expect(saved.metadata.fabricAssistantToolTrace[0].status).toBe(
			"stopped",
		);
	});
}

it("pins late outcomes and late calls to the reply's conversation across a spill", async () => {
	mockMutateAsync.mockReset();
	mockMutateAsync.mockImplementation(async (input) =>
		input.message.id === "spill-user"
			? {
					conversationId: "conv-continuation",
					spilledTo: "conv-continuation",
				}
			: { conversationId: "conv-original" },
	);
	const user = { id: "original-user", role: "user", content: "help" };
	const reply = {
		id: "original-reply",
		role: "assistant",
		content: "question",
		toolCalls: [
			{
				id: "question",
				function: { name: "ask_clarifying_question", arguments: "{}" },
			},
		],
	};
	mockMessagesRef.current = [user, reply];
	traceState.current = {};
	mockIsLoadingRef.current = true;
	const view = renderHook({ conversationId: "conv-original" });
	const rerender = () =>
		view.rerender(
			<CopilotPersistenceHook
				documentRefKind="PROJECT_DOCUMENT"
				documentRefId="doc-1"
				projectId="proj-1"
				organizationId="org-1"
				conversationId="conv-original"
				onConversationIdResolved={() => {}}
				onSpilled={() => {}}
				requestedVisibility="SHARED"
				agentId="project_document_generator"
			/>,
		);
	mockIsLoadingRef.current = false;
	rerender();
	await flushMicrotasks();
	mockMessagesRef.current = [
		...mockMessagesRef.current,
		{ id: "spill-user", role: "user", content: "continue" },
	];
	rerender();
	await flushMicrotasks();
	mockMutateAsync.mockClear();
	// The outcome mutates an existing call, without changing message ids or count.
	(reply.toolCalls[0] as any).result = '{"answered":true}';
	rerender();
	await flushMicrotasks();
	expect(mockMutateAsync).toHaveBeenCalledWith(
		expect.objectContaining({
			conversationId: "conv-original",
			patchOnly: true,
			message: expect.objectContaining({ id: reply.id, content: "" }),
		}),
	);
	mockMutateAsync.mockClear();
	mockMessagesRef.current = [
		user,
		reply,
		{
			id: "late-call",
			role: "assistant",
			toolCalls: [
				{
					id: "late",
					function: { name: "write_document_local", arguments: "{}" },
				},
			],
		},
		...mockMessagesRef.current.slice(2),
	];
	rerender();
	await flushMicrotasks();
	expect(mockMutateAsync).toHaveBeenCalledWith(
		expect.objectContaining({
			conversationId: "conv-original",
			patchOnly: true,
			message: expect.objectContaining({ id: reply.id }),
		}),
	);
});

it("does no trace parsing or serialization while plain messages stream", async () => {
	mockMutateAsync.mockReset();
	mockMutateAsync.mockResolvedValue({ conversationId: "conv-new" });
	mockMessagesRef.current = [
		{ id: "chunk-user", role: "user", content: "help" },
		{
			id: "chunk-reply",
			role: "assistant",
			content: "partial",
			toolCalls: [
				{
					id: "chunk-tool",
					function: {
						name: "search",
						arguments: '{"query":"example"}',
					},
				},
			],
		},
	];
	mockIsLoadingRef.current = true;
	traceState.current = {};
	const view = renderHook();
	runEvent("onRunInitialized");
	await flushMicrotasks();
	const stringify = vi.spyOn(JSON, "stringify");
	const parse = vi.spyOn(JSON, "parse");
	try {
		for (let i = 0; i < 100; i++) {
			traceState.current = {
				streamingContent: `chunk ${i}`,
				document: `document ${i}`,
				...(i % 3 === 0
					? {
							toolCallsByTurn: {
								1: [
									{
										id: "chunk-tool",
										name: "search",
										status: "pending",
									},
								],
							},
							reasoningByTurn: { 1: { text: "reasoning" } },
						}
					: {}),
			};
			runEvent("onStateChanged", { state: traceState.current });
			mockMessagesRef.current = mockMessagesRef.current.map((m) =>
				m.role === "assistant" ? { ...m, content: `chunk ${i}` } : m,
			);
			view.rerender(
				<CopilotPersistenceHook
					documentRefKind="PROJECT_DOCUMENT"
					documentRefId="doc-1"
					projectId="proj-1"
					organizationId="org-1"
					conversationId="conv-new"
					onConversationIdResolved={() => {}}
					onSpilled={() => {}}
					requestedVisibility="SHARED"
					agentId="project_document_generator"
				/>,
			);
		}
		expect(stringify).not.toHaveBeenCalled();
		expect(parse).not.toHaveBeenCalled();
		expect(
			mockMutateAsync.mock.calls.some(
				([v]) => v.message.role === "assistant",
			),
		).toBe(false);
	} finally {
		stringify.mockRestore();
		parse.mockRestore();
	}
});

it("does not send a late patch after the reply's initial append failed", async () => {
	mockMutateAsync.mockReset();
	mockMutateAsync.mockImplementation(async (input) => {
		if (input.message.id === "failed-reply") {
			throw new Error("write failed");
		}
		return { conversationId: "conv-new" };
	});
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const user = { id: "failed-user", role: "user", content: "help" };
		const reply = {
			id: "failed-reply",
			role: "assistant",
			content: "question",
			toolCalls: [
				{
					id: "failed-question",
					function: {
						name: "ask_clarifying_question",
						arguments: "{}",
					},
				},
			],
		};
		mockMessagesRef.current = [user, reply];
		traceState.current = {};
		mockIsLoadingRef.current = true;
		const view = renderHook({ conversationId: "conv-new" });
		mockIsLoadingRef.current = false;
		const rerender = () =>
			view.rerender(
				<CopilotPersistenceHook
					documentRefKind="PROJECT_DOCUMENT"
					documentRefId="doc-1"
					projectId="proj-1"
					organizationId="org-1"
					conversationId="conv-new"
					onConversationIdResolved={() => {}}
					onSpilled={() => {}}
					requestedVisibility="SHARED"
					agentId="project_document_generator"
				/>,
			);
		rerender();
		await flushMicrotasks();
		mockMutateAsync.mockClear();
		mockMessagesRef.current = [
			...mockMessagesRef.current,
			{
				id: "failed-answer",
				role: "tool",
				toolCallId: "failed-question",
				content: "answer",
			},
		];
		rerender();
		await flushMicrotasks();
		expect(mockMutateAsync).not.toHaveBeenCalled();
	} finally {
		warn.mockRestore();
	}
});

it("saves a plain user message during an active run and waits to save the assistant's final trace", async () => {
	mockMutateAsync.mockReset();
	mockMutateAsync.mockResolvedValue({ conversationId: "conv-new" });
	mockMessagesRef.current = [];
	mockIsLoadingRef.current = true;
	traceState.current = {};
	const view = renderHook();
	runEvent("onRunInitialized");
	const user = {
		id: "mid-run-user",
		role: "user",
		content: "Save this prompt.",
	};
	const reply = {
		id: "mid-run-reply",
		role: "assistant",
		content: "partial",
		toolCalls: [
			{
				id: "mid-run-tool",
				function: { name: "search", arguments: '{"query":' },
			},
		],
	};
	const rerender = () =>
		view.rerender(
			<CopilotPersistenceHook
				documentRefKind="PROJECT_DOCUMENT"
				documentRefId="doc-1"
				projectId="proj-1"
				organizationId="org-1"
				conversationId={null}
				onConversationIdResolved={view.onConversationIdResolved}
				onSpilled={view.onSpilled}
				requestedVisibility="SHARED"
				agentId="project_document_generator"
			/>,
		);
	const stateRead = vi.spyOn(runAgent, "state", "get");
	try {
		mockMessagesRef.current = [user, reply];
		rerender();
		await flushMicrotasks();
		expect(mockMutateAsync).toHaveBeenCalledTimes(1);
		expect(mockMutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: null,
				requestedVisibility: "SHARED",
				message: expect.objectContaining({
					id: user.id,
					role: "user",
					content: user.content,
					streamStatus: "completed",
				}),
			}),
		);
		expect(view.onConversationIdResolved).toHaveBeenCalledWith("conv-new");
		expect(stateRead).not.toHaveBeenCalled();
		// The session can clear loading before the agent's final state is applied.
		mockIsLoadingRef.current = false;
		rerender();
		await flushMicrotasks();
		expect(mockMutateAsync).toHaveBeenCalledTimes(1);
		expect(stateRead).not.toHaveBeenCalled();
		traceState.current = {
			messages: [user, reply],
			reasoningByTurn: { 1: { text: "final reasoning" } },
			toolCallsByTurn: {
				1: [{ id: "mid-run-tool", name: "search", status: "success" }],
			},
		};
		runEvent("onRunFinishedEvent", { outcome: "success" });
		runEvent("onRunFinalized");
		await flushMicrotasks();
		expect(mockMutateAsync).toHaveBeenCalledTimes(2);
		expect(mockMutateAsync.mock.calls[1][0]).toMatchObject({
			conversationId: "conv-new",
			message: {
				id: reply.id,
				reasoningText: "final reasoning",
				metadata: {
					fabricAssistantToolTrace: [
						{
							id: "mid-run-tool",
							name: "search",
							status: "success",
						},
					],
				},
			},
		});
	} finally {
		stateRead.mockRestore();
	}
});

function applyTraceState(state: Record<string, unknown>) {
	traceState.current = state;
	runEvent("onStateChanged", { state });
}

function serializedTraceMessage(
	id: string,
	kind: "HumanMessage" | "AIMessage" | "ToolMessage",
) {
	return {
		lc: 1,
		type: "constructor",
		id: ["langchain_core", "messages", kind],
		kwargs: { id, content: "example" },
	};
}

for (const window of [
	"in-session",
	"reload without replay",
	"replay",
] as const) {
	for (const end of ["cancelled", "error", "completed"] as const) {
		it(`retains applied trace maps through partial snapshots: ${window}, ${end}`, async () => {
			mockMutateAsync.mockReset();
			mockMutateAsync.mockResolvedValue({ conversationId: "conv-new" });
			const history =
				window === "reload without replay"
					? []
					: [
							{
								id: "prior-user",
								role: "user",
								content: "before",
							},
							{
								id: "prior-reply",
								role: "assistant",
								content: "saved",
							},
						];
			const user = { id: "partial-user", role: "user", content: "help" };
			const reply = {
				id: "partial-reply",
				role: "assistant",
				content: "partial",
			};
			const turn = history.length ? 2 : 1;
			mockMessagesRef.current = [...history, user, reply];
			mockIsLoadingRef.current = true;
			traceState.current = {};
			const ui = () => (
				<CopilotPersistenceHook
					documentRefKind="PROJECT_DOCUMENT"
					documentRefId="doc-1"
					projectId="proj-1"
					organizationId="org-1"
					conversationId="conv-new"
					initialPersistedMessageIds={history.map((m) => m.id)}
					onConversationIdResolved={() => {}}
					onSpilled={() => {}}
					requestedVisibility="SHARED"
					agentId="project_document_generator"
				/>
			);
			const view = render(ui());
			runEvent("onRunInitialized");
			applyTraceState({});
			const firstTool = {
				id: "partial-search",
				name: "search_project_knowledge",
				status: "pending",
				startedAt: 1,
			};
			applyTraceState({
				toolCallsByTurn: { [turn]: [firstTool] },
				reasoningByTurn: {
					[turn]: { text: "early reasoning", durationMs: 1 },
				},
			});
			// A map for another turn must not replace the current turn's entry.
			applyTraceState({
				toolCallsByTurn: {
					99: [{ id: "other", name: "other", status: "success" }],
				},
			});
			applyTraceState({
				toolCallsByTurn: {
					[turn]: [
						firstTool,
						{
							id: "resolved-tool",
							name: "search",
							status: "success",
							startedAt: 2,
						},
					],
				},
				reasoningByTurn: {
					[turn]: { text: "latest reasoning", durationMs: 42 },
				},
			});
			const stateMessages = [
				serializedTraceMessage("result-one", "ToolMessage"),
				serializedTraceMessage("result-two", "ToolMessage"),
			];
			applyTraceState({ messages: stateMessages });
			if (end === "completed") {
				// A completed terminal snapshot overrides an accumulated turn entry.
				traceState.current = {
					messages: [...history, user, reply].map((m) =>
						serializedTraceMessage(
							m.id,
							m.role === "user" ? "HumanMessage" : "AIMessage",
						),
					),
					toolCallsByTurn: {
						[turn]: [
							{
								...firstTool,
								status: "error",
								errorMessage: "terminal failure",
							},
						],
					},
					reasoningByTurn: {
						[turn]: { text: "terminal reasoning", durationMs: 84 },
					},
				};
				runEvent("onRunFinishedEvent", { outcome: "success" });
			} else {
				runEvent("onRunErrorEvent", {
					event: {
						code: end === "cancelled" ? "abort" : "server_error",
					},
				});
			}
			runEvent("onRunFinalized");
			mockIsLoadingRef.current = false;
			view.rerender(ui());
			await flushMicrotasks();
			const saved = mockMutateAsync.mock.calls.find(
				([v]) => v.message.id === reply.id,
			)?.[0].message;
			expect(saved.streamStatus).toBe(end);
			expect(saved.metadata?.fabricAssistantToolTrace).toEqual(
				end === "completed"
					? [
							{
								...firstTool,
								status: "error",
								errorMessage: "terminal failure",
							},
						]
					: [
							{ ...firstTool, status: "stopped" },
							{
								id: "resolved-tool",
								name: "search",
								status: "success",
								startedAt: 2,
							},
						],
			);
			expect(saved.reasoningText).toBe(
				end === "completed" ? "terminal reasoning" : "latest reasoning",
			);
			expect(saved.reasoningDurationMs).toBe(
				end === "completed" ? 84 : 42,
			);
			expect(saved.metadata).not.toHaveProperty("reasoningText");
		});
	}
}

it("resets accumulated trace maps when the next run starts", async () => {
	mockMutateAsync.mockReset();
	mockMutateAsync.mockResolvedValue({ conversationId: "conv-new" });
	mockMessagesRef.current = [
		{ id: "reset-user-one", role: "user", content: "one" },
		{ id: "reset-reply-one", role: "assistant", content: "first" },
	];
	mockIsLoadingRef.current = true;
	traceState.current = {};
	const ui = () => (
		<CopilotPersistenceHook
			documentRefKind="PROJECT_DOCUMENT"
			documentRefId="doc-1"
			projectId="proj-1"
			organizationId="org-1"
			conversationId="conv-new"
			onConversationIdResolved={() => {}}
			onSpilled={() => {}}
			requestedVisibility="SHARED"
			agentId="project_document_generator"
		/>
	);
	const view = render(ui());
	runEvent("onRunInitialized");
	applyTraceState({
		toolCallsByTurn: {
			1: [{ id: "previous", name: "search", status: "pending" }],
		},
		reasoningByTurn: { 1: { text: "previous reasoning" } },
	});
	applyTraceState({});
	runEvent("onRunErrorEvent", { event: { code: "abort" } });
	runEvent("onRunFinalized");
	mockIsLoadingRef.current = false;
	view.rerender(ui());
	await flushMicrotasks();
	expect(
		mockMutateAsync.mock.calls.find(
			([v]) => v.message.id === "reset-reply-one",
		)?.[0].message,
	).toMatchObject({
		reasoningText: "previous reasoning",
		metadata: {
			fabricAssistantToolTrace: [
				{ id: "previous", name: "search", status: "stopped" },
			],
		},
	});
	// A fresh input window can reuse turn 1 after reloading without replay.
	mockMessagesRef.current = [
		{ id: "reset-user-two", role: "user", content: "two" },
		{ id: "reset-reply-two", role: "assistant", content: "second" },
	];
	mockIsLoadingRef.current = true;
	view.rerender(ui());
	runEvent("onRunInitialized");
	applyTraceState({});
	runEvent("onRunFinishedEvent", { outcome: "success" });
	runEvent("onRunFinalized");
	mockIsLoadingRef.current = false;
	view.rerender(ui());
	await flushMicrotasks();
	const saved = mockMutateAsync.mock.calls.find(
		([v]) => v.message.id === "reset-reply-two",
	)?.[0].message;
	expect(saved).toBeDefined();
	expect(saved.reasoningText).toBeUndefined();
	expect(saved.metadata?.fabricAssistantToolTrace).toBeUndefined();
});
