"use client";

/**
 * The "More Roadmap actions" menu beside AI Update (Fizzy #2204).
 *
 * 3A ships it empty; 3B and 3C add their items through
 * `useRoadmapActionItems`. With no items it renders nothing, so the toolbar
 * looks exactly as before until an item exists.
 *
 * A disabled item is `aria-disabled`, not Radix `disabled`: Radix drops a
 * disabled item from arrow-key focus, which would leave its reason unreachable
 * by keyboard and unannounced by a screen reader (AC-14, AC-20). Selecting it
 * does nothing and keeps the menu open. Its fix, when it has one, is a
 * separate item right after it — a link cannot sit inside a menu item.
 */

import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { cn } from "@ui/lib";
import { AlertCircleIcon, MoreHorizontalIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import type { RoadmapActionItem } from "./roadmap-entry/roadmap-action-items";

export function RoadmapActionsMenu({ items }: { items: RoadmapActionItem[] }) {
	const t = useTranslations("projects.stories.actionsMenu");
	if (items.length === 0) {
		return null;
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					aria-label={t("trigger")}
					data-onboarding-target="roadmap-actions"
				>
					<MoreHorizontalIcon aria-hidden className="size-4" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="max-w-xs">
				{items.map((item) => (
					<ActionItem key={item.id} item={item} />
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ActionItem({ item }: { item: RoadmapActionItem }) {
	const {
		label,
		icon: Icon,
		onSelect,
		disabledReason,
		disabledDetail,
		description,
		warning,
		remedy,
	} = item;
	const disabled = disabledReason !== null;

	return (
		<>
			<DropdownMenuItem
				aria-disabled={disabled || undefined}
				onSelect={(event) => {
					if (disabled) {
						event.preventDefault();
						return;
					}
					onSelect();
				}}
				className={cn(
					"items-start",
					disabled &&
						"cursor-not-allowed text-muted-foreground focus:text-muted-foreground",
				)}
			>
				<Icon aria-hidden className="mt-0.5 mr-2 size-4 shrink-0" />
				<span className="flex flex-col gap-0.5">
					<span>{label}</span>
					{description && (
						<span className="text-muted-foreground text-xs">
							{description}
						</span>
					)}
					{disabledReason && (
						<span className="font-medium text-foreground text-xs">
							{disabledReason}
						</span>
					)}
					{disabledDetail && (
						<span className="text-muted-foreground text-xs">
							{disabledDetail}
						</span>
					)}
					{warning && (
						<span className="flex items-start gap-1 text-muted-foreground text-xs">
							<AlertCircleIcon
								aria-hidden
								className="mt-0.5 size-3 shrink-0 text-highlight"
							/>
							{warning}
						</span>
					)}
				</span>
			</DropdownMenuItem>
			{disabled && remedy && (
				<DropdownMenuItem
					asChild={"href" in remedy}
					onSelect={
						"onSelect" in remedy ? remedy.onSelect : undefined
					}
					className="pl-8 font-medium text-primary text-xs"
				>
					{"href" in remedy ? (
						<Link href={remedy.href}>{remedy.label}</Link>
					) : (
						remedy.label
					)}
				</DropdownMenuItem>
			)}
		</>
	);
}
