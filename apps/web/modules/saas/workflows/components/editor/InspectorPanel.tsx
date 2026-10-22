"use client";

import { cn } from "@ui/lib";
import { type KeyboardEvent, type ReactNode, useRef } from "react";

export type InspectorTab = "workflow" | "add";

const TABS: readonly InspectorTab[] = ["workflow", "add"];

/**
 * The right-hand inspector: two tabs over one content area. The first tab
 * reads "Workflow", or "Step" while a step is selected; the second is the
 * "Add step" palette. The builder decides what the content is.
 */
export function InspectorPanel({
	tab,
	onTabChange,
	stepSelected,
	children,
}: {
	tab: InspectorTab;
	onTabChange: (tab: InspectorTab) => void;
	stepSelected: boolean;
	children: ReactNode;
}) {
	const tabRefs = useRef<Partial<Record<InspectorTab, HTMLButtonElement>>>(
		{},
	);
	const labels: Record<InspectorTab, string> = {
		workflow: stepSelected ? "Step" : "Workflow",
		add: "Add step",
	};

	// Arrow keys move between tabs, as the ARIA tabs pattern expects.
	const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
			return;
		}
		event.preventDefault();
		const next = TABS[(TABS.indexOf(tab) + 1) % TABS.length];
		onTabChange(next);
		tabRefs.current[next]?.focus();
	};

	return (
		<aside
			className="flex w-[340px] shrink-0 flex-col border-l bg-background"
			aria-label="Inspector"
		>
			<div
				role="tablist"
				aria-label="Inspector"
				className="flex h-12 shrink-0 items-end gap-5 border-b px-4"
			>
				{TABS.map((value) => {
					const active = value === tab;
					return (
						<button
							key={value}
							ref={(element) => {
								if (element) {
									tabRefs.current[value] = element;
								}
							}}
							type="button"
							role="tab"
							id={`inspector-tab-${value}`}
							aria-selected={active}
							aria-controls="inspector-panel"
							tabIndex={active ? 0 : -1}
							data-testid={
								value === "add"
									? "workflow-actions-tab"
									: undefined
							}
							onClick={() => onTabChange(value)}
							onKeyDown={handleKeyDown}
							className={cn(
								"-mb-px h-full border-b-2 text-[13px] focus-visible:outline-2 focus-visible:outline-ring",
								active
									? "border-primary text-foreground"
									: "border-transparent text-muted-foreground hover:text-foreground",
							)}
						>
							{labels[value]}
						</button>
					);
				})}
			</div>
			<div
				role="tabpanel"
				id="inspector-panel"
				aria-labelledby={`inspector-tab-${tab}`}
				className="flex min-h-0 flex-1 flex-col overflow-y-auto"
			>
				{children}
			</div>
		</aside>
	);
}
