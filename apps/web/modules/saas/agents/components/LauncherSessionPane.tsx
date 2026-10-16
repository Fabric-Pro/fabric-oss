"use client";

import type { ConversationListItem } from "@saas/agents/lib/conversation-list";
import type { ChatEngine } from "@saas/agents/lib/interface-mode-engine";
import dynamic from "next/dynamic";
import type { ReactNode, RefObject } from "react";
import type { LauncherPane } from "../hooks/useResumedSession";
import type { ContinuedChat } from "./fabric-ai/components/SharedSessionView";
import {
	ResumedSessionFailed,
	ResumedSessionGone,
	ResumedSessionNote,
} from "./ResumedSessionNote";

export function LauncherChatLoading() {
	return (
		<div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
			Loading Fabric Agent…
		</div>
	);
}

const LauncherSessionHistory = dynamic(
	() =>
		import("./LauncherSessionHistory").then((mod) => ({
			default: mod.LauncherSessionHistory,
		})),
	{ ssr: false, loading: LauncherChatLoading },
);

const SharedSessionView = dynamic(
	() =>
		import("./fabric-ai/components/SharedSessionView").then((mod) => ({
			default: mod.SharedSessionView,
		})),
	{ ssr: false, loading: LauncherChatLoading },
);

/**
 * The body of the Fabric Agent drawer: the conversation history when it is open,
 * and otherwise whatever the drawer has to show for what it was asked to open
 * (`pane`): the chat, another member's shared conversation, or the wait, loss
 * or failure of opening a stored one. The chat is passed in and kept mounted
 * behind the history, so a reply in progress is not lost by looking at the list.
 */
export function LauncherSessionPane({
	pane,
	resumedTitle,
	historyOpen,
	organizationId,
	activeConversationId,
	engine,
	chatRef,
	onSelect,
	onDeleted,
	onBack,
	onContinue,
	onRetry,
	onStartOver,
	notice,
	children,
}: {
	pane: LauncherPane;
	/** The title of the conversation the drawer reopened, when it reopened one. */
	resumedTitle: string | null;
	historyOpen: boolean;
	organizationId: string | null;
	activeConversationId: string | null;
	/** The engine the reader's own chats run on now; a chat continued from a shared conversation opens on it. */
	engine: ChatEngine;
	/** The element the chat shows in, so the drawer can move focus to its input. */
	chatRef: RefObject<HTMLDivElement | null>;
	onSelect: (conversation: ConversationListItem) => void;
	onDeleted: (id: string) => void;
	onBack: () => void;
	onContinue: (chat: ContinuedChat) => void;
	onRetry: () => void;
	onStartOver: () => void;
	/** Said above the chat while it shows, such as the engine it runs on. */
	notice?: ReactNode;
	children: ReactNode;
}) {
	return (
		<>
			{!historyOpen && pane.kind === "chat" && pane.conversation ? (
				<ResumedSessionNote title={resumedTitle} />
			) : null}
			{!historyOpen && pane.kind === "chat" ? notice : null}
			{historyOpen ? (
				<div className="min-h-0 flex-1">
					<LauncherSessionHistory
						organizationId={organizationId}
						activeConversationId={activeConversationId}
						onSelect={onSelect}
						onDeleted={onDeleted}
						onBack={onBack}
					/>
				</div>
			) : null}
			<div
				ref={chatRef}
				className="min-h-0 flex-1"
				hidden={historyOpen}
				inert={historyOpen || undefined}
			>
				<PaneBody
					pane={pane}
					organizationId={organizationId}
					engine={engine}
					onContinue={onContinue}
					onRetry={onRetry}
					onStartOver={onStartOver}
				>
					{children}
				</PaneBody>
			</div>
		</>
	);
}

function PaneBody({
	pane,
	organizationId,
	engine,
	onContinue,
	onRetry,
	onStartOver,
	children,
}: {
	pane: LauncherPane;
	organizationId: string | null;
	engine: ChatEngine;
	onContinue: (chat: ContinuedChat) => void;
	onRetry: () => void;
	onStartOver: () => void;
	children: ReactNode;
}) {
	switch (pane.kind) {
		case "loading":
			return <LauncherChatLoading />;
		case "gone":
			return <ResumedSessionGone onStartOver={onStartOver} />;
		case "error":
			return (
				<ResumedSessionFailed
					onRetry={onRetry}
					onStartOver={onStartOver}
				/>
			);
		case "shared":
			return (
				<SharedSessionView
					conversation={pane.conversation}
					organizationId={organizationId}
					engine={engine}
					onContinue={onContinue}
				/>
			);
		case "chat":
			return children;
		default: {
			const unreachable: never = pane;
			return unreachable;
		}
	}
}
