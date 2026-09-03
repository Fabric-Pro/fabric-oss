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
