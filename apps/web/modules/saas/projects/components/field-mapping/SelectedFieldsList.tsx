"use client";

import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { cn } from "@ui/lib";
import {
	CheckIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	GripVerticalIcon,
	PencilIcon,
	XIcon,
} from "lucide-react";
import { useState } from "react";
import {
	moveFieldByIndex,
	reorderFields,
	type SelectedField,
} from "./field-mapping-helpers";

type Props = {
	fields: SelectedField[];
	onChange: (fields: SelectedField[]) => void;
	disabled?: boolean;
};

/**
 * Ordered, reorderable list of the fields the admin has chosen. Reordering works
 * via drag-and-drop (@dnd-kit, enhancement) AND per-row keyboard move-up/down
 * buttons (mandatory WCAG 2.1 AA path). Each row also supports renaming its
 * display label and removing the field back to the available list.
 */
export function SelectedFieldsList({ fields, onChange, disabled }: Props) {
	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: { distance: 4 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) {
			return;
		}
		onChange(reorderFields(fields, String(active.id), String(over.id)));
	};

	const move = (index: number, direction: "up" | "down") => {
		const next = moveFieldByIndex(fields, index, direction);
		if (next !== fields) {
			onChange(next);
		}
	};

	const remove = (id: string) => onChange(fields.filter((f) => f.id !== id));

	const rename = (id: string, displayName: string) =>
		onChange(fields.map((f) => (f.id === id ? { ...f, displayName } : f)));

	if (fields.length === 0) {
		return (
			<p className="rounded-lg border border-dashed bg-muted/30 px-4 py-8 text-center text-muted-foreground text-sm">
				No fields selected yet. Pick fields from the list on the left to
				compose the synced work-item body.
			</p>
		);
	}

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			onDragEnd={handleDragEnd}
		>
			<SortableContext
				items={fields.map((f) => f.id)}
				strategy={verticalListSortingStrategy}
			>
				<ol className="space-y-2">
					{fields.map((field, index) => (
						<SortableFieldRow
							key={field.id}
							field={field}
							index={index}
							total={fields.length}
							disabled={disabled}
							onMove={move}
							onRemove={remove}
							onRename={rename}
						/>
					))}
				</ol>
			</SortableContext>
		</DndContext>
	);
}

function SortableFieldRow({
	field,
	index,
	total,
	disabled,
	onMove,
	onRemove,
	onRename,
}: {
	field: SelectedField;
	index: number;
	total: number;
	disabled?: boolean;
	onMove: (index: number, direction: "up" | "down") => void;
	onRemove: (id: string) => void;
	onRename: (id: string, displayName: string) => void;
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: field.id, disabled });

	const [isEditing, setIsEditing] = useState(false);
	const [draftName, setDraftName] = useState(field.displayName);

	const commitRename = () => {
		const next = draftName.trim();
		if (next && next !== field.displayName) {
			onRename(field.id, next);
		} else {
			setDraftName(field.displayName);
		}
		setIsEditing(false);
	};

	return (
		<li
			ref={setNodeRef}
			style={{ transform: CSS.Transform.toString(transform), transition }}
			className={cn(
				"flex items-center gap-2 rounded-lg border bg-card p-2 motion-safe:transition-shadow",
				isDragging && "z-10 opacity-80 shadow-sm",
			)}
		>
			<button
				type="button"
				aria-label={`Drag to reorder ${field.displayName}`}
				disabled={disabled}
				className="cursor-grab touch-none rounded p-0.5 text-muted-foreground/60 motion-safe:transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-50"
				{...attributes}
				{...listeners}
			>
				<GripVerticalIcon className="size-4" aria-hidden="true" />
			</button>

			<span className="w-5 shrink-0 text-center font-mono text-muted-foreground text-xs tabular-nums">
				{index + 1}
			</span>

			<div className="min-w-0 flex-1">
				{isEditing ? (
					<div className="flex items-center gap-1">
						<Input
							autoFocus
							value={draftName}
							onChange={(e) => setDraftName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									commitRename();
								} else if (e.key === "Escape") {
									setDraftName(field.displayName);
									setIsEditing(false);
								}
							}}
							onBlur={commitRename}
							aria-label={`Display label for ${field.id}`}
							className="h-7 text-sm"
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							onMouseDown={(e) => e.preventDefault()}
							onClick={commitRename}
							aria-label="Save display label"
						>
							<CheckIcon className="size-4" aria-hidden="true" />
						</Button>
					</div>
				) : (
					<div className="flex min-w-0 items-center gap-1.5">
						<div className="min-w-0">
							<p className="truncate font-medium text-foreground text-sm">
								{field.displayName}
							</p>
							<p className="truncate font-mono text-muted-foreground text-xs">
								{field.id}
							</p>
						</div>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							disabled={disabled}
							onClick={() => {
								setDraftName(field.displayName);
								setIsEditing(true);
							}}
							aria-label={`Edit display label for ${field.displayName}`}
							className="text-muted-foreground/60 hover:text-foreground"
						>
							<PencilIcon
								className="size-3.5"
								aria-hidden="true"
							/>
						</Button>
					</div>
				)}
			</div>

			<div className="flex shrink-0 items-center">
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					disabled={disabled || index === 0}
					onClick={() => onMove(index, "up")}
					aria-label={`Move ${field.displayName} up`}
				>
					<ChevronUpIcon className="size-4" aria-hidden="true" />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					disabled={disabled || index === total - 1}
					onClick={() => onMove(index, "down")}
					aria-label={`Move ${field.displayName} down`}
				>
					<ChevronDownIcon className="size-4" aria-hidden="true" />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					disabled={disabled}
					onClick={() => onRemove(field.id)}
					aria-label={`Remove ${field.displayName}`}
					className="text-muted-foreground hover:text-destructive"
				>
					<XIcon className="size-4" aria-hidden="true" />
				</Button>
			</div>
		</li>
	);
}
