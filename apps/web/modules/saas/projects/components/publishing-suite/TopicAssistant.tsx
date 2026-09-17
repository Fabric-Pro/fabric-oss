"use client";

import {
	CopilotKit,
	useCoAgent,
	useCopilotAction,
	useCopilotReadable,
} from "@copilotkit/react-core";
import { CopilotSidebar, useChatContext } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import { useSession } from "@saas/auth/hooks/use-session";
import { useActiveDocumentAssistantConversation } from "@saas/projects/hooks/useDocumentAssistantHistory";
import { AttachmentRegistryProvider } from "@saas/shared/components/copilot/AttachmentRegistry";
import { CopilotAssistantMessage } from "@saas/shared/components/copilot/CopilotAssistantMessage";
import { CopilotChatSessionProvider } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import { useCopilotErrorHandler } from "@saas/shared/components/copilot/use-copilot-error-handler";
import { useClarifyingQuestions } from "@saas/shared/components/copilot/useClarifyingQuestions";
import { Button } from "@ui/components/button";
import { useParams } from "next/navigation";
import type { ErrorInfo, ReactNode } from "react";
import {
	Component,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	CopilotPersistenceHook,
	type PendingAttachment,
} from "../copilot/CopilotPersistenceHook";
import { createCopilotSidebarLauncher } from "../copilot/CopilotSidebarLauncher";
import { CustomMessages } from "../copilot/CustomMessages";
import { DocumentAssistantOutcomesProvider } from "../copilot/DocumentAssistantOutcomesProvider";
import type { HydratedMessage } from "../copilot/HydratedMessagesContext";
import { HydratedMessagesProvider } from "../copilot/HydratedMessagesContext";

/**
 * The assistant rail beside a publishing topic (Fizzy #1851, finding #15).
 *
 * The ask was "AI chat to the right, same as in FMv2", and the complaint
 * underneath it was concrete: every AI affordance in this suite was a single
 * Generate button, so *"I don't have a way of using AI assistant to tell it to
 * do something a little bit different."* This is that way — a chat that holds
 * the planning analysis and can rewrite it on instruction.
 *
 * SAME AS FMv2 MEANS THE SAME MACHINERY, not a lookalike. `StoryWorkspace`
 * mounts `project_document_generator`, seeds `state.document` with the
 * document under discussion, lets the agent rewrite it through its own
 * `write_document_local` (a predictive-state tool, so the text streams back
 * into co-agent state), and renders the agent's `confirm_changes` tool call as
 * an accept/reject card. Every frontend action registered here is one the
 * agent's own prompt already names — `confirm_changes` and
 * `ask_clarifying_question`, the same two FMv2 registers. Writing a bespoke
 * "propose a rewrite" action instead would have put an UNPROMPTED tool beside
 * the agent's blessed ones and left the model to choose — the failure being a
 * chat that says it rewrote the analysis while nothing reaches the page. The
 * count is not the rule; "the agent asked for this tool by name" is.
 *
 * WHAT IS DELIBERATELY DIFFERENT: accepting does not save. FMv2 autosaves;
 * this suite does not, because #1929's worst defect was an autosave racing an
 * in-flight agent and overwriting the server with pre-answer text — and a
 * revision here is defined as "what a person saved". So accept SEEDS the
 * Planning & Analysis editor and the existing Save stays the only writer.
 *
 * THE CONVERSATION PERSISTS, on the same stack the document editor uses:
 * `CopilotPersistenceHook` writes each terminal turn, `HydratedMessagesProvider`
 * plus `CustomMessages` replay the stored thread above the live one, and
 * `DocumentAssistantOutcomesProvider` carries the accept/reject stamps into the
 * live bubble. `PUBLISHING_TOPIC` is a first-class `DocumentRefKind`, so none of
 * that needed a publishing-specific branch.
 *
 * HYDRATION IS CLIENT-SIDE HERE, and that is the one real divergence from FMv2,
 * which threads an SSR-loaded transcript down from its route. This component is
 * loaded dynamically and is handed no such payload, so it resolves the active
 * conversation with `useActiveDocumentAssistantConversation` and lets
 * `HydratedMessagesProvider` fetch the turns itself — the path that provider
 * already takes whenever its own query resolves, SSR seed or not. The only cost
 * is first paint: FMv2 renders history immediately, this renders an empty thread
 * for one round trip. Adding the SSR seed later is additive and changes nothing
 * below.
 */
class TopicAssistantErrorBoundary extends Component<
	{ children: ReactNode },
	{ hasError: boolean }
> {
	constructor(props: { children: ReactNode }) {
		super(props);
		this.state = { hasError: false };
	}

	static getDerivedStateFromError() {
		return { hasError: true };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error(
			"[TopicAssistant] CopilotKit failed to initialise; the topic page renders without it",
			error,
			info.componentStack,
		);
	}

	render() {
		// Renders NOTHING on failure, and that is the point of this boundary.
		// The topic page's document, questions, decisions and drafts all work
		// without an assistant, so a provider that cannot start must cost the
		// assistant and not the page. The fallback also cannot be anything that
		// calls a CopilotKit hook — on 1.70 those throw with no provider above
		// them, which is the trap `DocumentEditorPage` documents (#2393).
		return this.state.hasError ? null : this.props.children;
	}
}

/**
 * The slice of co-agent state this surface uses.
 *
 * `document` is the whole contract: `project_document_generator` maps its
 * `write_document_local` tool's `document` argument onto this key as a
 * predictive state (see the agent registry in `app/api/copilotkit/route.ts`),
 * so the rewrite streams in here without the frontend registering that tool.
 * The rest is context the agent's own tools read — `search_project_knowledge`
 * needs `projectId` to scope its retrieval.
 */
interface TopicAgentState {
	document: string;
	projectId: string;
	userId?: string;
	organizationId?: string;
}

/** What the assistant is told about the topic it is sitting beside. */
export interface TopicAssistantContext {
	title: string;
	angle: string | null;
	pitch: string | null;
	status: string;
	/** Content formats this topic is set to produce. */
	postTypes: ReadonlyArray<string>;
	/** Questions nobody has answered yet — the gaps a rewrite should respect. */
	openQuestions: ReadonlyArray<string>;
}

export function TopicAssistant({
	projectId,
	organizationId,
	context,
	analysisMarkdown,
	canEdit,
	onApplyRewrite,
}: {
	projectId: string;
	organizationId: string | null;
	context: TopicAssistantContext;
	/** The planning analysis as it stands, or `null` before one exists. */
	analysisMarkdown: string | null;
	/** A reader still gets the chat; they just cannot apply what it proposes. */
	canEdit: boolean;
	/** Hands an accepted rewrite to the page, which seeds the editor with it. */
	onApplyRewrite: (markdown: string) => void;
}) {
	const onCopilotError = useCopilotErrorHandler();

	// Memoised so the provider's prop reference is stable. This page re-renders
	// on every poll of its four queries, and an unstable `runtimeUrl` re-runs
	// CopilotKit's mount-time handshake each time — the rate-limit burn PR #688
	// fixed on the document editor.
	const runtimeUrl = useMemo(
		() =>
			organizationId
				? `/api/copilotkit?organizationId=${organizationId}`
				: "/api/copilotkit",
		[organizationId],
	);

	return (
		<TopicAssistantErrorBoundary>
			<CopilotKit
				runtimeUrl={runtimeUrl}
				// The 1.70 client probes `GET <runtimeUrl>/info` before falling
				// back to single-route POST, and this route is POST-only — the
				// probe 405s and surfaces as an error toast. Every
				// `<CopilotKit>` mount in this repo carries this; keep them in
				// step.
				useSingleEndpoint
				agent="project_document_generator"
				showDevConsole={false}
				onError={onCopilotError}
			>
				{/* One `useCopilotChatInternal()` for the surface: on 1.70
				    every call site of that hook opens its own agent/connect
				    (Fizzy #2389), and `<CopilotSidebar>` is such a call
				    site. */}
				<CopilotChatSessionProvider>
					<TopicAssistantAgent
						projectId={projectId}
						organizationId={organizationId}
						context={context}
						analysisMarkdown={analysisMarkdown}
						canEdit={canEdit}
						onApplyRewrite={onApplyRewrite}
					/>
					<TopicAssistantConversation
						projectId={projectId}
						organizationId={organizationId}
					/>
				</CopilotChatSessionProvider>
			</CopilotKit>
		</TopicAssistantErrorBoundary>
	);
}

/**
 * Module-scope so the reference never changes. `HydratedMessagesProvider` lists
 * `initialMessages` in a `useMemo` dependency array, and this component
 * re-renders on every streaming tick — a fresh `[]` literal would recompute the
 * historical message set on each one.
 *
 * Always empty: that prop is the SSR first-paint seed, and this surface has no
 * SSR payload to seed it with (see the component docblock).
 */
const NO_SSR_MESSAGES: ReadonlyArray<HydratedMessage> = Object.freeze([]);

/** This surface's `DocumentRefKind`. Hoisted so the literal narrows once. */
const TOPIC_REF_KIND = "PUBLISHING_TOPIC" as const;

/**
 * The persisted conversation, and the sidebar that renders it.
 *
 * WHY THIS IS ITS OWN COMPONENT and not part of `TopicAssistant`: every hook
 * below has to sit INSIDE `TopicAssistantErrorBoundary`, whose whole purpose is
 * that a provider which cannot start costs the assistant and not the topic page.
 * Hooks called in `TopicAssistant`'s own body are above that boundary, where a
 * throw takes the page with it. `AttachmentRegistryProvider` also reads
 * `useCopilotChatSession()`, so it has to be below the session provider too.
 *
 * THE TOPIC ID COMES FROM THE ROUTE, not a prop. This component is rendered by
 * `TopicItemPage`, which has the id, but reading it from `useParams` keeps the
 * persistence wiring self-contained instead of widening that component's
 * contract. The route is `/app/.../projects/[id]/publishing/[topicId]`, and the
 * assistant only ever mounts underneath it; `CopilotAssistantMessage` derives
 * its own project context the same way. Without a `topicId` there is nothing to
 * key a conversation on, so persistence stays off and the chat still works —
 * which is the pre-existing behaviour, not a regression.
 *
 * NO FEATURE-FLAG GATE HERE, deliberately, and this diverges from
 * `StoryWorkspace`, which gates its `<CopilotPersistenceHook>` mount on
 * `documentAssistantHistoryEnabled`. The gate is unnecessary: every read hook in
 * `useDocumentAssistantHistory` sets `enabled: featureEnabled && ...` and the
 * append mutation throws when the flag is off, so the stack already fails closed
 * from the inside. Repeating it here would couple the publishing suite to a
 * kill switch it does not own, for no behavioural difference.
 */
function TopicAssistantConversation({
	projectId,
	organizationId,
}: {
	projectId: string;
	organizationId: string | null;
}) {
	const params = useParams<{ topicId?: string }>();
	const topicId = params?.topicId ?? null;

	const Launcher = useMemo(
		() => createCopilotSidebarLauncher({ label: "AI Assistant" }),
		[],
	);

	// Memoised because it is the query key for the active-conversation read and
	// is passed to three providers; a fresh literal per render would refetch and
	// re-render the whole persisted thread on every streaming tick.
	const scope = useMemo(
		() => ({
			documentRefKind: TOPIC_REF_KIND,
			documentRefId: topicId ?? "",
			projectId,
			organizationId,
		}),
		[topicId, projectId, organizationId],
	);

	const { data: activeConversation } = useActiveDocumentAssistantConversation(
		scope,
		{ enabled: topicId !== null },
	);
	const serverConversationId = activeConversation?.conversation?.id ?? null;

	// The id `CopilotPersistenceHook` lazy-creates on the first turn, or the
	// continuation id it spills to at the 200-turn cap. Null until one of those
	// happens, which is why the server's id is the fallback rather than the
	// other way round: once this surface has resolved an id, that is the thread
	// the user is actually typing into.
	const [resolvedConversationId, setResolvedConversationId] = useState<
		string | null
	>(null);
	const conversationId = resolvedConversationId ?? serverConversationId;

	// Ids already in the database, so the persistence walker does not re-append
	// the hydrated turns it sees on its first tick. The server is idempotent on
	// message id, so this saves round trips rather than preventing corruption.
	const persistedMessageIds = useMemo<ReadonlyArray<string>>(() => {
		const messages = activeConversation?.conversation?.messages;
		if (!Array.isArray(messages)) {
			return [];
		}
		const ids: string[] = [];
		for (const message of messages) {
			const id = (message as { id?: unknown })?.id;
			if (typeof id === "string" && id.length > 0) {
				ids.push(id);
			}
		}
		return ids;
	}, [activeConversation]);

	// INERT ON THIS SURFACE, and mounted anyway. The registry is a derivation of
	// (this FIFO, the message stream), and the FIFO is filled by
	// `CopilotSidebarInput`'s `onAttachmentsForNextMessage` — which this sidebar
	// does not use, because it keeps CopilotKit's default input. So nothing ever
	// pushes a batch and the registry stays empty. It is here because
	// `CopilotPersistenceHook` reads the registry to attach files to a persisted
	// turn, and that is the seam that has to already exist the day this surface
	// gains an attachment-capable input. It costs one ref and one context.
	const pendingAttachmentsRef = useRef<PendingAttachment[][]>([]);

	return (
		<AttachmentRegistryProvider
			pendingAttachmentsRef={pendingAttachmentsRef}
		>
			<DocumentAssistantOutcomesProvider
				documentRefKind={TOPIC_REF_KIND}
				documentRefId={topicId ?? ""}
				projectId={projectId}
				organizationId={organizationId}
			>
				<HydratedMessagesProvider
					initialMessages={NO_SSR_MESSAGES}
					// No SSR transcript to be stale against, so the provider's
					// "is the seed still the active thread" check is simply
					// false and it renders what its own query returns.
					ssrConversationId={null}
					activeConversationId={conversationId}
					documentRefKind={TOPIC_REF_KIND}
					documentRefId={topicId ?? ""}
					projectId={projectId}
					organizationId={organizationId}
				>
					<CopilotSidebar
						// The agent already streams `reasoningByTurn` and
						// `toolCallsByTurn` into co-agent state; without this
						// prop CopilotKit's default bubble renders and the
						// trace is thrown away, so the chat sat silent for the
						// seconds a tool call takes. The shared renderer is a
						// module-scope constant bound to
						// `project_document_generator` — the agent mounted
						// above — so its identity is already stable and
						// wrapping it in `useMemo` would be the bug, not the
						// fix.
						AssistantMessage={CopilotAssistantMessage}
						// Replays the persisted thread above the live one.
						// Reads the hydration context directly, and falls back
						// to live-only when none is mounted, so it is the half
						// of persistence the user actually sees.
						Messages={CustomMessages}
						// DOCKED OPEN, as the Feature Assistant is. The
						// assistant was reachable from every tab already —
						// mounted at page level, outside `<Tabs>` — but behind
						// a launcher, so the two surfaces read as different
						// features while running the same component.
						defaultOpen={true}
						clickOutsideToClose={false}
						Button={Launcher}
						labels={{
							title: "AI Assistant",
							initial:
								"Ask about this topic, or tell me how to change the planning analysis — say what you want different and I'll rewrite it for your review.",
						}}
					>
						<CloseAssistantOnNarrowViewport />
						{/* Writes each terminal turn through
						    `appendTurnForDocument`. Renders null; it is a
						    child of the sidebar so its
						    `useCopilotChatSession()` read resolves against the
						    same session the sidebar renders from. Skipped
						    without a topic id, since there would be no
						    document to key the conversation to. */}
						{topicId !== null ? (
							<CopilotPersistenceHook
								documentRefKind={TOPIC_REF_KIND}
								documentRefId={topicId}
								projectId={projectId}
								organizationId={organizationId}
								conversationId={conversationId}
								onConversationIdResolved={
									setResolvedConversationId
								}
								onSpilled={setResolvedConversationId}
								// No visibility chip on this surface, so every
								// topic thread is SHARED — matching the rest of
								// the publishing suite, where a topic is a team
								// artefact rather than one person's draft.
								requestedVisibility="SHARED"
								agentId="project_document_generator"
								pendingAttachmentsRef={pendingAttachmentsRef}
								initialPersistedMessageIds={persistedMessageIds}
							/>
						) : null}
					</CopilotSidebar>
				</HydratedMessagesProvider>
			</DocumentAssistantOutcomesProvider>
		</AttachmentRegistryProvider>
	);
}

/** Tailwind `sm` — the width below which CopilotKit goes full-screen. */
const ASSISTANT_FULLSCREEN_BELOW = 640;

/**
 * Close the assistant on arrival at a phone-width viewport.
 *
 * Side-effect only; renders nothing. Below `sm` CopilotKit renders the sidebar
 * as a full-screen overlay, so docking it open there would bury the whole topic
 * — `StoryWorkspace` measured this on a real feature at 375px: the tab bar sat
 * at x=499 in a 360px window and only the assistant was reachable.
 *
 * A CHILD of `<CopilotSidebar>` rather than logic in `TopicAssistant`'s own
 * body, because `useChatContext` resolves only inside it. And done here rather
 * than by computing `defaultOpen`: that prop is read once at mount, so a
 * viewport measured in an effect arrives too late.
 *
 * Mount only. A later resize is the reader's own doing, and yanking the panel
 * shut mid-conversation because they rotated the device would be worse than
 * leaving it where they put it.
 */
function CloseAssistantOnNarrowViewport() {
	const { setOpen } = useChatContext();
	useEffect(() => {
		if (
			window.matchMedia(
				`(max-width: ${ASSISTANT_FULLSCREEN_BELOW - 1}px)`,
			).matches
		) {
			setOpen(false);
		}
	}, [setOpen]);
	return null;
}

/**
 * The context, the co-agent state and the one action — a CHILD of the
 * provider, because `useCoAgent`, `useCopilotReadable` and `useCopilotAction`
 * all throw unless a `<CopilotKit>` is already mounted above them, and so
 * cannot be called in the component that renders it.
 */
function TopicAssistantAgent({
	projectId,
	organizationId,
	context,
	analysisMarkdown,
	canEdit,
	onApplyRewrite,
}: {
	projectId: string;
	organizationId: string | null;
	context: TopicAssistantContext;
	analysisMarkdown: string | null;
	canEdit: boolean;
	onApplyRewrite: (markdown: string) => void;
}) {
	const { user } = useSession();
	const userId = user?.id;

	// MUST be memoised: a fresh object literal every render makes CopilotKit
	// re-emit `agent/connect` handshakes, which on a page polling four queries
	// is dozens of redundant `/api/copilotkit` POSTs per topic load against a
	// 500/min per-user budget. Same fix, same reason, as `StoryWorkspace`.
	const initialState = useMemo<TopicAgentState>(
		() => ({
			document: analysisMarkdown ?? "",
			projectId,
			userId,
			organizationId: organizationId ?? undefined,
		}),
		// `analysisMarkdown` is deliberately absent: this is the state the
		// agent MOUNTS with, and re-seeding it on every poll of the analysis
		// query would reconnect the agent mid-conversation. The effect below
		// keeps it current instead.
		[projectId, userId, organizationId],
	);

	const { state: agentState, setState: setAgentState } =
		useCoAgent<TopicAgentState>({
			name: "project_document_generator",
			initialState,
		});

	// `useCoAgent` returns a new `setState` every render, so naming it in a
	// dependency array is an infinite loop. The rest of this codebase mirrors
	// it into a ref and reads through that; so does this.
	const setAgentStateRef = useRef(setAgentState);
	setAgentStateRef.current = setAgentState;
	const agentStateRef = useRef(agentState);
	agentStateRef.current = agentState;

	/**
	 * Keep the agent's copy of the document current with the server's.
	 *
	 * Skipped while a review is open: between `write_document_local` and the
	 * person's decision, `state.document` holds the PROPOSAL, and a poll
	 * landing in that window would overwrite it with the pre-run text — the
	 * accept would then apply the document the run started from and look like
	 * the assistant did nothing.
	 */
	const [isReviewOpen, setIsReviewOpen] = useState(false);
	useEffect(() => {
		if (isReviewOpen || analysisMarkdown === null) {
			return;
		}
		setAgentStateRef.current({
			document: analysisMarkdown,
		} as TopicAgentState);
	}, [analysisMarkdown, isReviewOpen]);

	useCopilotReadable({
		description:
			"The publishing topic currently open, and the planning analysis being discussed.",
		value: {
			title: context.title,
			angle: context.angle,
			pitch: context.pitch,
			status: context.status,
			contentFormats: context.postTypes,
			unansweredQuestions: context.openQuestions,
			planningAnalysis:
				analysisMarkdown ??
				"No planning analysis has been generated for this topic yet.",
		},
	});

	const handleAccept = useCallback(() => {
		// Read through the ref, not the closure. CopilotKit invokes this
		// renderer through `renderRef.current`, updated in an effect that runs
		// after commit, so the captured closure lags one render behind React
		// state — long enough to apply a streaming partial over the finished
		// rewrite.
		const proposed = agentStateRef.current?.document ?? "";
		setIsReviewOpen(false);
		if (proposed.trim() === "") {
			return false;
		}
		onApplyRewrite(proposed);
		return true;
	}, [onApplyRewrite]);

	const handleReject = useCallback(() => {
		setIsReviewOpen(false);
		// Put the server's text back so the next turn starts from the document
		// as it really stands, not from a rewrite nobody took.
		if (analysisMarkdown !== null) {
			setAgentStateRef.current({
				document: analysisMarkdown,
			} as TopicAgentState);
		}
		return true;
	}, [analysisMarkdown]);

	// Lets the agent ask instead of guess — the second half of "AI chat to the
	// right, same as in FMv2", where a rewrite that misreads the brief costs a
	// whole turn. FMv2 reads the project's configured tier; this surface is
	// handed only a `projectId`, so it takes the hook's own BALANCED default
	// rather than plumbing a project query through the page for one enum. The
	// org id still travels, because the policy prompt behind it is
	// tenant-scoped and dropping it resolves another tenant's wording.
	useClarifyingQuestions({
		frequency: "BALANCED",
		organizationId: organizationId ?? null,
	});

	useCopilotAction(
		{
			name: "confirm_changes",
			renderAndWaitForResponse: ({ respond, status }) => (
				<ConfirmRewrite
					status={status}
					respond={respond}
					canEdit={canEdit}
					onOpen={() => setIsReviewOpen(true)}
					onAccept={handleAccept}
					onReject={handleReject}
				/>
			),
		},
		[agentState?.document, canEdit, handleAccept, handleReject],
	);

	return null;
}

/**
 * The accept/reject card CopilotKit renders inside the chat when the agent
 * calls `confirm_changes`.
 *
 * Its wording is the honest one for this surface: accepting opens the rewrite
 * as a REVIEW in the Planning & Analysis editor — painted over the current
 * document as diff marks, to be accepted or rejected change by change — and the
 * person's own Save is still what writes it. Calling the button "Save" would
 * promise something this suite deliberately does not do.
 */
function ConfirmRewrite({
	status,
	respond,
	canEdit,
	onOpen,
	onAccept,
	onReject,
}: {
	status: string;
	respond?: (payload: unknown) => void;
	canEdit: boolean;
	/** Freezes the server→agent document sync while the decision is open. */
	onOpen: () => void;
	onAccept: () => boolean;
	onReject: () => boolean;
}) {
	const [resolved, setResolved] = useState<"accepted" | "rejected" | null>(
		null,
	);

	// Announce the open review once, from an effect rather than during render:
	// this component is rendered by CopilotKit, and setting a parent's state in
	// its render pass is a React warning and an ordering hazard.
	const isExecuting = status === "executing";
	useEffect(() => {
		if (isExecuting && resolved === null) {
			onOpen();
		}
	}, [isExecuting, resolved, onOpen]);

	// A re-registered or stale card, with no decision of its own to show.
	if (!isExecuting && resolved === null) {
		return null;
	}

	if (resolved !== null) {
		return (
			<div className="my-4 rounded-lg border border-border bg-card p-4 text-card-foreground text-sm">
				{resolved === "accepted"
					? "Opened in Planning & Analysis — accept or reject each change there, then save."
					: "Discarded. The analysis is unchanged."}
			</div>
		);
	}

	const decide = (accept: boolean) => {
		const landed = accept ? onAccept() : onReject();
		if (!landed) {
			return;
		}
		setResolved(accept ? "accepted" : "rejected");
		respond?.({ accepted: accept });
	};

	return (
		<div
			data-testid="topic-assistant-confirm"
			className="my-4 rounded-lg border border-border bg-card p-4 text-card-foreground"
		>
			<p className="font-medium text-sm">Rewritten planning analysis</p>
			<p className="mt-1 text-muted-foreground text-sm">
				{canEdit
					? "Review it against the current analysis? You can accept or reject each change, and nothing is saved until you save it there."
					: "You do not have permission to change this topic's analysis."}
			</p>
			{canEdit ? (
				<div className="mt-3 flex gap-2">
					<Button size="sm" onClick={() => decide(true)}>
						Review changes
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() => decide(false)}
					>
						Discard
					</Button>
				</div>
			) : null}
		</div>
	);
}
