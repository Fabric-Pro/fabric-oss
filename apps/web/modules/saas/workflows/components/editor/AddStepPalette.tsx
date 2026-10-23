"use client";

import { SearchInput } from "@ui/components/search-input";
import { PlugIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { getNodeAppearance } from "../../lib/node-appearance";
import type { NodeTypeDefinition, WorkflowNodeData } from "../../lib/types";

/**
 * The "Add step" tab: every action the builder can place, searchable and
 * grouped by its category in palette order (system nodes first). Picking one
 * fills the selected empty step, or adds it after the last step.
 */
export function AddStepPalette({
	nodes,
	onAdd,
	integrationsPath,
}: {
	nodes: NodeTypeDefinition[];
	onAdd: (type: string, data: Partial<WorkflowNodeData>) => void;
	integrationsPath: string;
}) {
	const [query, setQuery] = useState("");

	const groups = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const matches = needle
			? nodes.filter(
					(node) =>
						node.label.toLowerCase().includes(needle) ||
						node.description.toLowerCase().includes(needle) ||
						node.category.toLowerCase().includes(needle),
				)
			: nodes;
		const grouped: { category: string; nodes: NodeTypeDefinition[] }[] = [];
		for (const node of matches) {
			const group = grouped.find((g) => g.category === node.category);
			if (group) {
				group.nodes.push(node);
			} else {
				grouped.push({ category: node.category, nodes: [node] });
			}
		}
		return grouped;
	}, [nodes, query]);

	return (
		<div className="flex flex-col gap-3.5 px-4 py-3.5">
			<div className="relative">
				<SearchIcon
					className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
					aria-hidden="true"
				/>
				<SearchInput
					aria-label="Search actions"
					placeholder="Search actions…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					className="h-[34px] rounded-lg pl-8"
				/>
			</div>

			{groups.map((group) => (
				<section
					key={group.category}
					aria-label={group.category}
					className="flex flex-col gap-1"
				>
					<h3 className="px-0.5 pb-1 font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
						{group.category}
					</h3>
					{group.nodes.map((node) => {
						const { Icon } = getNodeAppearance(
							node.type,
							node.defaultData,
						);
						return (
							<button
								type="button"
								key={node.type}
								title={node.description}
								data-testid={`workflow-action-${node.type}`}
								onClick={() =>
									onAdd(node.type, node.defaultData)
								}
								className="flex items-center gap-2.5 rounded-lg p-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring motion-safe:transition-colors"
							>
								<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
									<Icon className="size-3.5" />
								</span>
								<span className="flex min-w-0 flex-col gap-px">
									<span className="text-[13px]">
										{node.label}
									</span>
									<span className="truncate text-xs text-muted-foreground">
										{node.description}
									</span>
								</span>
							</button>
						);
					})}
				</section>
			))}

			{groups.length === 0 && (
				<p className="py-8 text-center text-sm text-muted-foreground">
					No actions found
				</p>
			)}

			<Link
				href={integrationsPath}
				className="flex items-center gap-1.5 px-0.5 py-1 text-xs text-muted-foreground hover:text-foreground"
			>
				<PlugIcon className="size-3.5" aria-hidden="true" />
				Manage integrations
			</Link>
		</div>
	);
}
