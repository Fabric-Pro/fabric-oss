"use client";

/**
 * Settings ▸ AI assistant: what the assistant may change (Read-only mode), how
 * often it asks and how much it tests, and which prompt each action runs.
 *
 * Owns the one piece of state the cards share: "See the prompt behind each
 * level" on the clarifying-questions card filters the prompt list below it.
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import type { ComponentProps } from "react";
import { useState } from "react";
import { ProjectAiAssistantSettings } from "./ProjectAiAssistantSettings";
import { ProjectPromptDefaultsSettings } from "./ProjectPromptDefaultsSettings";
import { ProjectReadOnlyModeSettings } from "./ProjectReadOnlyModeSettings";
import {
	PROMPT_DEFAULTS_ANCHOR_ID,
	type PromptDefaultsFocusRequest,
} from "./prompt-defaults/prompt-default-model";

type Props = {
	project: ComponentProps<typeof ProjectAiAssistantSettings>["project"] &
		ComponentProps<typeof ProjectReadOnlyModeSettings>["project"];
	canEdit: boolean;
	onOpenTestingSettings?: () => void;
};

export function ProjectAiAssistantTab({
	project,
	canEdit,
	onOpenTestingSettings,
}: Props) {
	const { organizationId } = useOrganizationContext();
	const [focusRequest, setFocusRequest] =
		useState<PromptDefaultsFocusRequest | null>(null);

	const showClarifyingPrompts = () => {
		setFocusRequest((previous) => ({
			search: "Clarifying Questions",
			seq: (previous?.seq ?? 0) + 1,
		}));
		const reduceMotion = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		document.getElementById(PROMPT_DEFAULTS_ANCHOR_ID)?.scrollIntoView({
			behavior: reduceMotion ? "auto" : "smooth",
			block: "start",
		});
	};

	return (
		<div className="space-y-6">
			<div>
				<span className="inline-flex items-center gap-2 font-semibold text-[0.6875rem] text-muted-foreground uppercase tracking-[0.2em]">
					<span
						className="h-3 w-0.5 rounded-full bg-primary"
						aria-hidden="true"
					/>
					AI Assistant
				</span>
				<h3 className="mt-2 font-semibold text-foreground text-xl">
					How the assistant works on this project
				</h3>
				<p className="mt-2 max-w-3xl text-pretty text-muted-foreground text-sm">
					What it may change, how often it asks, how much it tests,
					and which prompt each action runs.
				</p>
			</div>
			<ProjectReadOnlyModeSettings project={project} canEdit={canEdit} />
			<ProjectAiAssistantSettings
				project={project}
				canEdit={canEdit}
				// Personal context has no project prompt list to filter.
				onShowClarifyingPrompts={
					organizationId ? showClarifyingPrompts : undefined
				}
				onOpenTestingSettings={onOpenTestingSettings}
			/>
			<ProjectPromptDefaultsSettings
				projectId={project.id}
				focusRequest={focusRequest}
			/>
		</div>
	);
}
