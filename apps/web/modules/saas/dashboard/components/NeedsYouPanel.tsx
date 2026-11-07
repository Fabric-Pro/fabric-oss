"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { formatDistanceToNow } from "date-fns";
import {
	ArrowRightIcon,
	ArrowUpRightIcon,
	CheckCircle2Icon,
	PinIcon,
	XIcon,
} from "lucide-react";
import Link from "next/link";
import type { CuratedCard, CuratedFeedbackAction } from "../lib/curated-model";
import type { HomeActionItem } from "../lib/home-model";

interface NeedsYouPanelProps {
	items: HomeActionItem[];
	total: number;
	hasMore: boolean;
	loading: boolean;
	basePath: string;
	suggestions: CuratedCard[];
	onFeedback: (cardKey: string, action: CuratedFeedbackAction) => void;
}

export function NeedsYouPanel({
	items,
	total,
	hasMore,
	loading,
	basePath,
	suggestions,
	onFeedback,
}: NeedsYouPanelProps) {
	return (
		<Card className="flex h-96 flex-col">
			<CardHeader className="flex flex-row items-center justify-between gap-3 px-5 pb-3 pt-4">
				<CardTitle className="text-base">
					Needs you
					{total > 0 ? ` (${total}${hasMore ? "+" : ""})` : ""}
				</CardTitle>
				<Link
					href={`${basePath}/notifications`}
					className="text-xs font-medium text-primary-ink hover:underline"
				>
					View inbox
				</Link>
			</CardHeader>
			<CardContent className="flex min-h-0 flex-1 flex-col p-0">
				<div className="min-h-0 flex-1 overflow-y-auto">
					{loading ? (
						<div className="space-y-4 px-5 pb-5">
							{Array.from({ length: 4 }, (_, index) => (
								<div
									key={index}
									className="flex items-center gap-3"
								>
									<Skeleton className="h-5 w-14" />
									<div className="flex-1 space-y-2">
										<Skeleton className="h-4 w-3/4" />
										<Skeleton className="h-3 w-1/2" />
									</div>
								</div>
							))}
						</div>
					) : items.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center gap-2 px-5 py-6 text-center">
							<CheckCircle2Icon
								className="size-7 text-success"
								aria-hidden
							/>
							<p className="text-sm font-medium">
								Nothing needs you right now
							</p>
							<p className="text-xs text-muted-foreground">
								Continue a recent project or pick up assigned
								work below.
							</p>
						</div>
					) : (
						<div className="divide-y divide-border">
							{items.map((item) => (
								<Link
									key={item.id}
									href={item.href}
									className="group flex items-start gap-3 px-5 py-3 transition-colors duration-150 hover:bg-muted/50 focus-visible:outline-hidden focus-visible:bg-muted/50"
								>
									<Badge
										variant={
											item.blocked
												? "destructive"
												: "secondary"
										}
										className="mt-0.5 shrink-0"
									>
										{item.actionLabel}
									</Badge>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sm font-medium group-hover:text-primary-ink">
											{item.title}
										</span>
										<span className="mt-0.5 block truncate text-xs text-muted-foreground">
											{item.reason}
										</span>
										<span className="mt-1 block truncate text-xs text-muted-foreground">
											{item.projectName
												? `${item.projectName} · `
												: ""}
											{formatDistanceToNow(
												item.updatedAt,
												{
													addSuffix: true,
												},
											)}
										</span>
									</span>
									<span className="flex shrink-0 items-center gap-1 pt-1 text-xs font-medium text-primary-ink">
										{item.actionLabel}
										<ArrowRightIcon
											className="size-3.5"
											aria-hidden
										/>
									</span>
								</Link>
							))}
						</div>
					)}
				</div>
				{!loading && suggestions.length > 0 ? (
					<div className="shrink-0 border-t border-border bg-muted/20 px-5 py-4">
						<p className="text-xs font-semibold">Up next</p>
						<div className="mt-2 grid gap-2 sm:grid-cols-2">
							{suggestions.map((suggestion) => (
								<div
									key={suggestion.key}
									className="rounded-md border border-border bg-background p-3 transition-colors duration-150 hover:border-primary/40"
								>
									<div className="flex items-start gap-2">
										<Link
											href={suggestion.href}
											aria-label={`${suggestion.actionLabel}: ${suggestion.title}`}
											onClick={() =>
												onFeedback(
													suggestion.key,
													"click",
												)
											}
											className="group min-w-0 flex-1 rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
										>
											<span className="flex items-start justify-between gap-2 text-xs font-medium">
												{suggestion.title}
												<ArrowUpRightIcon
													className="size-3.5 shrink-0 text-muted-foreground group-hover:text-primary-ink"
													aria-hidden
												/>
											</span>
											<span className="mt-1 block text-xs text-primary-ink">
												{suggestion.actionLabel}
											</span>
										</Link>
										<div className="flex shrink-0 gap-0.5">
											<Button
												variant="ghost"
												size="icon-sm"
												className="size-6"
												aria-label={`${suggestion.pinned ? "Unpin" : "Pin"} ${suggestion.title}`}
												title={
													suggestion.pinned
														? "Unpin"
														: "Pin"
												}
												onClick={() =>
													onFeedback(
														suggestion.key,
														suggestion.pinned
															? "unpin"
															: "pin",
													)
												}
											>
												<PinIcon
													className={`size-3 ${suggestion.pinned ? "fill-current text-primary" : "text-muted-foreground"}`}
													aria-hidden
												/>
											</Button>
											<Button
												variant="ghost"
												size="icon-sm"
												className="size-6"
												aria-label={`Dismiss ${suggestion.title}`}
												title="Dismiss"
												onClick={() =>
													onFeedback(
														suggestion.key,
														"dismiss",
													)
												}
											>
												<XIcon
													className="size-3 text-muted-foreground"
													aria-hidden
												/>
											</Button>
										</div>
									</div>
								</div>
							))}
						</div>
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}
