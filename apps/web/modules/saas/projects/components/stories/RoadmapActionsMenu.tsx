"use client";

/**
 * The labelled Actions menu beside Add work item gathers page operations and
 * the capability-aware items supplied by useRoadmapActionItems. The page owns
 * their controllers and overlays so closing the menu does not stop an operation.
 *
 * A disabled item is aria-disabled, not Radix disabled: Radix drops disabled
 * items from arrow-key focus, leaving their reasons unreachable by keyboard
 * and unannounced by a screen reader (AC-14, AC-20). Selection guards keep these
 * items inert without closing the menu. The export submenu uses the same focus
 * convention and guards its open state and activation events while exporting.
 *
 * A remedy is a separate item immediately after its disabled action: a link
 * cannot sit inside another menu item. Descriptions explain the action before
 * the user invokes it; disabled reasons explain why it cannot run yet.
 */

import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	ArchiveIcon,
	CopyIcon,
	DownloadIcon,
	HistoryIcon,
	MoreHorizontalIcon,
	RefreshCwIcon,
	WandSparklesIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";

import type { RoadmapActionItem } from "./roadmap-entry/roadmap-action-items";

type PageActions = {
	onClassify: () => void;
	classifyDisabledReason: string | null;
	onScan: () => void;
	scanning: boolean;
	onExport: (format: "markdown" | "csv") => void;
	exporting: boolean;
	onRefresh: () => void;
	onHistory: () => void;
	onRejected: () => void;
};

export function RoadmapActionsMenu({
	items,
	actions,
}: {
	items: RoadmapActionItem[];
	actions?: PageActions;
}) {
	const [exportOpen, setExportOpen] = useState(false);
	const tTips = useTranslations("tooltips.stories");
	const tTracks = useTranslations("projects.stories.deliveryTrack");
	const t = useTranslations("projects.stories.actionsMenu");
	const tDuplicates = useTranslations("projects.stories.duplicates");
	const tExport = useTranslations("projects.stories.scopeEstimate");
	const tUi = useTranslations("projects.stories.roadmapUi");
	const pageItems: RoadmapActionItem[] = actions
		? [
				{
					id: "classify",
					label: t("classify"),
					description: `${tTracks("classifyTooltip")} ${tTips("classifyConcept")}`,
					icon: WandSparklesIcon,
					onSelect: actions.onClassify,
					disabledReason: actions.classifyDisabledReason,
				},
				{
					id: "scan",
					label: tDuplicates("scanButton"),
					description: tDuplicates("scanTooltip"),
					icon: CopyIcon,
					onSelect: actions.onScan,
					disabledReason: actions.scanning ? tUi("scanning") : null,
				},
				{
					id: "refresh",
					label: t("refresh"),
					description: tTips("refreshRoadmap"),
					icon: RefreshCwIcon,
					onSelect: actions.onRefresh,
					disabledReason: null,
				},
				{
					id: "history",
					label: t("history"),
					description: t("historyDescription"),
					icon: HistoryIcon,
					onSelect: actions.onHistory,
					disabledReason: null,
				},
				{
					id: "rejected",
					label: t("rejected"),
					description: t("rejectedDescription"),
					icon: ArchiveIcon,
					onSelect: actions.onRejected,
					disabledReason: null,
				},
			]
		: [];
	const exportItem: RoadmapActionItem = {
		id: "export",
		label: tExport("export"),
		icon: DownloadIcon,
		onSelect: () => setExportOpen(true),
		description: tTips("estimateExport"),
		disabledReason: actions?.exporting ? t("exportInProgress") : null,
	};

	if (items.length === 0 && !actions) {
		return null;
	}
	return (
		<DropdownMenu
			onOpenChange={(open) => {
				if (!open) {
					setExportOpen(false);
				}
			}}
		>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					aria-label={t("trigger")}
					data-onboarding-target="roadmap-actions"
				>
					<MoreHorizontalIcon aria-hidden className="size-4" />
					{t("trigger")}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="max-w-xs">
				{pageItems.slice(0, 2).map((item) => (
					<ActionItem key={item.id} item={item} />
				))}
				{actions && (
					<DropdownMenuSub
						open={exportOpen && !actions.exporting}
						onOpenChange={(open) =>
							setExportOpen(open && !actions.exporting)
						}
					>
						<DropdownMenuSubTrigger
							aria-disabled={actions.exporting || undefined}
							onClick={(event) => {
								if (actions.exporting) {
									event.preventDefault();
								}
							}}
							onKeyDown={(event) => {
								if (
									actions.exporting &&
									["Enter", " ", "ArrowRight"].includes(
										event.key,
									)
								) {
									event.preventDefault();
								}
							}}
							className={cn(
								"items-start [&>svg:last-child]:shrink-0",
								actions.exporting &&
									"cursor-not-allowed text-muted-foreground focus:text-muted-foreground",
							)}
						>
							<ActionItemContent item={exportItem} />
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							<DropdownMenuItem
								onSelect={() => actions.onExport("markdown")}
							>
								{tExport("markdown")}
							</DropdownMenuItem>
							<DropdownMenuItem
								onSelect={() => actions.onExport("csv")}
							>
								{tExport("csv")}
							</DropdownMenuItem>
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				)}
				{pageItems.slice(2).map((item) => (
					<ActionItem key={item.id} item={item} />
				))}
				{actions && items.length > 0 && <DropdownMenuSeparator />}
				{items.map((item) => (
					<ActionItem key={item.id} item={item} />
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ActionItem({ item }: { item: RoadmapActionItem }) {
	const { onSelect, disabledReason, remedy } = item;
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
				<ActionItemContent item={item} />
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

function ActionItemContent({ item }: { item: RoadmapActionItem }) {
	const {
		label,
		icon: Icon,
		description,
		disabledReason,
		disabledDetail,
		warning,
	} = item;
	return (
		<>
			<Icon aria-hidden className="mt-0.5 mr-2 size-4 shrink-0" />
			<span className="min-w-0 flex-1 flex flex-col gap-0.5">
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
		</>
	);
}
