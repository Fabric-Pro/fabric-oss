"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { TestCaseRow } from "./TestCaseRow";

/**
 * A `TestCaseRow` with a reorder grip.
 *
 * Separate from the row itself so the row stays a plain list item everywhere else
 * it is used — the drag machinery only exists in the one view where reordering is
 * coherent (see `case-reorder.ts`), and paying for a `useSortable` per row in
 * every other view would be a cost for nothing.
 *
 * The grip is a real `<button>`, not a draggable `<div>`: dnd-kit's keyboard
 * sensor drives reordering through the focused activator, so a non-focusable
 * handle makes the whole feature mouse-only.
 */
export function SortableCaseRow({
	id,
	label,
	...rowProps
}: {
	id: string;
	/** Names the grip for assistive tech — "Reorder TC-014", not "button". */
	label: string;
} & ComponentProps<typeof TestCaseRow>) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id });

	return (
		<TestCaseRow
			{...rowProps}
			rowRef={setNodeRef}
			rowStyle={{
				transform: CSS.Transform.toString(transform),
				transition,
			}}
			dragging={isDragging}
			dragHandle={
				<button
					type="button"
					aria-label={label}
					className="-ml-1 shrink-0 cursor-grab rounded p-0.5 text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:cursor-grabbing"
					{...attributes}
					{...listeners}
				>
					<GripVerticalIcon className="size-4" aria-hidden="true" />
				</button>
			}
		/>
	);
}
