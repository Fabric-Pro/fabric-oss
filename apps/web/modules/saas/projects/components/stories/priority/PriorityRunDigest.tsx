"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { CheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";
import type { StoryPriority } from "../../../lib/stories/types";
import { PriorityBand } from "./PriorityBand";

/** One band move from a re-prioritization run, as the procedure returns it. */
export type PriorityRunChange = {
	storyId: string;
	fromPriority: StoryPriority;
	toPriority: StoryPriority;
	rationale: string | null;
};

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	changes: PriorityRunChange[];
	considered: number;
	truncated: boolean;
	/** True when a hand-pinned order is active, so the digest can say why the
	 * list did not visibly re-rank. */
	pinned: boolean;
	/** identifier/title lookup for the changed rows. */
	storyMeta: ReadonlyMap<string, { identifier: string; title: string }>;
	projectId: string;
	organizationId: string | null;
	/** Parent's cache invalidation — a revert is a priority write like any other. */
	onReverted: () => void;
};

/**
 * What a re-prioritization run actually did — shown right after it finishes.
 *
 * The toast used to be the only feedback: "Changed 5 priorities out of 40",
 * with the which/why discoverable only by scanning chips or expanding rows
 * one at a time. A one-click AI mutation over up to 500 items needs a
 * review-and-recover surface: this lists every move with its rationale, and
 * each row can be reverted on the spot. A revert goes through the same
 * `setPriority` path as any manual change, so it lands in the item's history
 * with a comment — the trail shows the AI move AND the human overrule.
 */
export function PriorityRunDigest({
	open,
	onOpenChange,
	changes,
	considered,
	truncated,
	pinned,
	storyMeta,
	projectId,
	organizationId,
	onReverted,
}: Props) {
	const t = useTranslations("projects.stories.priority");
	const [revertedIds, setRevertedIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	/** Spoken confirmation for the live region — the button a revert replaces
	 * disappears silently otherwise. */
	const [announcement, setAnnouncement] = useState("");
	const doneRef = useRef<HTMLButtonElement>(null);
	/** The row whose "Reverted" state should receive focus when it mounts —
	 * the focused Revert button unmounts on success, and without this the
	 * keyboard user is thrown back to the dialog container, losing their
	 * position in the list. */
	const focusRevertedIdRef = useRef<string | null>(null);

	const revertMutation = useMutation({
		mutationFn: (change: PriorityRunChange) =>
			orpcClient.projects.stories.setPriority({
				projectId,
				organizationId,
				storyId: change.storyId,
				priority: change.fromPriority,
				comment: t("digestRevertComment"),
			}),
		onSuccess: (_result, change) => {
			focusRevertedIdRef.current = change.storyId;
			setRevertedIds((prev) => new Set(prev).add(change.storyId));
			setAnnouncement(
				`${t("digestReverted")}: ${storyMeta.get(change.storyId)?.identifier ?? change.storyId}`,
			);
			onReverted();
		},
		onError: (error) => {
			toast.error(t("digestRevertFailed"), {
				description: (error as Error).message,
			});
		},
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
				// The first tabbable is a Revert button — a mutating action.
				// The dialog opens UNPROMPTED when the async run finishes, so a
				// keystroke in flight must not land on it; start on Done.
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					doneRef.current?.focus();
				}}
			>
				<DialogHeader>
					<DialogTitle>{t("digestTitle")}</DialogTitle>
					<DialogDescription>
						{t("digestDescription", {
							changed: changes.length,
							considered,
						})}
					</DialogDescription>
				</DialogHeader>

				{truncated && (
					<p className="text-muted-foreground text-xs">
						{t("reprioritizeTruncated")}
					</p>
				)}
				{pinned && (
					<p className="text-muted-foreground text-xs">
						{t("reprioritizePinnedNote")}
					</p>
				)}

				<ul className="space-y-3">
					{changes.map((change) => {
						const meta = storyMeta.get(change.storyId);
						const reverted = revertedIds.has(change.storyId);
						const reverting =
							revertMutation.isPending &&
							revertMutation.variables?.storyId ===
								change.storyId;
						return (
							<li key={change.storyId} className="flex gap-2.5">
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
										<span className="break-words font-medium text-foreground text-sm">
											{meta?.title ?? change.storyId}
										</span>
										{meta && (
											<span className="text-[11px] text-muted-foreground tabular-nums">
												{meta.identifier}
											</span>
										)}
									</div>
									<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
										{/* The arrow is visual; "from/to" carry the
										    direction for a screen reader. */}
										<span className="sr-only">from </span>
										<PriorityBand
											priority={change.fromPriority}
											responsive={false}
											className={
												reverted
													? undefined
													: "opacity-70"
											}
										/>
										<span
											aria-hidden
											className="text-muted-foreground"
										>
											→
										</span>
										<span className="sr-only">to </span>
										<PriorityBand
											priority={change.toPriority}
											responsive={false}
											className={
												reverted
													? "opacity-40"
													: undefined
											}
										/>
									</div>
									{change.rationale && (
										<p className="mt-1 break-words text-muted-foreground text-xs">
											{change.rationale}
										</p>
									)}
								</div>
								{reverted ? (
									<span
										// Focusable target so the keyboard user's
										// position survives the button it replaced
										// unmounting mid-focus.
										tabIndex={-1}
										ref={(node) => {
											if (
												node &&
												focusRevertedIdRef.current ===
													change.storyId
											) {
												focusRevertedIdRef.current =
													null;
												node.focus();
											}
										}}
										className="inline-flex shrink-0 items-center gap-1 self-start text-muted-foreground text-xs"
									>
										<CheckIcon
											aria-hidden
											className="size-3.5"
										/>
										{t("digestReverted")}
									</span>
								) : (
									<Button
										variant="outline"
										size="sm"
										className="shrink-0 self-start"
										// Guard, not `disabled`: disabling the
										// focused button drops keyboard focus to
										// the dialog container (same footgun as
										// the Re-prioritize button). The label
										// stays "Revert" while pending — a
										// spinner glyph made the accessible name
										// transiently gibberish.
										aria-busy={reverting}
										onClick={() => {
											if (revertMutation.isPending) {
												return;
											}
											revertMutation.mutate(change);
										}}
									>
										{t("digestRevert")}
										<span className="sr-only">
											{" "}
											{meta?.identifier ?? change.storyId}
										</span>
									</Button>
								)}
							</li>
						);
					})}
				</ul>

				{/* Reverts replace the focused button with static text — this is
				    the spoken confirmation that something happened. */}
				<p aria-live="polite" className="sr-only">
					{announcement}
				</p>

				<div className="flex justify-end">
					<Button
						ref={doneRef}
						size="sm"
						onClick={() => onOpenChange(false)}
					>
						{t("digestClose")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
