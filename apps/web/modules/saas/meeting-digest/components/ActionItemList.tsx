"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { Checkbox } from "@ui/components/checkbox";
import { useEffect, useState } from "react";
import type { ActionItemLinkView } from "../lib/types";
import { ActionItemLinks } from "./ActionItemLinks";
import { LinkStoryPicker } from "./LinkStoryPicker";

export interface ActionItemView {
	id: string | null;
	text: string;
	tentativeOwnerName: string | null;
	dueHint: string | null;
	completedAt: Date | string | null;
	anchorLine?: number | null;
	/** #1902: durable key this item's links hang off. Absent on legacy Json items. */
	itemKey?: string | null;
}

/**
 * Checkbox list for meeting action items (#1814, FR5). Optimistic: the box
 * flips immediately and rolls back on error. Legacy Json items (id === null,
 * pre-backfill) render as plain bullets — they become checkable after the
 * next extraction writes rows. Shared between MeetingDetailSheet's Actions
 * tab (Task 12) and AgendaView (Task 13).
 */
export function ActionItemList({
	projectId,
	organizationId,
	items,
	onToggled,
	onJump,
	linksByItemKey,
	onLinksChanged,
	highlightItemKey,
}: {
	projectId: string;
	organizationId: string | null;
	items: ActionItemView[];
	onToggled: () => void;
	onJump?: (anchorLine: number) => void;
	/**
	 * #1902. Omitted by callers that do not show links (AgendaView), which is
	 * why link rendering is opt-in rather than driven off the items themselves.
	 */
	linksByItemKey?: Record<string, ActionItemLinkView[]>;
	onLinksChanged?: () => void;
	/** #1902 AC5: item to highlight when arrived at via a back-reference. */
	highlightItemKey?: string | null;
}) {
	// Optimistic overrides keyed by action-item id: absent = trust
	// item.completedAt, present = the box's optimistic state pending (or past)
	// the server round-trip. Rolled back to the pre-toggle value on rejection.
	const [overrides, setOverrides] = useState<Record<string, boolean>>({});
	const [proposeMsg, setProposeMsg] = useState<Record<string, string>>({});
	// In-flight guard: the backend dedupe (proposeActionItem) is a
	// findFirst-then-create, not atomic, so a fast double-click can still race
	// past it and create two proposals. Disabling the button while its id is
	// in this set closes that window client-side.
	const [proposing, setProposing] = useState<Set<string>>(new Set());
	// #1902: link ids with a remove request in flight, so a double-click cannot
	// fire two dismissals for the same link.
	const [removingLinkIds, setRemovingLinkIds] = useState<Set<string>>(
		new Set(),
	);
	const [linkError, setLinkError] = useState<string | null>(null);
	// #1902 FR4: the action item currently having a work item picked for it.
	// Null = picker closed. Held here (not per-row) so only one dialog mounts.
	const [pickerItem, setPickerItem] = useState<{
		id: string;
		text: string;
		itemKey: string;
	} | null>(null);
	// Reset only when the id SET changes (re-extraction replaces ids) — not on
	// array identity: background refetches/invalidations hand back fresh array
	// refs for identical data and must not erase a just-shown confirmation.
	const itemIdsKey = items.map((i) => i.id ?? "legacy").join("|");
	useEffect(() => {
		setProposeMsg({});
	}, [itemIdsKey]);

	if (items.length === 0) {
		return <p className="text-muted-foreground">None</p>;
	}

	const toggle = async (id: string, next: boolean) => {
		setOverrides((o) => ({ ...o, [id]: next }));
		try {
			await orpcClient.projects.meetingDigest.setActionItemCompleted({
				projectId,
				organizationId,
				actionItemId: id,
				completed: next,
			});
			onToggled();
		} catch {
			setOverrides((o) => ({ ...o, [id]: !next }));
		}
	};

	const propose = async (id: string) => {
		setProposing((s) => new Set(s).add(id));
		try {
			const res =
				await orpcClient.projects.meetingDigest.proposeActionItem({
					projectId,
					organizationId,
					actionItemId: id,
				});
			setProposeMsg((m) => ({
				...m,
				[id]:
					res.status === "proposed"
						? "Proposed — approve it in the Proposal Inbox."
						: "Already proposed — see the Proposal Inbox.",
			}));
		} catch {
			setProposeMsg((m) => ({
				...m,
				[id]: "Could not propose — try again.",
			}));
		} finally {
			setProposing((s) => {
				const next = new Set(s);
				next.delete(id);
				return next;
			});
		}
	};

	const removeLink = async (linkId: string) => {
		setRemovingLinkIds((s) => new Set(s).add(linkId));
		setLinkError(null);
		try {
			await orpcClient.projects.meetingDigest.removeActionItemLink({
				projectId,
				organizationId,
				linkId,
			});
			onLinksChanged?.();
		} catch {
			// The chip stays put on failure (nothing was removed), so without a
			// message the click would read as a no-op and the user would keep
			// clicking. Silent failure is not an option here.
			setLinkError("Could not remove that link — try again.");
		} finally {
			setRemovingLinkIds((s) => {
				const next = new Set(s);
				next.delete(linkId);
				return next;
			});
		}
	};

	const addLink = async (actionItemId: string, storyId: string) => {
		await orpcClient.projects.meetingDigest.addActionItemLink({
			projectId,
			organizationId,
			actionItemId,
			storyId,
		});
		onLinksChanged?.();
	};

	return (
		<>
			{linkError ? (
				<p role="status" className="mb-1 text-xs text-destructive">
					{linkError}
				</p>
			) : null}
			<ul className="space-y-1 text-muted-foreground">
				{items.map((item, i) => {
					const meta = [
						item.tentativeOwnerName,
						item.dueHint ? `due ${item.dueHint}` : null,
					]
						.filter(Boolean)
						.join(" · ");
					if (!item.id) {
						return (
							<li key={i} className="list-disc ml-5">
								{item.text}
								{meta ? ` — ${meta}` : ""}
								{onJump &&
									typeof item.anchorLine === "number" && (
										<button
											type="button"
											onClick={() =>
												onJump(
													item.anchorLine as number,
												)
											}
											aria-label={`Jump to transcript for: ${item.text}`}
											className="ml-2 text-xs text-primary underline hover:no-underline"
										>
											Jump to transcript
										</button>
									)}
							</li>
						);
					}
					const id = item.id;
					const checked = overrides[id] ?? Boolean(item.completedAt);
					const itemLinks = item.itemKey
						? (linksByItemKey?.[item.itemKey] ?? [])
						: [];
					const highlighted =
						Boolean(highlightItemKey) &&
						item.itemKey === highlightItemKey;
					return (
						<li
							key={id}
							id={
								item.itemKey
									? `action-item-${item.itemKey}`
									: undefined
							}
							className={`flex items-start gap-2 ${
								highlighted
									? "-mx-2 rounded-md px-2 py-1 ring-2 ring-primary"
									: ""
							}`}
						>
							<Checkbox
								className="mt-1"
								checked={checked}
								aria-label={`Mark "${item.text}" ${
									checked ? "incomplete" : "complete"
								}`}
								onCheckedChange={() => toggle(id, !checked)}
							/>
							<span>
								<span className={checked ? "line-through" : ""}>
									{item.text}
									{meta ? (
										<span className="text-xs">
											{" "}
											— {meta}
										</span>
									) : null}
								</span>
								<span className="ml-2 inline-flex items-center gap-2">
									<button
										type="button"
										className="text-xs underline text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
										disabled={proposing.has(id)}
										onClick={() => propose(id)}
									>
										{proposing.has(id)
											? "Proposing…"
											: "Create ticket"}
									</button>
									{onJump &&
										typeof item.anchorLine === "number" && (
											<button
												type="button"
												onClick={() =>
													onJump(
														item.anchorLine as number,
													)
												}
												aria-label={`Jump to transcript for: ${item.text}`}
												className="text-xs text-primary underline hover:no-underline"
											>
												Jump to transcript
											</button>
										)}
									{linksByItemKey && item.itemKey ? (
										<button
											type="button"
											className="text-muted-foreground text-xs underline hover:text-foreground"
											onClick={() =>
												setPickerItem({
													id,
													text: item.text,
													itemKey:
														item.itemKey as string,
												})
											}
										>
											Link work item
										</button>
									) : null}
									{proposeMsg[id] ? (
										<span className="text-xs text-muted-foreground">
											{proposeMsg[id]}
										</span>
									) : null}
								</span>
								{linksByItemKey ? (
									<ActionItemLinks
										projectId={projectId}
										links={itemLinks}
										onRemove={removeLink}
										removingLinkIds={removingLinkIds}
									/>
								) : null}
							</span>
						</li>
					);
				})}
			</ul>
			{pickerItem ? (
				<LinkStoryPicker
					open
					onOpenChange={(next) => {
						if (!next) {
							setPickerItem(null);
						}
					}}
					projectId={projectId}
					organizationId={organizationId}
					actionItemText={pickerItem.text}
					excludeStoryIds={(
						linksByItemKey?.[pickerItem.itemKey] ?? []
					).map((l) => l.storyId)}
					onPick={(storyId) => addLink(pickerItem.id, storyId)}
				/>
			) : null}
		</>
	);
}
