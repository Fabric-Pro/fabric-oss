"use client";

import { useOfferedPromptActions } from "@saas/prompts/hooks/use-offered-prompt-actions";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

/**
 * The prompt field of a Proposal (Fizzy #2801, #2946). Where the Proposal
 * artifact supersedes the Project Document Generator's Proposal action, a
 * Proposal's Main document is always written from the client proposal prompt
 * bound in the library, and the run ignores any prompt a request names — so a
 * selector would offer a choice the run never honours, and its "Bind as
 * Default" would write a slot nothing reads. The field says where the prompt
 * comes from instead. Where the gate is off it is the ordinary selector, handed
 * in as `selector`.
 *
 * Its own component, mounted only where the row or the chosen type is a
 * Proposal, so the gate is read only where it decides something. Shared by
 * the create dialog and both prompt steps of the project setup wizard.
 */
export function ProposalPromptField({
	promptLabel,
	selector,
}: {
	promptLabel: string;
	selector: ReactNode;
}) {
	const t = useTranslations("projects.proposalArtifactEntry");
	const { isSuperseded } = useOfferedPromptActions();
	if (!isSuperseded("project_document_generator", "PROPOSAL")) {
		return selector;
	}
	return (
		<div data-testid="proposal-library-prompt">
			<p className="mb-2 font-medium text-sm leading-none">
				{promptLabel}
			</p>
			<p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
				{t("libraryPrompt")}
			</p>
			<p className="mt-1 text-muted-foreground text-xs">
				{t("libraryPromptHint")}
			</p>
		</div>
	);
}
