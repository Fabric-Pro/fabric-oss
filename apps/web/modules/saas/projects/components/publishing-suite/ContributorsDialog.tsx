"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { cn } from "@ui/lib";
import { useEffect, useState } from "react";
import type { ProjectMember, TopicContributor } from "./topic-shared";

/**
 * ContributorsDialog — override-only editor for a topic's contributor set.
 * Save submits the checked set (possibly empty); Reset submits `null` (revert
 * to the AI-resolved set). The contributor row on the card stays display-only.
 *
 * Modeled directly on `PostTypesDialog` as it now stands: `fieldset` +
 * `legend`, one full-width `Label` row per option wrapping its `Checkbox`, a
 * live `aria-live` selected count, and "select all that apply" wording. That
 * component was reworked precisely because a column of bare checkboxes reads
 * as a radio group, and a contributor picker has the exact same shape — do
 * not reintroduce what it fixed.
 *
 * Two differences from `PostTypesDialog`: the options come from `members` at
 * runtime rather than a module constant, and each row shows the member's
 * avatar and name. The viewer's own row is additionally labelled "(You)" —
 * removing yourself from a topic has to be an obviously available action,
 * not merely a possible one a user has to infer from an unlabelled checkbox
 * matching their own name.
 *
 * `initialSelected` MUST be a value the caller keeps referentially stable
 * across re-renders that carry no real change (mirror `topic.userPostTypes ??
 * topic.suggestedPostTypes` in `PostTypesDialog`, e.g. via `useMemo`) — the
 * re-seed effect below fires on identity, not on a deep-equality check, so a
 * freshly `.map()`'d array on every parent render would silently discard
 * whatever the user had just checked.
 *
 * The AI contributor set is deliberately NOT membership-scoped
 * (`resolveProjectContributorIds` resolves story/document/PR authors via any
 * linked account — see its own doc comment), so a topic routinely names a
 * contributor who has left the project or was never a member. `contributors`
 * — the topic's full CURRENT effective set, with resolved display handles —
 * is passed in alongside `members` so each such person gets their OWN row:
 * checked, removable via the same checkbox, and visibly marked as no longer a
 * project member, instead of a bare id that silently drops off the moment
 * anyone saves the dialog. Save submits the UNION of checked member ids and
 * checked non-member contributor ids — never the intersection with `members`
 * alone, which is what silently dropped them before.
 *
 * `membersPending`/`membersError` gate Save and the non-member computation:
 * a members list that has not loaded, or failed to, cannot be trusted to
 * tell a current member from a stranger, so treating it as empty (`?? []`)
 * must not be able to produce an accidental empty override — see the two
 * mounts (`TopicRow`, `TopicItemPage`) for how those are threaded through
 * from their own `members.list` query.
 */
export function ContributorsDialog({
	topicTitle,
	open,
	onOpenChange,
	members,
	contributors,
	initialSelected,
	hasOverride,
	viewerUserId,
	onSubmit,
	isPending,
	membersPending,
	membersError,
}: {
	topicTitle: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	members: readonly ProjectMember[];
	/** The topic's full CURRENT effective contributor set (resolved display
	 *  handles) — used to render whoever among them is NOT a current project
	 *  member as their own row. */
	contributors: readonly TopicContributor[];
	initialSelected: readonly string[];
	hasOverride: boolean;
	viewerUserId: string | null;
	onSubmit: (contributorUserIds: string[] | null) => void;
	isPending?: boolean;
	/** True while the project's members list has not loaded yet. */
	membersPending: boolean;
	/** True when the members query failed. */
	membersError: boolean;
}) {
	const [selected, setSelected] = useState<Set<string>>(
		() => new Set(initialSelected),
	);

	// Re-seed to the topic's CURRENT effective set each time the dialog opens,
	// so a prior cancel can't leak stale checks into a reopen (mirrors
	// PostTypesDialog). This compares `initialSelected` by IDENTITY, which is
	// exactly why the caller owes it a stable reference — see the doc comment
	// above.
	useEffect(() => {
		if (open) {
			setSelected(new Set(initialSelected));
		}
	}, [open, initialSelected]);

	const toggle = (userId: string, checked: boolean) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (checked) {
				next.add(userId);
			} else {
				next.delete(userId);
			}
			return next;
		});
	};

	// Members data cannot be trusted while pending or errored (see the
	// module doc comment). Computing "not a project member" against an EMPTY
	// members list would mislabel every actual member as a stranger, so the
	// non-member section stays empty — rather than wrong — until the members
	// query has actually succeeded; Save is disabled for that same window
	// below, so nothing is lost by waiting.
	const membersReady = !membersPending && !membersError;
	const memberIds = new Set(members.map((m) => m.userId));
	const nonMemberContributors = membersReady
		? contributors.filter((c) => !memberIds.has(c.id))
		: [];

	const combinedRows: {
		id: string;
		name: string;
		image: string | null;
		isNonMember: boolean;
	}[] = [
		...members.map((m) => ({
			id: m.userId,
			name: m.user.name ?? m.user.email,
			image: m.user.image,
			isNonMember: false,
		})),
		...nonMemberContributors.map((c) => ({
			id: c.id,
			name: c.name,
			image: c.image,
			isNonMember: true,
		})),
	];
	// Postgres arrays carry no uniqueness constraint and the procedure's input
	// schema (`z.array(z.string()).max(50)`) doesn't dedupe either, so a
	// duplicate id can already exist in stored data. Two rows sharing one id
	// would share `id="contributor-<id>"` (a React key collision and a broken
	// `htmlFor` on the second row) and echo the duplicate back on Save.
	// Dedupe defensively; members are listed first, so a genuine member row
	// wins over a same-id non-member artifact.
	const seenRowIds = new Set<string>();
	const rows = combinedRows.filter((r) => {
		if (seenRowIds.has(r.id)) {
			return false;
		}
		seenRowIds.add(r.id);
		return true;
	});
	// Counts VISIBLE rows only, not `selected.size` — a selection can carry an
	// id with no rendered row (e.g. while the members query is loading), and
	// reporting that as part of the count would print something like "3 of 2
	// selected".
	const checkedCount = rows.filter((r) => selected.has(r.id)).length;
	const canSave = !isPending && membersReady;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Edit contributors</DialogTitle>
					<DialogDescription>
						Choose who contributed to "{topicTitle}" — select all
						that apply. This overrides the AI-detected contributors.
					</DialogDescription>
				</DialogHeader>
				<fieldset className="max-h-[50vh] space-y-2 overflow-y-auto">
					<legend className="sr-only">
						Contributors — select all that apply
					</legend>
					{rows.map((r) => {
						const isChecked = selected.has(r.id);
						const isViewer = r.id === viewerUserId;
						return (
							<Label
								key={r.id}
								htmlFor={`contributor-${r.id}`}
								className={cn(
									"flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
									isChecked
										? "border-primary/60 bg-primary/10"
										: "border-border bg-card",
									isPending
										? "cursor-not-allowed opacity-50"
										: "cursor-pointer hover:bg-accent",
								)}
							>
								<Checkbox
									id={`contributor-${r.id}`}
									checked={isChecked}
									onCheckedChange={(c) =>
										toggle(r.id, c === true)
									}
									disabled={isPending}
								/>
								{/* Decorative: the row's accessible name comes
								    from the <Label>'s text content, and
								    without this the fallback's initial letter
								    ("A") would be concatenated onto it
								    ("A Ada"), breaking any lookup by the
								    member's plain name. */}
								<Avatar aria-hidden="true" className="size-6">
									<AvatarImage
										src={r.image ?? undefined}
										alt=""
									/>
									<AvatarFallback className="text-[10px]">
										{r.name.charAt(0).toUpperCase()}
									</AvatarFallback>
								</Avatar>
								<span className="min-w-0 flex-1 truncate">
									{r.name}
									{isViewer ? (
										<span className="text-muted-foreground">
											{" "}
											(You)
										</span>
									) : null}
								</span>
								{r.isNonMember ? (
									// Muted token, not a hardcoded colour — this
									// is informational, not a warning: the id is
									// still allowed (the grandfather rule), just
									// no longer sourced from the roster.
									<Badge
										variant="outline"
										className="shrink-0 text-muted-foreground"
									>
										Not a project member
									</Badge>
								) : null}
							</Label>
						);
					})}
					{membersPending ? (
						<p
							aria-live="polite"
							className="pt-1 text-muted-foreground text-xs"
						>
							Loading project members…
						</p>
					) : null}
					{membersError ? (
						<p
							role="alert"
							className="pt-1 text-destructive text-xs"
						>
							We couldn't load this project's members. Close and
							reopen this dialog to try again.
						</p>
					) : null}
					{/* A radio group cannot report a count — saying one out loud
					    is the plainest statement that more than one is
					    allowed, and `aria-live` carries it to screen readers
					    too (mirrors PostTypesDialog). Suppressed while members
					    data isn't trustworthy — see `membersReady` above. */}
					{membersReady ? (
						<p
							aria-live="polite"
							className="pt-1 text-muted-foreground text-xs"
							data-testid="contributors-selected-count"
						>
							{checkedCount === 0
								? "None selected"
								: `${checkedCount} of ${rows.length} selected`}
						</p>
					) : null}
				</fieldset>
				<DialogFooter>
					<Button
						variant="ghost"
						onClick={() => onOpenChange(false)}
						disabled={isPending}
					>
						Cancel
					</Button>
					{hasOverride ? (
						<Button
							variant="outline"
							onClick={() => onSubmit(null)}
							disabled={isPending}
						>
							Reset to AI suggestion
						</Button>
					) : null}
					<Button
						onClick={() =>
							onSubmit(
								rows
									.filter((r) => selected.has(r.id))
									.map((r) => r.id),
							)
						}
						disabled={!canSave}
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
