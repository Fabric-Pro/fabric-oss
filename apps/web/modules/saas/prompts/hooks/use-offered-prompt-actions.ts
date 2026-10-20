"use client";

import {
	isSupersededPromptAction,
	listOfferedPromptActions,
	offeredDocumentTypes,
	type PromptAction,
	type PromptAgentTarget,
	type PromptStoryKind,
} from "@repo/utils/prompt-action-catalog";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { useMemo } from "react";

type OfferedPromptActions = {
	/** The organization's PROPOSAL_ARTIFACT gate, as the org layout resolved it. */
	proposalArtifactOn: boolean;
	/** The actions to offer, in catalog order; labels as the full list's. */
	actions: readonly PromptAction[];
	/** Ids of {@link actions}, for membership checks. */
	actionIds: ReadonlySet<string>;
	/** Whether the gate supersedes this action here (Fizzy #2946). */
	isSuperseded: (targetKey: string, documentType: string) => boolean;
	/** The document types to offer for an agent at a story kind. */
	documentTypesFor: (
		agent: PromptAgentTarget,
		storyKind: PromptStoryKind,
	) => readonly string[];
};

/**
 * The prompt actions this organization is offered (Fizzy #2946).
 *
 * Where the Proposal artifact is on, a Proposal's Main prompt is chosen at
 * Client proposal (Main) only; the legacy Proposal actions are not offered.
 * Every surface that lists, counts or binds actions takes them from here, so
 * one gate read decides them all, and a component test mocks one module
 * (`@saas/shared/components/FeatureFlagProvider`) to set it.
 *
 * Labels for bindings already saved at a superseded action come from the full
 * `listPromptActions()`, never from this list.
 */
export function useOfferedPromptActions(): OfferedPromptActions {
	const proposalArtifactOn = useFeatureFlag("PROPOSAL_ARTIFACT");
	return useMemo(() => {
		const actions = listOfferedPromptActions(proposalArtifactOn);
		return {
			proposalArtifactOn,
			actions,
			actionIds: new Set(actions.map((action) => action.id)),
			isSuperseded: (targetKey: string, documentType: string) =>
				isSupersededPromptAction(
					targetKey,
					documentType,
					proposalArtifactOn,
				),
			documentTypesFor: (
				agent: PromptAgentTarget,
				storyKind: PromptStoryKind,
			) => offeredDocumentTypes(agent, storyKind, proposalArtifactOn),
		};
	}, [proposalArtifactOn]);
}
