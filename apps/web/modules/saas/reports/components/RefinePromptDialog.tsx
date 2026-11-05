"use client";

import { CopilotKit } from "@copilotkit/react-core";
import "@copilotkit/react-ui/styles.css";
import { PromptContentEnhancer } from "@saas/prompts/components/PromptContentEnhancer";
import { useAiSidebarExpanded } from "@saas/shared/components/copilot/ai-sidebar-layout";
import { CopilotChatSessionProvider } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import { useCopilotErrorHandler } from "@saas/shared/components/copilot/use-copilot-error-handler";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@ui/components/dialog";
import { cn } from "@ui/lib";

export type RefinePromptRequest = {
	/** Names the prompt to the assistant's session; nothing is stored under it. */
	id: string;
	/** The prompt's label on the report page. */
	title: string;
	content: string;
};

/**
 * "Refine with AI" for one of a report's prompts: the Prompt Library's
 * enhancer chat, hosted as its enhance page hosts it. Saving hands the text
 * back to the report page, where it stays unsaved until the report is saved;
 * closing leaves the prompt as it was.
 */
export function RefinePromptDialog({
	request,
	organizationId,
	onApply,
	onClose,
}: {
	request: RefinePromptRequest | null;
	organizationId: string | null;
	onApply: (content: string) => void;
	onClose: () => void;
}) {
	const onError = useCopilotErrorHandler();
	const isAssistantExpanded = useAiSidebarExpanded(true);

	return (
		<Dialog
			open={request !== null}
			onOpenChange={(open) => !open && onClose()}
		>
			{request && (
				<DialogContent
					hideCloseButton
					className="flex h-[90vh] w-[95vw] max-w-6xl flex-col gap-0 overflow-hidden p-0"
				>
					<DialogTitle className="sr-only">
						Refine {request.title} with AI
					</DialogTitle>
					<DialogDescription className="sr-only">
						Ask the assistant to improve this prompt, then save to
						use the result in this report.
					</DialogDescription>
					{/* The direct-child selectors give the two wrappers CopilotKit
					    injects a definite height, so the enhancer's `h-full`
					    resolves instead of collapsing. The assistant docks as a
					    fixed 28rem rail from `sm` up, placed against this dialog
					    (its transform is the containing block), and globals.css
					    cancels CopilotKit's own content margin, so the editor
					    pads itself clear of the rail while it is open. */}
					<div
						className={cn(
							"min-h-0 flex-1 overflow-hidden [&>.copilotKitSidebarContentWrapper]:h-full [&>.copilotKitSidebarContentWrapper>.copilotKitModalChildrenWrapper]:h-full",
							isAssistantExpanded && "sm:pr-[28rem]",
						)}
					>
						<CopilotKit
							runtimeUrl={
								organizationId
									? `/api/copilotkit?organizationId=${organizationId}`
									: "/api/copilotkit"
							}
							useSingleEndpoint
							agent="prompt_enhancer"
							showDevConsole={false}
							enableInspector={false}
							onError={onError}
						>
							<CopilotChatSessionProvider>
								<PromptContentEnhancer
									promptId={request.id}
									promptName={request.title}
									format="PLAIN_TEXT"
									tags={[]}
									initialContent={request.content}
									onSave={(content) => {
										onApply(content);
										onClose();
									}}
									onCancel={onClose}
								/>
							</CopilotChatSessionProvider>
						</CopilotKit>
					</div>
				</DialogContent>
			)}
		</Dialog>
	);
}
