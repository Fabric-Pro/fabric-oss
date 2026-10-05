"use client";

import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { GitBranchIcon } from "lucide-react";
import type { LocalSetupRoute } from "../../lib/instructions-repository-sync";
import { type CloneChoice, folderHint } from "./lib/agent-sign-in";

/** The step's title, which is also what names the radio group. */
export const REPOSITORY_STEP_TITLE = "Where's the repository?";

const CHOICES: ReadonlyArray<{ value: CloneChoice; label: string }> = [
	{ value: "have", label: "Already cloned" },
	{ value: "clone", label: "Clone it for me" },
];

function isCloneChoice(value: string): value is CloneChoice {
	return CHOICES.some((choice) => choice.value === value);
}

/**
 * Step one of a repository project's setup: do you have the repository, or
 * should the setup line clone it. A segmented control rather than two radio
 * dots, on the Radix radio group, so it stays one tab stop with arrow-key
 * selection and `radiogroup` semantics.
 *
 * Under it, the repository by name and where to run the line, which differs:
 * an existing clone has to be entered at its top folder (or the sync's root
 * folder inside it), a fresh one is created for the person.
 */
export function RepositoryChoice({
	route,
	choice,
	onChoiceChange,
}: {
	route: Extract<LocalSetupRoute, { kind: "repository" }>;
	choice: CloneChoice;
	onChoiceChange: (choice: CloneChoice) => void;
}) {
	return (
		<>
			<RadioGroupPrimitive.Root
				aria-label={REPOSITORY_STEP_TITLE}
				className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5"
				loop
				onValueChange={(value) => {
					if (isCloneChoice(value)) {
						onChoiceChange(value);
					}
				}}
				value={choice}
			>
				{CHOICES.map(({ value, label }) => (
					<RadioGroupPrimitive.Item
						className="rounded-md border border-transparent px-3 py-1.5 font-medium text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:border-border data-[state=checked]:bg-background data-[state=checked]:text-foreground"
						key={value}
						value={value}
					>
						{label}
					</RadioGroupPrimitive.Item>
				))}
			</RadioGroupPrimitive.Root>
			<p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground text-sm">
				<span className="inline-flex items-center gap-1.5">
					<GitBranchIcon aria-hidden="true" className="size-3.5" />
					<span className="font-mono text-foreground text-xs">
						{route.repositoryLabel}
					</span>
				</span>
				<span>· {folderHint(route, choice)}</span>
			</p>
		</>
	);
}
