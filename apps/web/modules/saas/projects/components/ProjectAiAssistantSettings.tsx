"use client";

/**
 * ProjectAiAssistantSettings — the project-level "how often should the AI check
 * in?" control (the "pushback agent" frequency knob). Sets
 * `Project.clarifyingQuestionFrequency`, which is published to the AI Assistant
 * as a readable policy (see useClarifyingQuestions) so the agent asks the right
 * amount of clarifying questions.
 *
 * Also exposes `Project.qaStrategyLevel`, which controls the depth of QA
 * Strategy documents generated for this project.
 *
 * Both are radio groups of option cards, so every level's meaning is on the
 * page rather than behind a dropdown.
 *
 * Admin-editable (owner / project admin); read-only for everyone else. Writes go
 * through `projects.update`, which enforces PROJECT_UPDATE server-side. Copy
 * follows standards/ai/ai-copy-tone.md (calm, advisory; no "best/optimal/
 * required/recommended").
 */

import { useContextPath } from "@saas/organizations/hooks/use-organization-context";
import type { ClarifyingQuestionFrequency } from "@saas/shared/components/copilot/useClarifyingQuestions";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@ui/components/card";
import {
	ArrowDownIcon,
	ArrowRightIcon,
	ArrowUpRightIcon,
	LockIcon,
	TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type OptionCard,
	OptionCardRadioGroup,
} from "./ai-assistant/OptionCardRadioGroup";

type QaStrategyLevel = "LIGHT" | "STANDARD" | "STRICT";

const QA_STRATEGY_OPTIONS: ReadonlyArray<OptionCard<QaStrategyLevel>> = [
	{
		value: "LIGHT",
		label: "Early-stage",
		hint: "Functional and acceptance tests only — suitable for early-stage or prototype projects.",
	},
	{
		value: "STANDARD",
		label: "Standard",
		hint: "Adds regression, security, and browser matrix testing on top of functional coverage.",
		isDefault: true,
	},
	{
		value: "STRICT",
		label: "Production/Enterprise",
		hint: "Full coverage including performance benchmarks and WCAG 2.1 AA accessibility.",
	},
];

const FREQUENCY_OPTIONS: ReadonlyArray<
	OptionCard<ClarifyingQuestionFrequency>
> = [
	{
		value: "MINIMAL",
		label: "Minimal",
		hint: "Rarely — the assistant makes reasonable assumptions and only asks when it is genuinely blocked.",
	},
	{
		value: "BALANCED",
		label: "Balanced",
		hint: "Asks when there is material ambiguity that would change the result.",
		isDefault: true,
	},
	{
		value: "THOROUGH",
		label: "Thorough",
		hint: "Asks proactively whenever extra detail would help refine the work.",
	},
];

const linkClassName =
	"inline-flex items-center gap-1 text-foreground/90 text-xs underline-offset-2 hover:text-foreground hover:underline";

type Props = {
	project: {
		id: string;
		organizationId?: string | null;
		clarifyingQuestionFrequency?: ClarifyingQuestionFrequency | null;
		qaStrategyLevel?: QaStrategyLevel | null;
	};
	/** Whether the current user may change the setting (admins). */
	canEdit: boolean;
	/** Show the Clarifying Questions prompts in this page's prompt list. Absent
	 *  where the page has no list (personal context), and the link goes to the
	 *  Prompt Library instead. */
	onShowClarifyingPrompts?: () => void;
	/** Open Settings ▸ Testing. Absent while that sub-tab is gated off. */
	onOpenTestingSettings?: () => void;
};

export function ProjectAiAssistantSettings({
	project,
	canEdit,
	onShowClarifyingPrompts,
	onOpenTestingSettings,
}: Props) {
	const queryClient = useQueryClient();
	const promptsPath = useContextPath("/prompts");
	const initial = project.clarifyingQuestionFrequency ?? "BALANCED";
	const [value, setValue] = useState<ClarifyingQuestionFrequency>(initial);
	const initialQaLevel = project.qaStrategyLevel ?? "STANDARD";
	const [qaLevel, setQaLevel] = useState<QaStrategyLevel>(initialQaLevel);
	// Keep local state in sync if the project prop changes (e.g. after refetch).
	useEffect(() => {
		setValue(project.clarifyingQuestionFrequency ?? "BALANCED");
	}, [project.clarifyingQuestionFrequency]);

	useEffect(() => {
		setQaLevel(project.qaStrategyLevel ?? "STANDARD");
	}, [project.qaStrategyLevel]);

	const updateMutation = useMutation({
		mutationFn: async (next: ClarifyingQuestionFrequency) => {
			return await orpcClient.projects.update({
				id: project.id,
				organizationId: project.organizationId,
				clarifyingQuestionFrequency: next,
			});
		},
		onSuccess: () => {
			toast.success("Clarifying-question frequency updated");
			// Invalidate the project query so other surfaces (e.g. the AI
			// Assistant sidebar) pick up the new frequency on their next read.
			queryClient.invalidateQueries({
				queryKey: orpc.projects.get.queryKey({
					input: {
						id: project.id,
						organizationId: project.organizationId,
					},
				}),
			});
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update setting",
			);
		},
	});

	const qaStrategyMutation = useMutation({
		mutationFn: async (next: QaStrategyLevel) => {
			return await orpcClient.projects.update({
				id: project.id,
				organizationId: project.organizationId,
				qaStrategyLevel: next,
			});
		},
		onSuccess: () => {
			toast.success("Testing Strategy depth updated");
			queryClient.invalidateQueries({
				queryKey: orpc.projects.get.queryKey({
					input: {
						id: project.id,
						organizationId: project.organizationId,
					},
				}),
			});
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update setting",
			);
		},
	});

	const handleChange = (next: ClarifyingQuestionFrequency) => {
		const previous = value;
		// Optimistic select; revert to the prior value if the write fails.
		setValue(next);
		updateMutation.mutate(next, {
			onError: () => setValue(previous),
		});
	};

	const handleQaLevelChange = (next: QaStrategyLevel) => {
		const previous = qaLevel;
		// Optimistic select; revert to the prior value if the write fails.
		setQaLevel(next);
		qaStrategyMutation.mutate(next, {
			onError: () => setQaLevel(previous),
		});
	};

	return (
		<Card className="overflow-hidden p-0">
			<div className="space-y-3.5 px-4 py-5 sm:px-6">
				<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
					<div className="min-w-0">
						<h3
							id="clarifying-frequency-label"
							className="font-semibold text-base"
						>
							Clarifying questions
						</h3>
						<p className="mt-1 text-muted-foreground text-sm">
							How often the assistant pauses to ask before it
							proceeds.
						</p>
					</div>
					{onShowClarifyingPrompts ? (
						<button
							type="button"
							onClick={onShowClarifyingPrompts}
							className={`${linkClassName} mt-1 whitespace-nowrap`}
						>
							See the prompt behind each level
							<ArrowDownIcon
								aria-hidden="true"
								className="size-3"
							/>
						</button>
					) : (
						<Link
							href={`${promptsPath}?search=${encodeURIComponent(
								"Clarifying Questions",
							)}`}
							className={`${linkClassName} mt-1 whitespace-nowrap`}
						>
							See the prompt behind each level
							<ArrowUpRightIcon
								aria-hidden="true"
								className="size-3"
							/>
						</Link>
					)}
				</div>
				<OptionCardRadioGroup
					labelledBy="clarifying-frequency-label"
					options={FREQUENCY_OPTIONS}
					value={value}
					onValueChange={handleChange}
					disabled={!canEdit}
				/>
				{value === "MINIMAL" && (
					<p className="flex items-center gap-1.5 text-highlight-ink text-xs">
						<TriangleAlertIcon
							aria-hidden="true"
							className="size-3 shrink-0"
						/>
						The assistant will rarely ask — it may proceed on
						assumptions you can revise later.
					</p>
				)}
				<p className="text-muted-foreground text-xs">
					Questions appear as an in-chat card with clickable options;
					dismissing records them as open items.
				</p>
			</div>

			<div className="space-y-3.5 border-t px-4 py-5 sm:px-6">
				<div>
					<h3
						id="qa-strategy-level-label"
						className="font-semibold text-base"
					>
						Testing Strategy depth
					</h3>
					<p className="mt-1 text-muted-foreground text-sm">
						How much QA coverage the assistant plans for this
						project.
					</p>
				</div>
				<OptionCardRadioGroup
					labelledBy="qa-strategy-level-label"
					options={QA_STRATEGY_OPTIONS}
					value={qaLevel}
					onValueChange={handleQaLevelChange}
					disabled={!canEdit}
				/>
				{/* The test-case toggles moved to Settings ▸ Testing; one line
				    says where, so the move never reads as a removal. */}
				<p className="flex flex-wrap items-center gap-1 text-muted-foreground text-xs">
					Test-case generation, TDD ordering and automatic bugs for
					failing tests live in
					{onOpenTestingSettings ? (
						<button
							type="button"
							onClick={onOpenTestingSettings}
							className={linkClassName}
						>
							Settings ▸ Testing
							<ArrowRightIcon
								aria-hidden="true"
								className="size-3"
							/>
						</button>
					) : (
						<span>Settings ▸ Testing.</span>
					)}
				</p>
			</div>

			{!canEdit && (
				<p className="flex items-center gap-1.5 border-t px-4 py-3 text-muted-foreground text-xs sm:px-6">
					<LockIcon aria-hidden="true" className="size-3" />
					Only project admins can change these settings.
				</p>
			)}
		</Card>
	);
}
