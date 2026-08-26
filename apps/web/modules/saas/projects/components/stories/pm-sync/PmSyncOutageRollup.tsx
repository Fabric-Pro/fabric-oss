"use client";

import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { ChevronDownIcon, ChevronRightIcon, CloudOffIcon } from "lucide-react";
import { useState } from "react";

type PmSyncOutageItemRef = {
	id: string;
	itemType: "epic" | "feature" | "story" | "bug";
};

export type PmSyncOutageDetailItem = {
	id: string;
	itemType: "epic" | "feature" | "story" | "bug";
	identifier?: string;
	title?: string;
};

type Props = {
	pmToolName: string;
	count: number;
	items: PmSyncOutageItemRef[];
	details?: PmSyncOutageDetailItem[];
	errorClass?: string;
	onRetryAll: () => void;
	onOpenItem?: (item: PmSyncOutageItemRef) => void;
	isRetrying?: boolean;
	className?: string;
};

export function PmSyncOutageRollup({
	pmToolName,
	count,
	items,
	details,
	errorClass,
	onRetryAll,
	onOpenItem,
	isRetrying,
	className,
}: Props) {
	const [expanded, setExpanded] = useState(false);
	const detailItems =
		details ??
		items.map<PmSyncOutageDetailItem>((item) => ({
			id: item.id,
			itemType: item.itemType,
		}));

	return (
		<section
			aria-live="polite"
			aria-label="PM sync outage"
			className={cn(
				"rounded-md border border-destructive/30 bg-muted px-4 py-3 space-y-2",
				className,
			)}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex items-start gap-2">
					<CloudOffIcon
						className="size-4 mt-0.5 text-destructive shrink-0"
						aria-hidden="true"
					/>
					<div className="space-y-1">
						<p className="text-sm font-medium text-foreground">
							{pmToolName} unreachable — {count}{" "}
							{count === 1 ? "ticket" : "tickets"} affected
						</p>
						{errorClass && (
							<p className="text-xs text-muted-foreground">
								Error class: <code>{errorClass}</code>
							</p>
						)}
					</div>
				</div>
				<div className="flex items-center gap-2 shrink-0">
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => setExpanded((s) => !s)}
						aria-expanded={expanded}
						aria-controls="pm-outage-detail"
					>
						{expanded ? (
							<ChevronDownIcon
								className="size-3.5 mr-1"
								aria-hidden="true"
							/>
						) : (
							<ChevronRightIcon
								className="size-3.5 mr-1"
								aria-hidden="true"
							/>
						)}
						Details
					</Button>
					<Button
						type="button"
						size="sm"
						onClick={onRetryAll}
						disabled={isRetrying}
					>
						{isRetrying ? "Retrying…" : "Retry all"}
					</Button>
				</div>
			</div>

			{expanded && (
				<ul
					id="pm-outage-detail"
					className="mt-2 space-y-1 border-t border-border/60 pt-2"
				>
					{detailItems.map((item) => (
						<li
							key={`${item.itemType}:${item.id}`}
							className="flex items-center justify-between gap-2 text-xs"
						>
							<span className="text-muted-foreground truncate">
								{item.identifier ? (
									<span className="font-mono mr-1.5">
										{item.identifier}
									</span>
								) : null}
								{item.title ?? item.id}
							</span>
							{onOpenItem && (
								<button
									type="button"
									className="text-primary hover:underline transition-colors"
									onClick={() =>
										onOpenItem({
											id: item.id,
											itemType: item.itemType,
										})
									}
								>
									Open
								</button>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
