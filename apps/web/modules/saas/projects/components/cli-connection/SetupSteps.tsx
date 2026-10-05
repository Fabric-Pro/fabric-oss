import { cn } from "@ui/lib";
import type { ReactNode } from "react";

export interface SetupStep {
	id: string;
	title: string;
	/**
	 * The step that happens in the browser rather than at the keyboard: drawn as
	 * an outlined circle where the steps the person performs are filled.
	 */
	approve?: boolean;
	children: ReactNode;
}

/** A literal inside a sentence: a file name, a slash command, a branch. */
export function InlineCode({ children }: { children: ReactNode }) {
	return (
		<code className="rounded border border-border bg-muted px-1.5 py-px font-medium font-mono text-foreground text-xs">
			{children}
		</code>
	);
}

/**
 * Numbered steps joined by a vertical connector. The numbers are the list's
 * own, so the circles are decoration; a list without its bullets loses its
 * list semantics in some screen readers, hence the explicit role.
 */
export function StepList({ steps }: { steps: readonly SetupStep[] }) {
	return (
		// biome-ignore lint/a11y/noRedundantRoles: list-style: none drops the list semantics in Safari.
		// biome-ignore lint/a11y/useSemanticElements: the element is already an <ol>; the role only restores what the style removed.
		<ol className="m-0 list-none p-0" role="list">
			{steps.map((step, index) => {
				const last = index === steps.length - 1;
				return (
					<li
						className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3.5"
						key={step.id}
					>
						<div className="flex flex-col items-center">
							<span
								aria-hidden="true"
								className={cn(
									"flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-xs",
									step.approve
										? "border border-input bg-background text-muted-foreground"
										: "bg-primary text-primary-foreground",
								)}
							>
								{index + 1}
							</span>
							{last ? null : (
								<span
									aria-hidden="true"
									className="my-1.5 w-px flex-1 bg-border"
								/>
							)}
						</div>
						<div
							className={cn(
								"min-w-0 space-y-2.5",
								last ? "pb-1" : "pb-5",
							)}
						>
							<p className="font-medium text-sm leading-6">
								{step.title}
							</p>
							{step.children}
						</div>
					</li>
				);
			})}
		</ol>
	);
}
