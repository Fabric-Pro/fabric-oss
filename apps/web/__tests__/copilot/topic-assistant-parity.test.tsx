/**
 * The publishing Topic Assistant's parity with the Feature Maturation rail:
 * the agent's reasoning trace, its clarifying-question tool, and a conversation
 * that survives leaving the page.
 *
 * All three were missing for the same reason — the agent behind this rail is
 * the same `project_document_generator` FMv2 mounts, and the whole
 * document-assistant history stack already accepts a `PUBLISHING_TOPIC`
 * document ref. Nothing was absent server-side; props were simply never passed.
 * Nothing threw and nothing logged, so the chat was just quieter and more
 * forgetful than the one next door.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. CopilotKit and the persistence stack are
 * stubbed, so these are WIRING assertions: the right component reference
 * reaches the right prop, the right scope reaches each provider, and the hook
 * is mounted with the right arguments. They do not exercise a real turn, a real
 * append, or a real rehydration — those need the oRPC layer and belong to
 * integration coverage.
 *
 * Two assertions here have teeth beyond wiring:
 *
 *   - Component IDENTITY for `AssistantMessage` and `initialMessages`. Both are
 *     module-scope constants precisely so call sites need no `useMemo`, and
 *     both sit in a `useMemo` dependency array downstream. An edit that wraps
 *     either in a factory or an inline literal would remount the message list
 *     or recompute the historical set on every streaming tick — silent in a
 *     browser, red here.
 *   - The render helper asserts the sidebar was reached at all. The component's
 *     error boundary renders `null` on any throw, by design, so a missing
 *     provider would otherwise show up as a confusingly empty capture array
 *     rather than as the failure it is.
 */

import { act, fireEvent, render as rtlRender } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted capture points
// ---------------------------------------------------------------------------

const {
	sidebarProps,
	registeredActions,
	clarifyingCalls,
	persistenceProps,
	hydratedProps,
	outcomesProps,
	attachmentProps,
	drawerProps,
	activeConversation,
	routeParams,
	chatIsLoading,
	historyFlag,
	sessionUser,
	setLiveMessages,
	archiveForDocument,
	toastSuccess,
	toastError,
	AssistantSentinel,
	MessagesSentinel,
} = vi.hoisted(() => ({
	/** Props `<CopilotSidebar>` received, one entry per render. */
	sidebarProps: [] as Array<Record<string, unknown>>,
	/** Action configs the surface registered directly via `useCopilotAction`. */
	registeredActions: [] as Array<{ name?: string }>,
	/** Arguments `useClarifyingQuestions` was mounted with. */
	clarifyingCalls: [] as Array<Record<string, unknown> | undefined>,
	/** Props `<CopilotPersistenceHook>` received. */
	persistenceProps: [] as Array<Record<string, unknown>>,
	/** Props `<HydratedMessagesProvider>` received. */
	hydratedProps: [] as Array<Record<string, unknown>>,
	/** Props `<DocumentAssistantOutcomesProvider>` received. */
	outcomesProps: [] as Array<Record<string, unknown>>,
	/** Props `<AttachmentRegistryProvider>` received. */
	attachmentProps: [] as Array<Record<string, unknown>>,
	/** Props `<CopilotHistoryDrawer>` received, one entry per render. */
	drawerProps: [] as Array<Record<string, unknown>>,
	/** What the active-conversation query resolves to. */
	activeConversation: {
		current: null as { conversation?: unknown } | null,
	},
	/** What `useParams()` returns — the topic id lives in the route. */
	routeParams: { current: {} as Record<string, string | undefined> },
	/** Stands in for a run being in flight; read at render by the session mock. */
	chatIsLoading: { current: false },
	/** The org's chat-history feature flag. */
	historyFlag: { current: true },
	/** The signed-in user, or null while the session is still resolving. */
	sessionUser: { current: { id: "user-1" } as { id: string } | null },
	/** CopilotKit's live-transcript setter, shared through the session. */
	setLiveMessages: vi.fn(),
	/** The archive call "New conversation" makes before resetting. */
	archiveForDocument: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	/** Stands in for the shared assistant-message renderer. */
	AssistantSentinel: (() => null) as ComponentType,
	/** Stands in for the history-replaying message list. */
	MessagesSentinel: (() => null) as ComponentType,
}));

// ---------------------------------------------------------------------------
// Mock CopilotKit. The provider renders children directly and the sidebar is
// reduced to a prop recorder — this file is about what reaches that boundary.
// ---------------------------------------------------------------------------

vi.mock("@copilotkit/react-core", () => ({
	CopilotKit: ({ children }: { children?: ReactNode }) => <>{children}</>,
	useCoAgent: () => ({ state: { document: "" }, setState: vi.fn() }),
	useCopilotAction: (config: { name?: string }) => {
		registeredActions.push(config);
	},
	useCopilotReadable: vi.fn(),
	// Read by the real `<CopilotChatSessionProvider>` the component mounts.
	// `isLoading` is the run signal the editor lock is derived from, so it is
	// mutable here and a re-render publishes the change.
	useCopilotChatInternal: () => ({
		messages: [],
		visibleMessages: [],
		isLoading: chatIsLoading.current,
		// The live-transcript setter both conversation switches call. Absent
		// from this mock, the destructure hands back `undefined` and the first
		// "New conversation" click throws.
		setMessages: setLiveMessages,
	}),
}));

vi.mock("@copilotkit/react-ui", () => ({
	useChatContext: () => ({ setOpen: vi.fn() }),
	CopilotSidebar: (props: Record<string, unknown>) => {
		sidebarProps.push(props);
		return (
			<div data-testid="copilot-sidebar">
				{props.children as ReactNode}
			</div>
		);
	},
}));

// ---------------------------------------------------------------------------
// The modules under test, reduced to identity / prop probes.
// ---------------------------------------------------------------------------

vi.mock("@saas/shared/components/copilot/CopilotAssistantMessage", () => ({
	CopilotAssistantMessage: AssistantSentinel,
}));

vi.mock("@saas/shared/components/copilot/useClarifyingQuestions", () => ({
	useClarifyingQuestions: (options?: Record<string, unknown>) => {
		clarifyingCalls.push(options);
	},
}));

vi.mock("@saas/projects/hooks/useDocumentAssistantHistory", () => ({
	useActiveDocumentAssistantConversation: () => ({
		data: activeConversation.current,
	}),
}));

// A SEPARATE module from the one above, not an extra export on it — mocking it
// as part of `useDocumentAssistantHistory` would silently drop the
// active-conversation stub every test here depends on.
vi.mock("@saas/projects/hooks/useDocumentAssistantHistoryEnabled", () => ({
	useDocumentAssistantHistoryEnabled: () => historyFlag.current,
}));

vi.mock(
	"../../modules/saas/projects/components/copilot/CopilotHistoryDrawer",
	() => ({
		CopilotHistoryDrawer: (props: Record<string, unknown>) => {
			drawerProps.push(props);
			// Renders a marker rather than null: where the drawer sits in the
			// tree is the point — a child of the sidebar would unmount with it
			// and take the live thread's half-typed input with it.
			return <div data-testid="copilot-history-drawer" />;
		},
	}),
);

vi.mock("@saas/shared/components/copilot/AttachmentRegistry", () => ({
	AttachmentRegistryProvider: (props: Record<string, unknown>) => {
		attachmentProps.push(props);
		return <>{props.children as ReactNode}</>;
	},
}));

vi.mock(
	"../../modules/saas/projects/components/copilot/CopilotPersistenceHook",
	() => ({
		CopilotPersistenceHook: (props: Record<string, unknown>) => {
			persistenceProps.push(props);
			return null;
		},
	}),
);

vi.mock(
	"../../modules/saas/projects/components/copilot/CustomMessages",
	() => ({ CustomMessages: MessagesSentinel }),
);

vi.mock(
	"../../modules/saas/projects/components/copilot/DocumentAssistantOutcomesProvider",
	() => ({
		DocumentAssistantOutcomesProvider: (props: Record<string, unknown>) => {
			outcomesProps.push(props);
			return <>{props.children as ReactNode}</>;
		},
	}),
);

vi.mock(
	"../../modules/saas/projects/components/copilot/HydratedMessagesContext",
	() => ({
		HydratedMessagesProvider: (props: Record<string, unknown>) => {
			hydratedProps.push(props);
			return <>{props.children as ReactNode}</>;
		},
	}),
);

// ---------------------------------------------------------------------------
// Unrelated dependencies.
// ---------------------------------------------------------------------------

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: sessionUser.current }),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: { conversations: { archiveForDocument: archiveForDocument } },
	},
}));

vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));

vi.mock("@saas/shared/components/copilot/use-copilot-error-handler", () => ({
	useCopilotErrorHandler: () => vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useParams: () => routeParams.current,
}));

// ---------------------------------------------------------------------------
// Import AFTER the mocks are registered.
// ---------------------------------------------------------------------------

import {
	TopicAssistant,
	type TopicAssistantContext,
} from "../../modules/saas/projects/components/publishing-suite/TopicAssistant";

const TOPIC_ID = "topic-1";

const context: TopicAssistantContext = {
	title: "How we cut build times",
	angle: null,
	pitch: null,
	status: "PLANNED",
	postTypes: ["BLOG_POST"],
	openQuestions: [],
};

function assistant(
	overrides: Partial<Parameters<typeof TopicAssistant>[0]> = {},
) {
	return (
		<TopicAssistant
			projectId="proj-1"
			organizationId="org-1"
			context={context}
			analysisMarkdown="The exporter writes a CSV file once a day."
			canEdit
			onApplyRewrite={vi.fn()}
			{...overrides}
		/>
	);
}

/**
 * Renders, and fails loudly if the error boundary swallowed a throw. Without
 * this the symptom of a missing provider is an empty capture array and an
 * assertion that reads as though the prop were merely wrong.
 */
function render(ui: Parameters<typeof rtlRender>[0]) {
	const result = rtlRender(ui);
	expect(sidebarProps.length).toBeGreaterThan(0);
	return result;
}

/**
 * Renders the header CopilotKit would have put in its own slot.
 *
 * The mocked `<CopilotSidebar>` records its props without rendering them, so
 * the header's handlers are unreachable from the recorded object — they live in
 * the closure the factory captured. Mounting the real component is also the
 * stronger test: it proves the control exists and is labelled, not merely that
 * a callback was passed.
 */
function renderHeader() {
	const Header = sidebarProps[sidebarProps.length - 1].Header as
		| ComponentType
		| undefined;
	expect(Header).toBeDefined();
	const HeaderSlot = Header as ComponentType;
	return rtlRender(<HeaderSlot />);
}

describe("TopicAssistant — Feature Maturation parity", () => {
	beforeEach(() => {
		sidebarProps.length = 0;
		registeredActions.length = 0;
		clarifyingCalls.length = 0;
		persistenceProps.length = 0;
		hydratedProps.length = 0;
		outcomesProps.length = 0;
		attachmentProps.length = 0;
		drawerProps.length = 0;
		activeConversation.current = null;
		routeParams.current = { topicId: TOPIC_ID };
		chatIsLoading.current = false;
		historyFlag.current = true;
		sessionUser.current = { id: "user-1" };
		setLiveMessages.mockReset();
		archiveForDocument.mockReset().mockResolvedValue(undefined);
		toastSuccess.mockReset();
		toastError.mockReset();
	});

	// -----------------------------------------------------------------------
	// Reasoning trace
	// -----------------------------------------------------------------------

	it("renders the agent's reasoning and tool calls through the shared assistant bubble", () => {
		render(assistant());

		// Not merely "something was passed": the shared renderer is bound to
		// `project_document_generator` at module scope, and that binding is
		// what makes the trace resolve for THIS agent.
		expect(sidebarProps[0].AssistantMessage).toBe(AssistantSentinel);
	});

	it("keeps the bubble's component identity stable across re-renders", () => {
		// This page polls four queries, so it re-renders constantly. A new
		// component type per render would remount every message in the list.
		const { rerender } = render(assistant());
		rerender(assistant({ analysisMarkdown: "Rewritten by the agent." }));

		expect(sidebarProps.length).toBeGreaterThan(1);
		const identities = new Set(sidebarProps.map((p) => p.AssistantMessage));
		expect(identities).toEqual(new Set([AssistantSentinel]));
	});

	// -----------------------------------------------------------------------
	// Clarifying questions
	// -----------------------------------------------------------------------

	it("mounts the clarifying-question action with the balanced default", () => {
		render(assistant());

		// This surface is handed a `projectId` and no project record, so it
		// cannot read the configured tier the way FMv2 does. BALANCED is the
		// hook's own default and the deliberate choice here — asserted so a
		// later change that plumbs the real tier through has to say so.
		expect(clarifyingCalls).toHaveLength(1);
		expect(clarifyingCalls[0]).toMatchObject({ frequency: "BALANCED" });
	});

	it("passes the organization id through to the clarifying-question policy", () => {
		// The policy prompt behind the hook is tenant-scoped. Dropping the org
		// id resolves another tenant's wording, which is why it travels even
		// though the frequency does not.
		render(assistant());
		expect(clarifyingCalls[0]).toMatchObject({ organizationId: "org-1" });

		sidebarProps.length = 0;
		clarifyingCalls.length = 0;
		render(assistant({ organizationId: null }));

		// `null`, never `undefined` — the hook's default parameter would mask
		// a dropped prop, so the distinction is asserted rather than assumed.
		expect(clarifyingCalls[0]).toMatchObject({ organizationId: null });
	});

	it("registers no frontend action the agent did not ask for by name", () => {
		render(assistant());

		// `ask_clarifying_question` is registered inside the mocked hook, so
		// what is counted here is what THIS file registers directly. The rule
		// the component's docblock states is not a count — it is that every
		// registered tool is one the agent's prompt already names. A bespoke
		// "propose a rewrite" action added beside `confirm_changes` would
		// leave the model choosing between two writers, and this is where
		// that shows up.
		expect(registeredActions.map((a) => a.name)).toEqual([
			"confirm_changes",
		]);
	});

	// -----------------------------------------------------------------------
	// Conversation persistence
	// -----------------------------------------------------------------------

	it("persists the thread against the topic as a PUBLISHING_TOPIC document", () => {
		render(assistant());

		expect(persistenceProps).toHaveLength(1);
		expect(persistenceProps[0]).toMatchObject({
			documentRefKind: "PUBLISHING_TOPIC",
			documentRefId: TOPIC_ID,
			projectId: "proj-1",
			organizationId: "org-1",
			// Must match the agent the surrounding `<CopilotKit>` mounts, or
			// the History drawer attributes the thread to the wrong agent.
			agentId: "project_document_generator",
			// No visibility chip on this surface; a topic is a team artefact.
			requestedVisibility: "SHARED",
		});
	});

	it("takes the topic id from the route rather than a prop", () => {
		// `TopicAssistant`'s props carry no topic id — it is read from
		// `/projects/[id]/publishing/[topicId]`, which keeps the persistence
		// wiring from widening the component's contract.
		routeParams.current = { topicId: "topic-other" };
		render(assistant());

		expect(persistenceProps[0]).toMatchObject({
			documentRefId: "topic-other",
		});
		expect(hydratedProps[0]).toMatchObject({
			documentRefId: "topic-other",
		});
	});

	it("keeps the chat working when the route carries no topic id", () => {
		// Nothing to key a conversation on, so persistence stays off — but the
		// assistant itself must still mount. This is the pre-persistence
		// behaviour, and losing it would turn a missing id into a dead rail.
		routeParams.current = {};
		render(assistant());

		expect(persistenceProps).toHaveLength(0);
		expect(sidebarProps[0].AssistantMessage).toBe(AssistantSentinel);
	});

	it("seeds the conversation id from the active thread on the server", () => {
		// Client-side hydration: there is no SSR payload on this surface, so
		// the stored thread is found by query and handed to both the
		// persistence walker and the hydration provider.
		activeConversation.current = {
			conversation: { id: "conv-9", messages: [{ id: "m-1" }] },
		};
		render(assistant());

		expect(persistenceProps[0]).toMatchObject({
			conversationId: "conv-9",
		});
		expect(hydratedProps[0]).toMatchObject({
			activeConversationId: "conv-9",
		});
		// Ids already in the database, so the walker does not re-append the
		// turns it sees on its first tick.
		expect(persistenceProps[0].initialPersistedMessageIds).toEqual(["m-1"]);
	});

	it("replays history through the hydration-aware message list", () => {
		render(assistant());

		// Without this prop CopilotKit renders its own list, which knows only
		// about live messages — the stored thread would be persisted and never
		// shown again.
		expect(sidebarProps[0].Messages).toBe(MessagesSentinel);
	});

	it("declares no SSR seed, and keeps that empty seed referentially stable", () => {
		// `initialMessages` is in a `useMemo` dependency array inside the
		// provider. A fresh `[]` literal per render would recompute the
		// historical message set on every streaming tick.
		const { rerender } = render(assistant());
		rerender(assistant({ analysisMarkdown: "Rewritten by the agent." }));

		expect(hydratedProps.length).toBeGreaterThan(1);
		expect(hydratedProps[0].ssrConversationId).toBeNull();
		const seeds = new Set(hydratedProps.map((p) => p.initialMessages));
		expect(seeds.size).toBe(1);
		expect([...seeds][0]).toEqual([]);
	});

	it("mounts the attachment registry as the seam for a future input", () => {
		render(assistant());

		// Inert today — this sidebar keeps CopilotKit's default input, so
		// nothing ever fills the FIFO. Mounted so the seam exists for the day
		// an attachment-capable input lands.
		expect(attachmentProps).toHaveLength(1);
		expect(attachmentProps[0].pendingAttachmentsRef).toBeDefined();
	});

	it("does NOT mount the diff-outcome provider, which would badge every turn Pending", () => {
		// Regression guard, not an omission. The provider's only consumer is
		// the accept/reject badge beside each persisted tool call, and that
		// badge reads `acceptedAt` / `rejectedAt` — stamped solely by
		// `recordDiffOutcome`, whose only caller is `DiffReviewBar`. This
		// surface's chat path never reaches it: an accepted rewrite goes to
		// the Planning & Analysis editor and is saved there.
		//
		// Mounted, the provider therefore renders a permanent
		// "confirm_changes Pending" beside a turn the person already
		// accepted — the persistence hook stores every tool call unfiltered,
		// and the badge renders them unfiltered too. Re-add this only
		// together with something on this surface that stamps an outcome.
		render(assistant());

		expect(outcomesProps).toHaveLength(0);
	});

	// -----------------------------------------------------------------------
	// The way back into an earlier conversation
	// -----------------------------------------------------------------------

	describe("chat history", () => {
		it("mounts the drawer beside the sidebar, not inside it", () => {
			const { container } = render(assistant());

			// A CHILD of `<CopilotSidebar>` would be torn down with it, taking
			// the live thread — and any half-typed message — with it. The
			// drawer overlays the chat area instead, so closing it puts the
			// reader back exactly where they were.
			expect(
				container.querySelector(
					'[data-testid="copilot-history-drawer"]',
				),
			).not.toBeNull();
			expect(
				container.querySelector(
					'[data-testid="copilot-sidebar"] [data-testid="copilot-history-drawer"]',
				),
			).toBeNull();
		});

		it("scopes the drawer to this topic and this reader", () => {
			activeConversation.current = {
				conversation: { id: "conv-9", messages: [] },
			};
			render(assistant());

			expect(drawerProps[0]).toMatchObject({
				documentRefKind: "PUBLISHING_TOPIC",
				documentRefId: TOPIC_ID,
				projectId: "proj-1",
				organizationId: "org-1",
				// Which rows are the reader's own, and so which of them they
				// may rename, delete or fork.
				currentUserId: "user-1",
				// Marks the live thread in the list, so "resume" cannot offer
				// the conversation already on screen.
				activeConversationId: "conv-9",
			});
		});

		it("withholds both history affordances while the org has the flag off", () => {
			// Not symmetry with the persistence hook, which stays mounted:
			// every read behind the drawer sets `enabled: featureEnabled`, so a
			// History button here would open a permanently empty drawer.
			historyFlag.current = false;
			render(assistant());

			expect(drawerProps).toHaveLength(0);
			// And the slot goes back to CopilotKit's own header, which carries
			// a close button — so a docked-open panel stays closable either way.
			expect(sidebarProps[0].Header).toBeUndefined();
		});

		it("holds the drawer back until the session resolves a user", () => {
			// `currentUserId` is required, and guessing it wrong would offer
			// author-only controls on somebody else's conversation.
			sessionUser.current = null;
			render(assistant());

			expect(drawerProps).toHaveLength(0);
			// The header still mounts: it owns the close button, and nothing
			// in it needs an identity.
			expect(sidebarProps[0].Header).toBeDefined();
		});

		it("mounts no drawer when the route carries no topic id", () => {
			// Same reasoning as the persistence hook: with no topic there is
			// nothing to scope a conversation list to.
			routeParams.current = {};
			render(assistant());

			expect(drawerProps).toHaveLength(0);
		});

		it("keeps the header's component identity stable across re-renders", () => {
			// The factory returns a component TYPE. A fresh one per render is a
			// different type to React, which remounts the header on every
			// streaming tick.
			const { rerender } = render(assistant());
			rerender(assistant({ analysisMarkdown: "Rewritten." }));

			expect(sidebarProps.length).toBeGreaterThan(1);
			const headers = new Set(sidebarProps.map((p) => p.Header));
			expect(headers.size).toBe(1);
			expect([...headers][0]).toBeDefined();
		});

		describe("starting a new conversation", () => {
			it("archives the live thread and clears the transcript", async () => {
				activeConversation.current = {
					conversation: { id: "conv-9", messages: [] },
				};
				render(assistant());
				const { getByLabelText } = renderHeader();

				await act(async () => {
					fireEvent.click(getByLabelText("Start a new conversation"));
				});

				expect(archiveForDocument).toHaveBeenCalledWith({
					conversationId: "conv-9",
					organizationId: "org-1",
				});
				// Clearing the LIVE half is what the reader sees; the
				// historical half empties on its own once the active id is
				// null.
				expect(setLiveMessages).toHaveBeenCalledWith([]);
				expect(toastSuccess).toHaveBeenCalled();
			});

			it("archives nothing when no thread has been persisted yet", async () => {
				render(assistant());
				const { getByLabelText } = renderHeader();

				await act(async () => {
					fireEvent.click(getByLabelText("Start a new conversation"));
				});

				// Pre-first-send there is no row: the next message lazy-creates
				// one, and calling archive with a null id would be a 400.
				expect(archiveForDocument).not.toHaveBeenCalled();
				expect(setLiveMessages).toHaveBeenCalledWith([]);
			});

			it("does not fall back to the thread it just archived", async () => {
				// `getActiveForDocument` has no refetch interval and its result
				// is cached, so it goes on naming the archived thread. Falling
				// back to it would replay the transcript the reader just left
				// and append their next message to it.
				activeConversation.current = {
					conversation: { id: "conv-9", messages: [{ id: "m-1" }] },
				};
				const { rerender } = render(assistant());
				const { getByLabelText } = renderHeader();

				await act(async () => {
					fireEvent.click(getByLabelText("Start a new conversation"));
				});
				rerender(assistant());

				expect(
					hydratedProps[hydratedProps.length - 1]
						.activeConversationId,
				).toBeNull();
				expect(
					persistenceProps[persistenceProps.length - 1]
						.conversationId,
				).toBeNull();
			});

			it("stays reset when it is pressed twice before anything is sent", async () => {
				// The second press has nothing to archive, and must not undo
				// the first one's suppression by recording "I archived null"
				// — which would let the stale query hand the original thread
				// straight back.
				activeConversation.current = {
					conversation: { id: "conv-9", messages: [{ id: "m-1" }] },
				};
				const { rerender } = render(assistant());
				const { getByLabelText } = renderHeader();

				await act(async () => {
					fireEvent.click(getByLabelText("Start a new conversation"));
				});
				await act(async () => {
					fireEvent.click(getByLabelText("Start a new conversation"));
				});
				rerender(assistant());

				expect(archiveForDocument).toHaveBeenCalledTimes(1);
				expect(
					persistenceProps[persistenceProps.length - 1]
						.conversationId,
				).toBeNull();
			});

			it("keeps the header mounted across a conversation switch", async () => {
				// The handler is closed over by the header factory, so a
				// handler identity that changes after the first press returns a
				// new component TYPE — React remounts the header, and the
				// control the reader just clicked disappears and comes back.
				activeConversation.current = {
					conversation: { id: "conv-9", messages: [] },
				};
				const { rerender } = render(assistant());
				const { getByLabelText } = renderHeader();

				await act(async () => {
					fireEvent.click(getByLabelText("Start a new conversation"));
				});
				rerender(assistant());

				expect(new Set(sidebarProps.map((p) => p.Header)).size).toBe(1);
			});

			it("resets the thread even when the archive call fails", async () => {
				// The worst case of resetting anyway is the old thread
				// reappearing on the next load. The worst case of NOT resetting
				// is a reader stuck in the conversation they asked to leave.
				activeConversation.current = {
					conversation: { id: "conv-9", messages: [] },
				};
				archiveForDocument.mockRejectedValue(new Error("nope"));
				render(assistant());
				const { getByLabelText } = renderHeader();

				await act(async () => {
					fireEvent.click(getByLabelText("Start a new conversation"));
				});

				expect(toastError).toHaveBeenCalled();
				expect(setLiveMessages).toHaveBeenCalledWith([]);
			});
		});

		describe("forking an earlier conversation", () => {
			const FORKED = {
				forkedConversationId: "conv-fork",
				copiedMessageCount: 2,
				copiedMessages: [{ id: "m-1" }, { id: "m-2" }],
				visibility: "SHARED" as const,
			};

			function fork(
				rerender: (ui: ReturnType<typeof assistant>) => void,
			) {
				const onForked = drawerProps[drawerProps.length - 1]
					.onForked as (input: typeof FORKED) => void;
				act(() => {
					onForked(FORKED);
				});
				rerender(assistant());
			}

			it("hands the copied turns to the hydrated half, never the runtime", () => {
				const { rerender } = render(assistant());
				fork(rerender);

				// THE CRASH THIS AVOIDS: a second `setMessages` carrying the
				// copied turns throws "<CopilotKit> not wrapped" mid-render.
				// The only live-store write is the clear.
				expect(setLiveMessages).toHaveBeenCalledTimes(1);
				expect(setLiveMessages).toHaveBeenCalledWith([]);

				const hydrated = hydratedProps[hydratedProps.length - 1];
				expect(hydrated.activeConversationId).toBe("conv-fork");
				// Seed and active id must MATCH, or the provider treats the
				// seed as a stale thread and the copied turns never paint.
				expect(hydrated.ssrConversationId).toBe("conv-fork");
				expect(hydrated.initialMessages).toEqual(FORKED.copiedMessages);
			});

			it("tells the persistence walker the copied turns are already stored", () => {
				const { rerender } = render(assistant());
				fork(rerender);

				const persistence =
					persistenceProps[persistenceProps.length - 1];
				expect(persistence.conversationId).toBe("conv-fork");
				expect(persistence.initialPersistedMessageIds).toEqual([
					"m-1",
					"m-2",
				]);
			});

			it("survives the active-conversation query polling the old thread back", () => {
				// THE REGRESSION THIS GUARDS. Everything else on this surface is
				// derived from that query, which re-polls. A fork written into
				// anything derived from it is silently undone on the next tick —
				// the reader watches the thread they just opened revert, and the
				// walker re-appends turns that are already stored.
				const { rerender } = render(assistant());
				fork(rerender);

				activeConversation.current = {
					conversation: {
						id: "conv-old",
						messages: [{ id: "m-old" }],
					},
				};
				rerender(assistant());

				const hydrated = hydratedProps[hydratedProps.length - 1];
				expect(hydrated.activeConversationId).toBe("conv-fork");
				expect(hydrated.ssrConversationId).toBe("conv-fork");
				expect(
					persistenceProps[persistenceProps.length - 1]
						.initialPersistedMessageIds,
				).toEqual(["m-1", "m-2"]);
			});
		});
	});

	// -----------------------------------------------------------------------
	// Run-state reporting (the editor lock)
	// -----------------------------------------------------------------------

	describe("run-state reporting", () => {
		it("reports a run starting and finishing", () => {
			const onRunStateChange = vi.fn();
			const { rerender } = render(assistant({ onRunStateChange }));
			expect(onRunStateChange).toHaveBeenLastCalledWith(false);

			chatIsLoading.current = true;
			rerender(assistant({ onRunStateChange }));
			expect(onRunStateChange).toHaveBeenLastCalledWith(true);

			// Completion AND failure both land here: `isLoading` is
			// CopilotKit's own state and the run terminates either way, so
			// there is no error path that leaves it stuck true.
			chatIsLoading.current = false;
			rerender(assistant({ onRunStateChange }));
			expect(onRunStateChange).toHaveBeenLastCalledWith(false);
		});

		it("reports the run as over when it unmounts mid-run", () => {
			// THE STUCK-LOCK PATH. If this subtree disappears while the page
			// has last heard `true` — the error boundary catching a provider
			// failure, or a navigation away mid-run — the page would hold a
			// lock with nothing left alive to release it, and the editor
			// would be read-only until a reload. The boundary-catch case
			// reduces to exactly this: the subtree unmounts, so the same
			// cleanup runs.
			const onRunStateChange = vi.fn();
			chatIsLoading.current = true;
			const { unmount } = render(assistant({ onRunStateChange }));
			expect(onRunStateChange).toHaveBeenLastCalledWith(true);

			unmount();

			expect(onRunStateChange).toHaveBeenLastCalledWith(false);
		});

		it("works with no listener at all", () => {
			// The prop is optional: a caller that locks nothing passes
			// nothing, and the chat must not care.
			chatIsLoading.current = true;
			expect(() => render(assistant())).not.toThrow();
		});
	});
});
