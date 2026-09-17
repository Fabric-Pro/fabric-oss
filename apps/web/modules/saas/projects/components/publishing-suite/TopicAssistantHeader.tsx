"use client";

import { useChatContext } from "@copilotkit/react-ui";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { HistoryIcon, PlusIcon, XIcon } from "lucide-react";

/**
 * The Topic Assistant's sidebar header: title, start a new conversation, open
 * the history drawer, close the panel.
 *
 * WHY THIS IS NOT `createCopilotSidebarHeader`. The shared factory carries a
 * fourth control this surface must not have — the visibility chip — and on a
 * surface wired the way this one is, that chip is a bug rather than a feature.
 * It flips its own optimistic state and calls `setVisibilityForDocument`, while
 * `TopicAssistant` mounts `CopilotPersistenceHook` with a hardcoded
 * `requestedVisibility="SHARED"` and passes no `onVisibilityChange`. A reader
 * who toggled the chip to Private before their first message would watch it
 * read Private while the lazy-create went on writing SHARED — the exact
 * mismatch the shared header's `onVisibilityChange` exists to prevent, and the
 * publishing suite has nowhere to put that callback: a topic is a team
 * artefact, and `TopicAssistant` states that every thread on it is shared.
 *
 * So this is the same header minus the control that does not belong, not a
 * second visual idiom. Same layout order, same `bg-card` / `border-b` surface,
 * same ghost icon buttons, same `transition-colors`.
 *
 * THE CLOSE BUTTON IS NOT OPTIONAL. CopilotKit's default header supplies one,
 * and this surface docks the sidebar open — so a `Header` slot that replaced
 * the default without re-adding it would leave the panel permanently open with
 * no way to dismiss it. That is what happened on the document editor when the
 * shared header first took the slot, which is why that one grew an X too.
 *
 * Copy is hardcoded English, as the rest of the publishing suite's is.
 */
export interface TopicAssistantHeaderConfig {
	title: string;
	/** Archives the live thread and clears the transcript. */
	onNewConversation: () => void;
	/** Opens the drawer listing this topic's earlier conversations. */
	onOpenHistory: () => void;
}

function TopicAssistantHeader({
	config,
}: {
	config: TopicAssistantHeaderConfig;
}) {
	// The sidebar's own open/close state. `useChatContext` resolves only inside
	// `<CopilotSidebar>`, which is exactly where CopilotKit instantiates this
	// slot.
	const { setOpen } = useChatContext();
	const { title, onNewConversation, onOpenHistory } = config;

	return (
		<TooltipProvider delayDuration={300}>
			<div className="flex items-center gap-2 border-border border-b bg-card px-4 py-2">
				<div className="min-w-0 flex-1">
					<span className="truncate font-medium text-foreground text-sm">
						{title}
					</span>
				</div>

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							onClick={onNewConversation}
							aria-label="Start a new conversation"
							className="text-muted-foreground transition-colors duration-150 hover:text-foreground"
						>
							<PlusIcon className="size-4" aria-hidden="true" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>Archive this conversation and start a fresh one.</p>
					</TooltipContent>
				</Tooltip>

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							onClick={onOpenHistory}
							aria-label="Open this topic's chat history"
							className="text-muted-foreground transition-colors duration-150 hover:text-foreground"
						>
							<HistoryIcon
								className="size-4"
								aria-hidden="true"
							/>
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>Browse earlier conversations about this topic.</p>
					</TooltipContent>
				</Tooltip>

				{/* Sets the close control apart from the two conversation
				    actions beside it. */}
				<div aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							onClick={() => setOpen(false)}
							aria-label="Close the AI Assistant panel"
							className="text-muted-foreground transition-colors duration-150 hover:text-foreground"
						>
							<XIcon className="size-4" aria-hidden="true" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>Close the assistant.</p>
					</TooltipContent>
				</Tooltip>
			</div>
		</TooltipProvider>
	);
}

/**
 * Wraps the header so it can be handed to `<CopilotSidebar Header={...}>`.
 *
 * CopilotKit instantiates that slot with NO props, so the wiring has to travel
 * in a closure — the same shape `createCopilotSidebarHeader` and
 * `createCopilotSidebarLauncher` use.
 *
 * MEMOISE THE RESULT AT THE CALL SITE. A fresh component type per render is a
 * different element type to React, which remounts the header — and with it the
 * tooltip state — on every streaming tick.
 */
export function createTopicAssistantHeader(config: TopicAssistantHeaderConfig) {
	function TopicAssistantHeaderSlot() {
		return <TopicAssistantHeader config={config} />;
	}
	return TopicAssistantHeaderSlot;
}
