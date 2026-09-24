"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { cn } from "@ui/lib";
import { type ReactNode, useEffect, useState } from "react";
import type { ProjectMember, TopicAssignee } from "./topic-shared";

/**
 * AssigneesPicker — who should pick this topic up (A8).
 *
 * A POPOVER, like its `ContributorsPicker` sibling and for the same reason.
 * The two sit next to each other, so one of them staying a modal would have
 * made a pair of adjacent controls behave differently for no reason a reader
 * could see.
 *
 * Assignment here is a NUDGE, not access control: everyone in the project can
 * already see and edit every topic, and adding someone changes none of that.
 * The copy has to keep saying so, or the first reader assumes it is a
 * permission and the second assumes it is a queue.
 *
 * Structurally `ContributorsPicker`'s sibling — `fieldset` + `legend`, one
 * full-width `Label` per row wrapping its `Checkbox`, avatar, "(You)" on the
 * viewer's own row, an `aria-live` count. Three deliberate divergences:
 *
 * 1. NO "Reset to AI suggestion". Nothing AI-resolves assignees, so there is no
 *    suggestion to revert to; `[]` is the only way to clear the list and it
 *    means exactly "nobody".
 *
 * 2. THE COUNT IS `selected.size`, with no "of N" denominator.
 *    `ContributorsPicker` counts VISIBLE ROWS instead, and that is a real
 *    defect, not a style choice — a selection can carry an id with no rendered
 *    row (a member list that has not loaded, or an assignee who has since left
 *    the project), and counting rows then reports "None selected" while three
 *    people are selected. The PO hit exactly that and reported the dialog as
 *    broken. Counting the selection itself is honest in every one of those
 *    states, and dropping the denominator is what makes it safe to do: it is
 *    the "N of M" framing that turns an unrendered selection into the absurd
 *    "3 of 2 selected" the row count was reaching for. Do not "fix" this back.
 *
 * 3. NON-MEMBERS CANNOT BE SAVED. The server takes every id as a current
 *    project member with NO grandfathering (see `update-topic-assignees.ts` for
 *    why that is right rather than merely strict), so a selected non-member is
 *    a person who left the project. They still get a row — checked, labelled,
 *    uncheckable — because silently dropping someone on Save is how the
 *    contributor picker used to lose people. Save is blocked while one is
 *    checked, with an inline explanation, so the strict server rule reaches the
 *    user as an instruction rather than as a raw 400 toast.
 *
 * `initialSelected` MUST be referentially stable across re-renders that carry
 * no real change (see the `useMemo` at both mounts) — the re-seed effect below
 * fires on IDENTITY, so a freshly `.map()`'d array every render would discard
 * whatever the user had just checked.
 */
export function AssigneesPicker({
	topicTitle,
	open,
	onOpenChange,
	members,
	assignees,
	initialSelected,
	viewerUserId,
	onSubmit,
	isPending,
	membersPending,
	membersError,
	trigger,
}: {
	topicTitle: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	members: readonly ProjectMember[];
	/** The topic's CURRENT assignees with resolved display handles — the only
	 *  place a name and avatar exist for someone who is no longer a member. */
	assignees: readonly TopicAssignee[];
	/** The topic's RAW stored assignee ids, not the resolved subset: seeding
	 *  from the handles would silently drop anyone the handle lookup could not
	 *  resolve, and Save would then remove them without anyone choosing to. */
	initialSelected: readonly string[];
	viewerUserId: string | null;
	onSubmit: (assigneeUserIds: string[]) => void;
	isPending?: boolean;
	/** True while the project's members list has not loaded yet. */
	membersPending: boolean;
	/** True when the members query failed. */
	membersError: boolean;
	/**
	 * Fizzy #2646: what opens the picker. Omitted → the "Assign people" /
	 * "Edit assignees" button. The collapsed Inbox row passes its avatar
	 * cluster so the people on a topic are the control that changes them.
	 * Must be ONE element that forwards props and ref (`PopoverTrigger
	 * asChild` merges onto it) and must not set `disabled` itself — the
	 * picker disables it while the write is pending, and a child's own
	 * `disabled` would win over that.
	 */
	trigger?: ReactNode;
}) {
	const [selected, setSelected] = useState<Set<string>>(
		() => new Set(initialSelected),
	);

	// Re-seed to the topic's current list each time the dialog opens, so a
	// prior cancel cannot leak stale checks into a reopen. Compares
	// `initialSelected` by IDENTITY — see the doc comment above.
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

	// Members data cannot be trusted while pending or errored: computing "not a
	// project member" against an empty list would mislabel every actual member
	// as a stranger and block Save on all of them. Until the query succeeds the
	// non-member section stays empty rather than wrong — and Save is disabled
	// for that same window anyway, so nothing is lost by waiting.
	const membersReady = !membersPending && !membersError;
	const memberIds = new Set(members.map((m) => m.userId));
	const selectedNonMembers = membersReady
		? [...selected].filter((id) => !memberIds.has(id))
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
		// One row per selected id that is no longer a member. The handle comes
		// from the topic's own resolved `assignees`; an id with no handle left
		// at all (deleted account) still gets a row, because the alternative is
		// a checked-but-invisible id blocking Save with nothing to point at.
		...selectedNonMembers.map((id) => {
			const handle = assignees.find((a) => a.id === id);
			return {
				id,
				name: handle?.name ?? "Former member",
				image: handle?.image ?? null,
				isNonMember: true,
			};
		}),
	];
	// Postgres arrays carry no uniqueness constraint and the procedure's input
	// schema does not dedupe either, so a duplicate id can already exist in
	// stored data. Two rows sharing an id would collide on `id="assignee-<id>"`
	// (a React key clash and a broken `htmlFor` on the second). Members are
	// listed first, so a genuine member row wins.
	const seenRowIds = new Set<string>();
	const rows = combinedRows.filter((r) => {
		if (seenRowIds.has(r.id)) {
			return false;
		}
		seenRowIds.add(r.id);
		return true;
	});

	const blockedByNonMember = selectedNonMembers.length > 0;
	const canSave = !isPending && membersReady && !blockedByNonMember;
	// Same wording the row's button carried before the picker owned its own
	// trigger: "Assign people" reads as an invitation on a topic nobody has
	// picked up, "Edit assignees" as a correction once somebody has.
	const assignedLabel =
		assignees.length > 0 ? "Edit assignees" : "Assign people";

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			{/* The gate lives on the trigger SLOT, so it reaches whichever
			    element opens the picker — a custom trigger cannot drop it. */}
			<PopoverTrigger asChild disabled={isPending}>
				{trigger ?? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={isPending}
					>
						{assignedLabel}
					</Button>
				)}
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-[min(24rem,calc(100vw-2rem))] space-y-3 p-3"
			>
				<div className="space-y-1">
					<p className="publishing-label">Assignees</p>
					<p className="text-muted-foreground text-xs leading-relaxed">
						Who should pick up "{topicTitle}". Everyone on the
						project can still see and edit this topic; assigning is
						a heads-up, not a permission.
					</p>
				</div>
				<fieldset className="max-h-[50vh] space-y-2 overflow-y-auto">
					<legend className="sr-only">
						Assignees — select all that apply
					</legend>
					{rows.map((r) => {
						const isChecked = selected.has(r.id);
						const isViewer = r.id === viewerUserId;
						return (
							<Label
								key={r.id}
								htmlFor={`assignee-${r.id}`}
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
									id={`assignee-${r.id}`}
									checked={isChecked}
									onCheckedChange={(c) =>
										toggle(r.id, c === true)
									}
									disabled={isPending}
								/>
								{/* Decorative: the row's accessible name comes
								    from the <Label>'s text, and without this
								    the fallback's initial ("A") would be
								    concatenated onto it ("A Ada"), breaking
								    any lookup by the member's plain name. */}
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
									// Destructive token, unlike the contributor
									// picker's muted one: there the badge is
									// informational (the id stays allowed),
									// here it is the reason Save is blocked.
									<Badge
										variant="outline"
										className="shrink-0 text-destructive"
									>
										No longer a project member
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
					{blockedByNonMember ? (
						<p
							role="alert"
							className="pt-1 text-destructive text-xs"
						>
							Uncheck anyone marked "No longer a project member" —
							they can't be assigned until they rejoin the
							project.
						</p>
					) : null}
					{/* Counts the SELECTION, not the rendered rows, and carries
					    no "of N" denominator — see divergence 2 in the module
					    doc comment. `aria-live` so a screen reader hears the
					    count change, and so the plural is stated out loud at
					    all: a column of checkboxes otherwise reads as a radio
					    group. Rendered in every state, including while members
					    load, because a count of the selection is trustworthy
					    even when the roster is not. */}
					<p
						aria-live="polite"
						className="pt-1 text-muted-foreground text-xs"
						data-testid="assignees-selected-count"
					>
						{selected.size === 0
							? "None selected"
							: `${selected.size} selected`}
					</p>
				</fieldset>
				<div className="flex flex-wrap items-center justify-end gap-2">
					<Button
						variant="ghost"
						onClick={() => onOpenChange(false)}
						disabled={isPending}
					>
						Cancel
					</Button>
					<Button
						onClick={() => onSubmit([...selected])}
						disabled={!canSave}
					>
						Save
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
