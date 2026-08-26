"use client";

import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import type { StoryPriority } from "../../../lib/stories/types";
import { getPriorityLabel, PRIORITY_OPTIONS } from "../../../lib/stories/types";

/**
 * The four bands, highest first — derived from the single source of truth so a
 * fifth tier added to the schema shows up here without a second edit.
 */
const PRIORITY_VALUES = PRIORITY_OPTIONS.map(
	(option) => option.value,
) as StoryPriority[];

/** Matches the server's MAX_COMMENT_LENGTH so the field can't outrun the API. */
const MAX_COMMENT_LENGTH = 500;

type Props = {
	current: StoryPriority;
	isSaving: boolean;
	/** Omit where the editor is a permanent fixture (the Priority view's
	 * expanded rows) — there is nothing to cancel back to, so no button. */
	onCancel?: () => void;
	onSave: (priority: StoryPriority, comment: string) => void;
	/** The per-item AI sparkle ({@link AiReprioritizeControl}), rendered on the
	 * footer's left so every surface that can set a band by hand offers the AI
	 * alternative in the same breath. A slot, not a hard dependency: the editor
	 * stays renderable in isolation (tests, storybook-style harnesses). */
	aiSlot?: ReactNode;
};

/**
 * Inline "set the band, optionally say why" editor for one work item.
 *
 * The comment is genuinely optional — a band move with no explanation is a
 * legitimate act, and requiring a justification would push people back to
 * editing priority somewhere that records nothing.
 */
export function PriorityEditor({
	current,
	isSaving,
	onCancel,
	onSave,
	aiSlot,
}: Props) {
	const t = useTranslations("projects.stories.priority");
	const groupId = useId();
	const commentId = useId();
	const [selected, setSelected] = useState<StoryPriority>(current);
	const [comment, setComment] = useState("");

	// The editor can be a permanent fixture (the Priority view's expanded rows),
	// so `current` can change UNDER it — our own save landing, the AI sparkle,
	// another member. Sync during render (never a remount: a remount would wipe
	// an in-progress comment draft and drop focus mid-keystroke):
	//  - band arrived where the picker points → our save landed; clear the
	//    comment, it is recorded in the history now.
	//  - band moved somewhere else → external change; re-seed the picker and
	//    leave any draft alone.
	const [lastCurrent, setLastCurrent] = useState(current);
	if (current !== lastCurrent) {
		setLastCurrent(current);
		if (current === selected) {
			setComment("");
		} else {
			setSelected(current);
		}
	}

	// Re-picking the band it already has is a no-op the server would discard;
	// disabling Save says so before the click rather than after.
	const unchanged = selected === current;

	return (
		<div className="space-y-2.5 rounded-lg border border-border bg-muted/40 p-3">
			<p
				id={groupId}
				className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.2em]"
			>
				{t("setPriorityHeading")}
			</p>

			{/* `role="group"` + `aria-pressed`, matching the shared `Segmented`
			    control, rather than a radiogroup of buttons — same semantics for
			    a screen reader and the idiom the rest of the roadmap already uses. */}
			<div
				role="group"
				aria-labelledby={groupId}
				className="flex flex-wrap gap-1.5"
			>
				{PRIORITY_VALUES.map((option) => {
					const active = option === selected;
					return (
						<button
							key={option}
							type="button"
							aria-pressed={active}
							onClick={() => setSelected(option)}
							disabled={isSaving}
							className={cn(
								"rounded-md border px-2.5 py-1 font-semibold text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
								active
									? "border-primary bg-primary/10 text-primary-ink"
									: "border-border text-muted-foreground hover:text-foreground",
							)}
						>
							{getPriorityLabel(option)}
						</button>
					);
				})}
			</div>

			<div>
				<label htmlFor={commentId} className="sr-only">
					{t("commentLabel")}
				</label>
				<Input
					id={commentId}
					value={comment}
					onChange={(event) => setComment(event.target.value)}
					placeholder={t("commentPlaceholder")}
					maxLength={MAX_COMMENT_LENGTH}
					disabled={isSaving}
					className="h-8 text-xs"
				/>
			</div>

			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center">{aiSlot}</div>
				<div className="flex items-center gap-2">
					{onCancel && (
						<Button
							variant="ghost"
							size="sm"
							onClick={onCancel}
							disabled={isSaving}
						>
							{t("cancel")}
						</Button>
					)}
					<Button
						size="sm"
						onClick={() => onSave(selected, comment)}
						disabled={isSaving || unchanged}
					>
						{t("savePriority")}
					</Button>
				</div>
			</div>
		</div>
	);
}
