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
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { GripVerticalIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";

/** One ordered Action/Expected step in the editor; `key` is a stable client-side
 * id for drag-and-drop, `id` (when present) is the persisted `TestCaseStep` id. */
export type StepDraft = {
	key: string;
	id?: string;
	action: string;
	expected: string;
};

/** Generate a stable client key for a freshly-added (not-yet-persisted) step. */
export function newStepKey(): string {
	return `step-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/** Pure reorder used by the drag handler — exported so it is unit-testable
 * without simulating pointer/keyboard drag events. */
export function reorderSteps(
	steps: StepDraft[],
	fromKey: string,
	toKey: string,
): StepDraft[] {
	const from = steps.findIndex((s) => s.key === fromKey);
	const to = steps.findIndex((s) => s.key === toKey);
	if (from === -1 || to === -1 || from === to) {
		return steps;
	}
	return arrayMove(steps, from, to);
}

type Props = {
	steps: StepDraft[];
	onChange: (steps: StepDraft[]) => void;
	disabled?: boolean;
};

export function StepEditor({ steps, onChange, disabled }: Props) {
	const t = useTranslations("projects.testCases");
	const sensors = useSensors(
		useSensor(PointerSensor, {
			// Small activation distance so a click on a textarea doesn't start a drag.
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
		onChange(reorderSteps(steps, String(active.id), String(over.id)));
	};

	const update = (key: string, patch: Partial<StepDraft>) =>
		onChange(steps.map((s) => (s.key === key ? { ...s, ...patch } : s)));

	const remove = (key: string) =>
		onChange(steps.filter((s) => s.key !== key));

	const insertAfter = (index: number) => {
		const next = steps.slice();
		next.splice(index + 1, 0, {
			key: newStepKey(),
			action: "",
			expected: "",
		});
		onChange(next);
	};

	const addStep = () =>
		onChange([...steps, { key: newStepKey(), action: "", expected: "" }]);

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<p className="app-editorial-label">{t("steps.heading")}</p>
				<span className="text-muted-foreground text-xs tabular-nums">
					{t("stepCount", { count: steps.length })}
				</span>
			</div>

			{steps.length === 0 ? (
				<p className="rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center text-muted-foreground text-sm">
					{t("steps.empty")}
				</p>
			) : (
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					onDragEnd={handleDragEnd}
				>
					<SortableContext
						items={steps.map((s) => s.key)}
						strategy={verticalListSortingStrategy}
					>
						<ol className="space-y-2">
							{steps.map((step, index) => (
								<SortableStepRow
									key={step.key}
									step={step}
									index={index}
									disabled={disabled}
									onUpdate={update}
									onRemove={remove}
									onInsertAfter={insertAfter}
								/>
							))}
						</ol>
					</SortableContext>
				</DndContext>
			)}

			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={addStep}
				disabled={disabled}
			>
				<PlusIcon className="mr-2 size-4" aria-hidden="true" />
				{t("steps.add")}
			</Button>
		</div>
	);
}

function SortableStepRow({
	step,
	index,
	disabled,
	onUpdate,
	onRemove,
	onInsertAfter,
}: {
	step: StepDraft;
	index: number;
	disabled?: boolean;
	onUpdate: (key: string, patch: Partial<StepDraft>) => void;
	onRemove: (key: string) => void;
	onInsertAfter: (index: number) => void;
}) {
	const t = useTranslations("projects.testCases");
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: step.key, disabled });

	return (
		<li
			ref={setNodeRef}
			style={{ transform: CSS.Transform.toString(transform), transition }}
			className={cn(
				"flex items-start gap-2 rounded-lg border bg-card p-2",
				isDragging && "z-10 opacity-80 shadow-sm",
			)}
		>
			<div className="flex flex-col items-center gap-1 pt-1.5">
				<button
					type="button"
					aria-label={t("steps.reorderAria", { number: index + 1 })}
					disabled={disabled}
					className="cursor-grab touch-none rounded text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-50"
					{...attributes}
					{...listeners}
				>
					<GripVerticalIcon className="size-4" aria-hidden="true" />
				</button>
				<span className="font-mono text-muted-foreground text-xs tabular-nums">
					{index + 1}
				</span>
			</div>

			<div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
				<div className="space-y-1">
					<span className="text-muted-foreground text-xs">
						{t("steps.actionLabel")}
					</span>
					<Textarea
						value={step.action}
						onChange={(e) =>
							onUpdate(step.key, { action: e.target.value })
						}
						disabled={disabled}
						rows={2}
						placeholder={t("steps.actionPlaceholder")}
						aria-label={t("steps.actionAria", {
							number: index + 1,
						})}
						className="min-h-[3.5rem] resize-y"
					/>
				</div>
				<div className="space-y-1">
					<span className="text-muted-foreground text-xs">
						{t("steps.expectedLabel")}
					</span>
					<Textarea
						value={step.expected}
						onChange={(e) =>
							onUpdate(step.key, { expected: e.target.value })
						}
						disabled={disabled}
						rows={2}
						placeholder={t("steps.expectedPlaceholder")}
						aria-label={t("steps.expectedAria", {
							number: index + 1,
						})}
						className="min-h-[3.5rem] resize-y"
					/>
				</div>
			</div>

			<div className="flex flex-col gap-1">
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							onClick={() => onInsertAfter(index)}
							disabled={disabled}
							aria-label={t("steps.insertAfterAria", {
								number: index + 1,
							})}
						>
							<PlusIcon className="size-4" aria-hidden="true" />
						</Button>
					</TooltipTrigger>
					<TooltipContent surface="popover">
						{t("steps.insertBelow")}
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							onClick={() => onRemove(step.key)}
							disabled={disabled}
							aria-label={t("steps.deleteAria", {
								number: index + 1,
							})}
							className="text-muted-foreground hover:text-destructive"
						>
							<Trash2Icon className="size-4" aria-hidden="true" />
						</Button>
					</TooltipTrigger>
					<TooltipContent surface="popover">
						{t("steps.delete")}
					</TooltipContent>
				</Tooltip>
			</div>
		</li>
	);
}
