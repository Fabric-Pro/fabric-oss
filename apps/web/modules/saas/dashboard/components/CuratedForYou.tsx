"use client";

import type {
	CuratedCard,
	CuratedCardKind,
	CuratedFeedbackAction,
} from "../lib/curated-model";
import { Button } from "@ui/components/button";
import { Card, CardContent } from "@ui/components/card";
import {
	AlertCircleIcon,
	ArrowUpRightIcon,
	DatabaseIcon,
	FolderOpenIcon,
	PinIcon,
	PlusCircleIcon,
	SparklesIcon,
	WorkflowIcon,
	XIcon,
	type LucideIcon,
} from "lucide-react";
import Link from "next/link";

const ICONS: Record<CuratedCardKind, LucideIcon> = {
	review: AlertCircleIcon,
	project: FolderOpenIcon,
	context: DatabaseIcon,
	create: PlusCircleIcon,
	ask: SparklesIcon,
	automate: WorkflowIcon,
};

interface CuratedForYouProps {
	cards: CuratedCard[];
	onFeedback: (cardKey: string, action: CuratedFeedbackAction) => void;
}

export function CuratedForYou({ cards, onFeedback }: CuratedForYouProps) {
	if (cards.length === 0) {
		return null;
	}
	return (
		<section aria-labelledby="curated-for-you-title" className="space-y-3">
			<div>
				<h2
					id="curated-for-you-title"
					className="text-base font-semibold"
				>
					Curated for you
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					Useful next steps based on your current work.
				</p>
			</div>
			<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
				{cards.map((card) => {
					const Icon = ICONS[card.kind];
					return (
						<Card
							key={card.key}
							className="h-full transition-colors hover:border-primary/40"
						>
							<CardContent className="flex h-full flex-col gap-3 p-5">
								<div className="flex items-start justify-between gap-3">
									<span className="rounded-md bg-primary/10 p-2 text-primary-ink">
										<Icon className="size-4" aria-hidden />
									</span>
									<div className="flex items-center gap-1">
										<Button
											variant="ghost"
											size="icon-sm"
											className="size-7"
											aria-label={`${card.pinned ? "Unpin" : "Pin"} ${card.title}`}
											title={
												card.pinned ? "Unpin" : "Pin"
											}
											onClick={() =>
												onFeedback(
													card.key,
													card.pinned
														? "unpin"
														: "pin",
												)
											}
										>
											<PinIcon
												className={`size-3.5 ${card.pinned ? "fill-current text-primary" : "text-muted-foreground"}`}
												aria-hidden
											/>
										</Button>
										<Button
											variant="ghost"
											size="icon-sm"
											className="size-7"
											aria-label={`Dismiss ${card.title}`}
											title="Dismiss"
											onClick={() =>
												onFeedback(card.key, "dismiss")
											}
										>
											<XIcon
												className="size-3.5 text-muted-foreground"
												aria-hidden
											/>
										</Button>
									</div>
								</div>
								<Link
									href={card.href}
									aria-label={`${card.actionLabel}: ${card.title}`}
									onClick={() =>
										onFeedback(card.key, "click")
									}
									className="group flex flex-1 flex-col gap-3 rounded-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
								>
									<div className="space-y-1">
										<p className="text-sm font-medium">
											{card.title}
										</p>
										<p className="text-xs text-muted-foreground">
											{card.description}
										</p>
									</div>
									<span className="mt-auto flex items-center justify-between gap-2 text-xs font-medium text-primary-ink">
										{card.actionLabel}
										<ArrowUpRightIcon
											className="size-4 text-muted-foreground transition-colors group-hover:text-primary-ink"
											aria-hidden
										/>
									</span>
								</Link>
							</CardContent>
						</Card>
					);
				})}
			</div>
		</section>
	);
}
