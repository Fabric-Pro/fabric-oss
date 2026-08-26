"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { useMemo, useState } from "react";

type PickableStory = {
	id: string;
	identifier: string | null;
	title: string;
};

/**
 * Pick a work item to link an action item to (#1902 FR4/AC7).
 *
 * The card treats this as non-negotiable ("All-or-nothing acceptance is not
 * acceptable") — auto-matching is a suggestion engine, so the user must be able
 * to supply the match it missed, not just delete the ones it got wrong.
 *
 * The backlog is fetched lazily on open (never on digest render) and filtered
 * client-side: a project's active backlog is a few hundred items at most, and
 * the existing `projects.stories.list` already serves exactly this shape for the
 * roadmap, so this needs no new endpoint.
 *
 * Work items already linked to this action item are excluded rather than shown
 * disabled — re-picking one would be a no-op upsert, and a list that offers
 * choices that do nothing is worse than a shorter list.
 */
export function LinkStoryPicker({
	open,
	onOpenChange,
	projectId,
	organizationId,
	actionItemText,
	excludeStoryIds,
	onPick,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	organizationId: string | null;
	actionItemText: string;
	excludeStoryIds: string[];
	onPick: (storyId: string) => Promise<void>;
}) {
	const [search, setSearch] = useState("");
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const storiesQuery = useQuery({
		queryKey: ["projects.stories.list", projectId, organizationId],
		queryFn: () =>
			orpcClient.projects.stories.list({ projectId, organizationId }),
		// Only pay for the backlog when the user actually opens the picker.
		enabled: open,
	});

	const excluded = useMemo(() => new Set(excludeStoryIds), [excludeStoryIds]);

	const matches = useMemo(() => {
		const all = (storiesQuery.data?.stories ?? []) as PickableStory[];
		const term = search.trim().toLowerCase();
		return all
			.filter((s) => !excluded.has(s.id))
			.filter((s) =>
				term.length === 0
					? true
					: `${s.identifier ?? ""} ${s.title}`
							.toLowerCase()
							.includes(term),
			)
			.slice(0, 50);
	}, [storiesQuery.data, search, excluded]);

	const pick = async (storyId: string) => {
		setPendingId(storyId);
		setError(null);
		try {
			await onPick(storyId);
			setSearch("");
			onOpenChange(false);
		} catch {
			setError("Could not add that link — try again.");
		} finally {
			setPendingId(null);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogTitle>Link a work item</DialogTitle>
				<DialogDescription className="line-clamp-2">
					{actionItemText}
				</DialogDescription>

				<Input
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search features and bugs…"
					aria-label="Search work items"
				/>

				{error ? (
					<p role="status" className="text-xs text-destructive">
						{error}
					</p>
				) : null}

				<div className="max-h-72 min-h-0 overflow-y-auto">
					{storiesQuery.isLoading ? (
						<p className="p-2 text-muted-foreground text-sm">
							Loading work items…
						</p>
					) : storiesQuery.isError ? (
						<p className="p-2 text-destructive text-sm">
							Could not load work items.
						</p>
					) : matches.length === 0 ? (
						<p className="p-2 text-muted-foreground text-sm">
							{search.trim()
								? "No work items match that search."
								: "No work items available to link."}
						</p>
					) : (
						<ul className="space-y-1">
							{matches.map((story) => (
								<li key={story.id}>
									<Button
										type="button"
										variant="ghost"
										className="h-auto w-full justify-start px-2 py-1.5 text-left"
										disabled={pendingId !== null}
										onClick={() => pick(story.id)}
									>
										<span className="font-mono text-xs">
											{story.identifier ?? "—"}
										</span>
										<span className="min-w-0 truncate">
											{story.title}
										</span>
									</Button>
								</li>
							))}
						</ul>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
