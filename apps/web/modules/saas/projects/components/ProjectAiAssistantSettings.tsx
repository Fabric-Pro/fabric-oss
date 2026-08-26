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
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { ArrowUpRightIcon, InfoIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type QaStrategyLevel = "LIGHT" | "STANDARD" | "STRICT";

const QA_STRATEGY_OPTIONS: Array<{
	value: QaStrategyLevel;
	label: string;
	hint: string;
}> = [
	{
		value: "LIGHT",
		label: "Early-stage (functional & acceptance only)",
		hint: "Covers functional and acceptance tests only — suitable for early-stage or prototype projects.",
	},
	{
		value: "STANDARD",
		label: "Standard (+ regression, security, browser matrix)",
		hint: "Adds regression, security, and browser matrix testing on top of functional coverage (default).",
	},
	{
		value: "STRICT",
		label: "Production/Enterprise (+ performance, WCAG 2.1 AA)",
		hint: "Full coverage including performance benchmarks and WCAG 2.1 AA accessibility — suited for production or enterprise projects.",
	},
];

const FREQUENCY_OPTIONS: Array<{
	value: ClarifyingQuestionFrequency;
	label: string;
	hint: string;
}> = [
	{
		value: "MINIMAL",
		label: "Minimal",
		hint: "Rarely — the assistant makes reasonable assumptions and only asks when it is genuinely blocked.",
	},
	{
		value: "BALANCED",
		label: "Balanced (default)",
		hint: "Asks when there is material ambiguity that would change the result.",
	},
	{
		value: "THOROUGH",
		label: "Thorough",
		hint: "Asks proactively whenever extra detail would help refine the work.",
	},
];

type Props = {
	project: {
		id: string;
		organizationId?: string | null;
		clarifyingQuestionFrequency?: ClarifyingQuestionFrequency | null;
		qaStrategyLevel?: QaStrategyLevel | null;
	};
	/** Whether the current user may change the setting (admins). */
	canEdit: boolean;
};

export function ProjectAiAssistantSettings({ project, canEdit }: Props) {
	const queryClient = useQueryClient();
	// Context-aware path to the Prompt Library (org or personal), used for the
	// "customize these prompts" deep link below.
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

	const handleChange = (next: string) => {
		const typed = next as ClarifyingQuestionFrequency;
		const previous = value;
		// Optimistic select; revert to the prior value if the write fails.
		setValue(typed);
		updateMutation.mutate(typed, {
			onError: () => setValue(previous),
		});
	};

	const handleQaLevelChange = (next: string) => {
		const typed = next as QaStrategyLevel;
		const previous = qaLevel;
		// Optimistic select; revert to the prior value if the write fails.
		setQaLevel(typed);
		qaStrategyMutation.mutate(typed, {
			onError: () => setQaLevel(previous),
		});
	};

	const activeHint =
		FREQUENCY_OPTIONS.find((o) => o.value === value)?.hint ?? "";
	const activeQaHint =
		QA_STRATEGY_OPTIONS.find((o) => o.value === qaLevel)?.hint ?? "";

	return (
		<Card className="p-6">
			<div className="space-y-4">
				<div>
					<span className="inline-flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
						<span
							className="h-3 w-0.5 rounded-full bg-primary"
							aria-hidden="true"
						/>
						AI Assistant
					</span>
					<h3 className="mt-2 text-base font-semibold text-foreground">
						Clarifying questions
					</h3>
					<p className="mt-1 max-w-2xl text-sm text-muted-foreground">
						Choose how often the AI Assistant pauses to ask a
						clarifying question while it analyzes or matures work.
						Questions appear in the assistant with quick answer
						options you can click or type past.
					</p>
				</div>

				<div className="max-w-sm space-y-2">
					<div className="flex items-center gap-1.5">
						<Label htmlFor="clarifying-frequency">Frequency</Label>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									className="rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									aria-label="How clarifying-question frequency works"
								>
									<InfoIcon className="size-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs">
								<p className="font-medium">
									How often the assistant pauses to ask:
								</p>
								<ul className="mt-1 space-y-1">
									<li>
										<span className="font-medium">
											Minimal
										</span>{" "}
										— rarely; proceeds on reasonable
										assumptions, asks only when truly
										blocked.
									</li>
									<li>
										<span className="font-medium">
											Balanced
										</span>{" "}
										— asks when there is material ambiguity
										(default).
									</li>
									<li>
										<span className="font-medium">
											Thorough
										</span>{" "}
										— asks proactively to refine details.
									</li>
								</ul>
								<p className="mt-1 text-muted-foreground">
									Questions appear as an in-chat card with
									clickable options; dismissing records them
									as open items.
								</p>
							</TooltipContent>
						</Tooltip>
					</div>
					<Select
						value={value}
						onValueChange={handleChange}
						disabled={!canEdit || updateMutation.isPending}
					>
						<SelectTrigger id="clarifying-frequency">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{FREQUENCY_OPTIONS.map((option) => (
								<SelectItem
									key={option.value}
									value={option.value}
								>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{activeHint && (
						<p className="text-xs text-muted-foreground">
							{activeHint}
						</p>
					)}
					{value === "MINIMAL" && (
						<p className="text-xs text-highlight-foreground">
							The assistant will rarely ask — it may proceed on
							assumptions you can revise later.
						</p>
					)}
					{!canEdit && (
						<p className="text-xs text-muted-foreground">
							Only project admins can change this setting.
						</p>
					)}
					{canEdit && (
						<Link
							href={`${promptsPath}?search=${encodeURIComponent(
								"Clarifying Questions",
							)}`}
							className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
						>
							Customize these prompts in the Prompt Library
							<ArrowUpRightIcon
								className="size-3"
								aria-hidden="true"
							/>
						</Link>
					)}
				</div>

				<div className="max-w-sm space-y-2">
					<div className="flex items-center gap-1.5">
						<Label htmlFor="qa-strategy-level">
							Testing Strategy depth
						</Label>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									className="rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									aria-label="How Testing Strategy depth works"
								>
									<InfoIcon className="size-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs">
								<p className="font-medium">
									How much QA coverage the assistant
									generates:
								</p>
								<ul className="mt-1 space-y-1">
									<li>
										<span className="font-medium">
											Early-stage
										</span>{" "}
										— functional and acceptance tests only.
									</li>
									<li>
										<span className="font-medium">
											Standard
										</span>{" "}
										— adds regression, security, and browser
										matrix coverage (default).
									</li>
									<li>
										<span className="font-medium">
											Production/Enterprise
										</span>{" "}
										— full coverage including performance
										and WCAG 2.1 AA accessibility.
									</li>
								</ul>
							</TooltipContent>
						</Tooltip>
					</div>
					<Select
						value={qaLevel}
						onValueChange={handleQaLevelChange}
						disabled={!canEdit || qaStrategyMutation.isPending}
					>
						<SelectTrigger id="qa-strategy-level">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{QA_STRATEGY_OPTIONS.map((option) => (
								<SelectItem
									key={option.value}
									value={option.value}
								>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{activeQaHint && (
						<p className="text-xs text-muted-foreground">
							{activeQaHint}
						</p>
					)}
					{!canEdit && (
						<p className="text-xs text-muted-foreground">
							Only project admins can change this setting.
						</p>
					)}
				</div>

				{/*
				 * The three test-case toggles that used to live here moved to
				 * Settings ▸ Testing, next to the rest of the QA policy. A
				 * pointer rather than a silent removal: anyone who knew where
				 * they were needs to be told where they went, and a control
				 * that simply vanishes reads as a regression.
				 */}
				<div className="max-w-sm space-y-2 border-t border-border pt-4">
					<Label>Test cases</Label>
					<p className="text-muted-foreground text-xs">
						Test-case generation, the TDD ordering and automatic
						bugs for failing tests now live in Settings ▸ Testing,
						with the rest of the testing policy.
					</p>
				</div>
			</div>
		</Card>
	);
}
