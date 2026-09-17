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

import { render as rtlRender } from "@testing-library/react";
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
	activeConversation,
	routeParams,
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
	/** What the active-conversation query resolves to. */
	activeConversation: {
		current: null as { conversation?: unknown } | null,
	},
	/** What `useParams()` returns — the topic id lives in the route. */
	routeParams: { current: {} as Record<string, string | undefined> },
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
	useCopilotChatInternal: () => ({
		messages: [],
		visibleMessages: [],
		isLoading: false,
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
	useSession: () => ({ user: { id: "user-1" } }),
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

describe("TopicAssistant — Feature Maturation parity", () => {
	beforeEach(() => {
		sidebarProps.length = 0;
		registeredActions.length = 0;
		clarifyingCalls.length = 0;
		persistenceProps.length = 0;
		hydratedProps.length = 0;
		outcomesProps.length = 0;
		attachmentProps.length = 0;
		activeConversation.current = null;
		routeParams.current = { topicId: TOPIC_ID };
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

	it("scopes the outcome chips and the attachment registry to the same topic", () => {
		render(assistant());

		// The outcome provider is what lights up accept/reject stamps in the
		// live bubble; a mismatched scope silently shows none.
		expect(outcomesProps[0]).toMatchObject({
			documentRefKind: "PUBLISHING_TOPIC",
			documentRefId: TOPIC_ID,
			projectId: "proj-1",
			organizationId: "org-1",
		});
		// Inert today — this sidebar keeps CopilotKit's default input, so
		// nothing ever fills the FIFO. Mounted so the seam exists for the day
		// an attachment-capable input lands.
		expect(attachmentProps).toHaveLength(1);
		expect(attachmentProps[0].pendingAttachmentsRef).toBeDefined();
	});
});
