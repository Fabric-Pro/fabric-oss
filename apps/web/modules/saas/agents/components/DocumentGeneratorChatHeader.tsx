"use client";

/**
 * `DocumentGeneratorChatHeader`.
 *
 * Custom panel header for the standalone Document Generator AI Assistant,
 * rendered via the `Header` slot on `<CopilotSidebar>`. CopilotKit instantiates
 * the `Header` component with NO props, so this module exposes a
 * `createDocumentGeneratorChatHeader(config)` factory that closes over the
 * parent's wiring — the SAME pattern as `createCopilotSidebarHeader()`
 * (`modules/saas/projects/components/copilot/CopilotSidebarHeader.tsx`) and
 * `createCopilotSidebarInput()`.
 *
 * Why not reuse `createCopilotSidebarHeader` directly
 * ---------------------------------------------------
 * That factory's config is hard-bound to the document-assistant model: it
 * requires `documentRefKind` / `documentRefId` / `projectId` and renders a
 * `VisibilityChip` that calls `agents.conversations.setVisibilityForDocument`.
 * The Document Generator persists into the generic **AgentConversation** model,
 * which has no document ref and no per-conversation visibility, so those props
 * have no meaning here. This header therefore reproduces the SAME visual design
 * (title on the left; ghost icon-sm "New conversation" + "Chat history" buttons
 * on the right; `bg-card` surface with `border-b border-border`; `transition-
 * colors` only) minus the visibility chip.
 */

import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { HistoryIcon, PlusIcon } from "lucide-react";

export interface DocumentGeneratorChatHeaderConfig {
	title?: string;
	onNewConversation: () => void;
	onOpenHistory: () => void;
}

interface DocumentGeneratorChatHeaderProps {
	config: DocumentGeneratorChatHeaderConfig;
}

function DocumentGeneratorChatHeader({
	config,
}: DocumentGeneratorChatHeaderProps) {
	const { title = "AI Assistant", onNewConversation, onOpenHistory } = config;

	return (
		<TooltipProvider delayDuration={300}>
			<div className="flex items-center gap-2 border-b border-border bg-card px-4 py-2">
				<div className="min-w-0 flex-1">
					<span className="truncate text-sm font-medium text-foreground">
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
						<p>New conversation</p>
					</TooltipContent>
				</Tooltip>

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							onClick={onOpenHistory}
							aria-label="Open chat history"
							className="text-muted-foreground transition-colors duration-150 hover:text-foreground"
						>
							<HistoryIcon
								className="size-4"
								aria-hidden="true"
							/>
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>Chat history</p>
					</TooltipContent>
				</Tooltip>
			</div>
		</TooltipProvider>
	);
}

/**
 * Factory that wraps `<DocumentGeneratorChatHeader>` so it can be passed to
 * `<CopilotSidebar Header={...}>`. CopilotKit instantiates the `Header`
 * component with no props, so the closure captures the wiring.
 */
export function createDocumentGeneratorChatHeader(
	config: DocumentGeneratorChatHeaderConfig,
) {
	function DocumentGeneratorChatHeaderSlot() {
		return <DocumentGeneratorChatHeader config={config} />;
	}
	return DocumentGeneratorChatHeaderSlot;
}
