"use client";

import { Button } from "@ui/components/button";
import {
	EmptyState,
	EmptyStateAction,
	EmptyStateDescription,
	EmptyStateIcon,
	EmptyStateTitle,
} from "@ui/components/empty-state";
import { Skeleton } from "@ui/components/skeleton";
import type { ReactNode } from "react";
import type { FrameSummary } from "../lib/frame-tool-types";
import { FrameSummaryCard } from "./FrameSummaryCard";

/**
 * A list of agent-written pages as cards: a placeholder while it loads, an
 * error with a way to retry, an empty state that says how to get the first
 * page, and otherwise one card each. What the pages are called, where a card
 * leads and what the empty state offers come from the surface that shows them.
 */
export function FrameCollection({
	query,
	cardLabel,
	loadingLabel,
	errorMessage,
	empty,
	cardTarget,
	cardBadges,
	"data-onboarding-target": tourTarget,
}: {
	query: {
		isLoading: boolean;
		isError: boolean;
		data?: { frames: FrameSummary[] };
		refetch: () => unknown;
	};
	/** The editorial label on every card: where the pages live. */
	cardLabel: string;
	loadingLabel: string;
	errorMessage: string;
	empty: {
		icon: ReactNode;
		title: string;
		description: string;
		/** The one thing to do about it, shown under the description. */
		action?: ReactNode;
	};
	/** Where a card leads: a page of its own, or an action in the list. */
	cardTarget: (
		frame: FrameSummary,
	) => { href: string } | { onOpen: () => void };
	cardBadges?: (frame: FrameSummary) => ReactNode;
	/**
	 * The Get started anchor of the list of cards. Written on the element that
	 * uses this component, where the drift test reads it.
	 */
	"data-onboarding-target"?: string;
}) {
	const frames = query.data?.frames ?? [];

	if (query.isLoading) {
		return (
			<output
				className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
				aria-label={loadingLabel}
			>
				{[0, 1, 2].map((key) => (
					<Skeleton key={key} className="h-44 rounded-lg" />
				))}
			</output>
		);
	}
	if (query.isError) {
		return (
			<div
				role="alert"
				className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-5 text-sm"
			>
				<p className="text-destructive">{errorMessage}</p>
				<Button
					variant="outline"
					size="sm"
					onClick={() => query.refetch()}
				>
					Try again
				</Button>
			</div>
		);
	}
	if (frames.length === 0) {
		return (
			<EmptyState className="rounded-lg border border-dashed border-border py-16">
				<EmptyStateIcon>{empty.icon}</EmptyStateIcon>
				<EmptyStateTitle>{empty.title}</EmptyStateTitle>
				<EmptyStateDescription className="max-w-prose">
					{empty.description}
				</EmptyStateDescription>
				{empty.action ? (
					<EmptyStateAction>{empty.action}</EmptyStateAction>
				) : null}
			</EmptyState>
		);
	}
	return (
		<ul
			data-onboarding-target={tourTarget}
			className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
		>
			{frames.map((frame) => (
				<li key={frame.frameId}>
					<FrameSummaryCard
						label={cardLabel}
						title={frame.title}
						description={frame.description}
						updatedAt={frame.updatedAt}
						badges={cardBadges?.(frame)}
						{...cardTarget(frame)}
					/>
				</li>
			))}
		</ul>
	);
}
