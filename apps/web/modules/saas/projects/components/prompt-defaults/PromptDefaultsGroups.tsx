"use client";

import type { PromptFeatureTypeKey } from "@repo/utils/prompt-action-catalog";
import { cn } from "@ui/lib";
import { ChevronRightIcon } from "lucide-react";
import { Fragment } from "react";
import {
	PromptDefaultRow,
	type PromptDefaultRowActions,
} from "./PromptDefaultRow";
import { PromptTierBadge } from "./PromptTierBadge";
import { type PromptDefaultGroup, TIER_LABEL } from "./prompt-default-model";

/** Tiers worth a chip on a group header — the ones someone chose on purpose. */
const GROUP_CHIP_TIERS = ["PROJECT", "ORG"] as const;

/**
 * The offered actions, one collapsible section per product area. While a
 * search or tier filter is active every group with a match is open and the
 * toggles are inert: the point of filtering is to see the matches.
 */
export function PromptDefaultsGroups({
	groups,
	filtering,
	openGroups,
	onToggleGroup,
	pendingActionId,
	...actions
}: Omit<PromptDefaultRowActions, "busy"> & {
	groups: readonly PromptDefaultGroup[];
	filtering: boolean;
	openGroups: ReadonlySet<PromptFeatureTypeKey>;
	onToggleGroup: (key: PromptFeatureTypeKey) => void;
	pendingActionId: string | null;
}) {
	return (
		<div className="border-t">
			{groups.map((group) => {
				const open = filtering || openGroups.has(group.key);
				const panelId = `prompt-defaults-group-${group.key}`;
				return (
					<section
						key={group.key}
						className="border-b last:border-b-0"
					>
						<h4>
							<button
								type="button"
								aria-expanded={open}
								aria-controls={panelId}
								onClick={() => onToggleGroup(group.key)}
								className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-1.5 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none sm:px-6"
							>
								<ChevronRightIcon
									aria-hidden="true"
									className={cn(
										"size-4 shrink-0 text-muted-foreground motion-safe:transition-transform",
										open && "rotate-90",
									)}
								/>
								<span className="whitespace-nowrap font-medium text-sm">
									{group.label}
								</span>
								<span className="whitespace-nowrap text-muted-foreground text-xs tabular-nums">
									{filtering
										? `${group.items.length} of ${group.total}`
										: group.total}
								</span>
								<span className="hidden min-w-0 flex-1 truncate text-muted-foreground/80 text-xs md:block">
									{group.description}
								</span>
								<span className="ml-auto flex shrink-0 gap-1.5">
									{GROUP_CHIP_TIERS.filter(
										(tier) => group.tierCounts[tier] > 0,
									).map((tier) => (
										<PromptTierBadge key={tier} tier={tier}>
											{group.tierCounts[tier]}{" "}
											{TIER_LABEL[tier]}
										</PromptTierBadge>
									))}
								</span>
							</button>
						</h4>
						{open && (
							<ul id={panelId} className="px-1 pb-2.5 sm:px-3">
								{group.items.map((item) => (
									<Fragment key={item.row.action.id}>
										{item.agentHeader && (
											<li className="px-3 pt-2.5 pb-0.5 font-medium text-[11px] text-muted-foreground tracking-[0.04em]">
												{item.agentHeader}
											</li>
										)}
										<PromptDefaultRow
											row={item.row}
											title={item.title}
											subtitle={item.subtitle}
											busy={
												pendingActionId ===
												item.row.action.id
											}
											{...actions}
										/>
									</Fragment>
								))}
							</ul>
						)}
					</section>
				);
			})}
		</div>
	);
}
