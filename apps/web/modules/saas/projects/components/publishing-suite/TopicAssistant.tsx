"use client";

import {
	CopilotKit,
	useCoAgent,
	useCopilotAction,
	useCopilotReadable,
} from "@copilotkit/react-core";
import { CopilotSidebar } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import { useSession } from "@saas/auth/hooks/use-session";
import { CopilotChatSessionProvider } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import { useCopilotErrorHandler } from "@saas/shared/components/copilot/use-copilot-error-handler";
import { Button } from "@ui/components/button";
import type { ErrorInfo, ReactNode } from "react";
import {
	Component,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createCopilotSidebarLauncher } from "../copilot/CopilotSidebarLauncher";

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
 * an accept/reject card. Exactly one frontend action is registered there, and
 * exactly one is registered here. Writing a bespoke "propose a rewrite" action
 * instead would have put a second, unprompted tool beside the agent's own
 * blessed one and left the model to choose — the failure being a chat that
 * says it rewrote the analysis while nothing reaches the page.
 *
 * WHAT IS DELIBERATELY DIFFERENT: accepting does not save. FMv2 autosaves;
 * this suite does not, because #1929's worst defect was an autosave racing an
 * in-flight agent and overwriting the server with pre-answer text — and a
 * revision here is defined as "what a person saved". So accept SEEDS the
 * Planning & Analysis editor and the existing Save stays the only writer.
 *
 * THE CONVERSATION IS EPHEMERAL. The document editor persists its thread
 * through `CopilotPersistenceHook`, a hydration provider and an attachment
 * registry; none of that is wired here, so leaving the page ends the
 * conversation. That is a scoped gap in this first cut, not a defect to
 * diagnose later.
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

	const Launcher = useMemo(
		() => createCopilotSidebarLauncher({ label: "AI Assistant" }),
		[],
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
					<CopilotSidebar
						defaultOpen={false}
						clickOutsideToClose={false}
						Button={Launcher}
						labels={{
							title: "AI Assistant",
							initial:
								"Ask about this topic, or tell me how to change the planning analysis — say what you want different and I'll rewrite it for your review.",
						}}
					/>
				</CopilotChatSessionProvider>
			</CopilotKit>
		</TopicAssistantErrorBoundary>
	);
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
 * Its wording is the honest one for this surface: accepting LOADS the rewrite
 * into the editor, and the person's own Save is still what writes it. Calling
 * the button "Save" would promise something this suite deliberately does not
 * do.
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
					? "Loaded into Planning & Analysis — review it there and save when you're happy."
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
					? "Load it into the Planning & Analysis tab? Nothing is saved until you save it there."
					: "You do not have permission to change this topic's analysis."}
			</p>
			{canEdit ? (
				<div className="mt-3 flex gap-2">
					<Button size="sm" onClick={() => decide(true)}>
						Load it in
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
