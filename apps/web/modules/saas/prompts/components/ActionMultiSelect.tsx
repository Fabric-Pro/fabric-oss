"use client";

import { listPromptActions } from "@repo/utils/prompt-action-catalog";
import { useMemo } from "react";

/**
 * Pick the set of actions a prompt applies to.
 *
 * Three surfaces need this same list — binding a prompt to several actions at
 * once (FR19), proposing one for several (FR22), and a reviewer editing the set
 * before approving (FR23). They are the same question asked at three moments,
 * so they ask it with one control; a second copy is how two of them end up
 * disagreeing about which actions exist.
 *
 * `alwaysIncluded` is the action the surrounding surface is already about. It
 * renders as a fixed row rather than a checked box, because it is not the
 * user's to clear here — clearing it would silently change what they are
 * looking at.
 */

export type ActionMultiSelectProps = {
	/** Action id (from `promptActionId`) that is always part of the set. */
	alwaysIncluded?: string;
	/** Action ids selected in addition to `alwaysIncluded`. */
	value: string[];
	onChange: (next: string[]) => void;
	label: string;
	/** Rendered under the list; the caller knows what the set means. */
	hint?: string;
	id: string;
};

export function ActionMultiSelect({
	alwaysIncluded,
	value,
	onChange,
	label,
	hint,
	id,
}: ActionMultiSelectProps) {
	const selectable = useMemo(
		() => listPromptActions().filter((a) => a.id !== alwaysIncluded),
		[alwaysIncluded],
	);

	const fixed = useMemo(
		() =>
			alwaysIncluded
				? listPromptActions().find((a) => a.id === alwaysIncluded)
				: undefined,
		[alwaysIncluded],
	);

	const toggle = (actionId: string, checked: boolean) => {
		onChange(
			checked
				? [...value, actionId]
				: value.filter((existing) => existing !== actionId),
		);
	};

	return (
		// A fieldset and legend, not a Label pointing at a div: `htmlFor` on a
		// div is not a label association at all — a div is not labellable — so
		// a screen reader announces these checkboxes with no idea what set they
		// belong to. The scroll bound stays on the inner div, because a
		// fieldset does not height-bound its own content reliably.
		// The id belongs on the fieldset, which is the element that carries the
		// group role — putting it on the inner div left the group itself
		// unidentifiable, and two of these on one page indistinguishable.
		<fieldset id={id} className="space-y-2">
			<legend className="pb-2 font-medium text-sm leading-none">
				{label}
			</legend>
			<div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
				{fixed && (
					<p className="flex items-center gap-2 py-0.5 text-muted-foreground text-sm">
						<span className="truncate">{fixed.label}</span>
						<span className="shrink-0 text-xs">(always)</span>
					</p>
				)}
				{selectable.map((action) => (
					<label
						key={action.id}
						className="flex cursor-pointer items-center gap-2 text-sm"
					>
						<input
							type="checkbox"
							checked={value.includes(action.id)}
							onChange={(e) =>
								toggle(action.id, e.target.checked)
							}
							className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
						/>
						<span className="truncate">{action.label}</span>
					</label>
				))}
			</div>
			{hint && <p className="text-muted-foreground text-xs">{hint}</p>}
		</fieldset>
	);
}
