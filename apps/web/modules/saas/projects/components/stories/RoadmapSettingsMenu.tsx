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
import { Checkbox } from "@ui/components/checkbox";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	GripVerticalIcon,
	LayoutGridIcon,
	ListIcon,
	RotateCcwIcon,
	Rows3Icon,
	SettingsIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import {
	DEFAULT_ROADMAP_COLUMN_ORDER,
	DEFAULT_ROADMAP_COLUMNS,
	DEFAULT_ROADMAP_MODE,
	type RoadmapColumnKey,
	type RoadmapColumns,
	type RoadmapFieldKey,
	type RoadmapGroupBy,
	type RoadmapViewMode,
} from "../../hooks/useRoadmapView";
import { Segmented } from "./Segmented";

export type RoadmapSettingsMenuProps = {
	mode: RoadmapViewMode;
	onModeChange: (mode: RoadmapViewMode) => void;
	groupBy: RoadmapGroupBy;
	onGroupByChange: (groupBy: RoadmapGroupBy) => void;
	columns: RoadmapColumns;
	onColumnsChange: (columns: RoadmapColumns) => void;
	columnOrder: RoadmapFieldKey[];
	onColumnOrderChange: (order: RoadmapFieldKey[]) => void;
	/** True when the live draft differs from the last-saved view (enables Save/Cancel). */
	isDirty: boolean;
	/** Persist the live draft (localStorage) so it survives refresh/navigation. */
	onSave: () => void;
	/** Discard unsaved edits, snapping the roadmap back to the last-saved view. */
	onCancel: () => void;
	showHidden?: boolean;
	onShowHiddenChange?: (show: boolean) => void;
};

/** One draggable, toggle-able card-field row in the Card fields list. */
function SortableFieldRow({
	id,
	label,
	checked,
	locked = false,
	onCheckedChange,
}: {
	id: RoadmapFieldKey;
	label: string;
	checked: boolean;
	/** Title is locked-on: shown, draggable, but its visibility can't be toggled. */
	locked?: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	const t = useTranslations("projects.stories.roadmapUi");
	const checkboxId = useId();
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id });
	return (
		<div
			ref={setNodeRef}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
			}}
			className={cn(
				"flex items-center gap-2 rounded-md px-1 py-1",
				isDragging && "bg-accent opacity-80 shadow-sm",
			)}
		>
			<button
				type="button"
				aria-label={t("reorderField", { label })}
				className="cursor-grab touch-none text-muted-foreground/50 transition-colors hover:text-foreground active:cursor-grabbing"
				{...attributes}
				{...listeners}
			>
				<GripVerticalIcon className="size-3.5" />
			</button>
			<label
				htmlFor={checkboxId}
				className={cn(
					"flex flex-1 items-center gap-2 text-sm",
					locked
						? "text-foreground/50"
						: "cursor-pointer text-foreground",
				)}
			>
				<Checkbox
					id={checkboxId}
					checked={checked}
					disabled={locked}
					aria-label={
						locked ? t("alwaysShown", { label }) : undefined
					}
					onCheckedChange={
						locked ? undefined : (c) => onCheckedChange(c === true)
					}
				/>
				{label}
			</label>
		</div>
	);
}

export function RoadmapSettingsMenu({
	mode,
	onModeChange,
	groupBy,
	onGroupByChange,
	columns,
	onColumnsChange,
	columnOrder,
	onColumnOrderChange,
	isDirty,
	onSave,
	onCancel,
	showHidden,
	onShowHiddenChange,
}: RoadmapSettingsMenuProps) {
	const t = useTranslations("projects.stories.roadmapUi");
	const viewLabel = t(isDirty ? "viewUnsaved" : "view", {
		layout: t(`layouts.${mode}`),
	});
	const tTips = useTranslations("tooltips.stories");
	const [open, setOpen] = useState(false);
	// Two-step Reset: the first click reveals an inline confirm (it wipes every
	// view setting, so a misclick would be annoying to undo).
	const [resetConfirm, setResetConfirm] = useState(false);
	// Focus home for BOTH confirm exits (Cancel / Reset to defaults): the
	// confirm panel unmounts while holding focus, and this non-modal popover
	// has no focus scope to catch it — without an explicit restore, focus
	// lands on <body> with the popover still open. Restored in an effect, not
	// the click handler: the Reset button is `disabled` until the same commit
	// re-enables it, and focus() on a disabled control is a no-op.
	const resetButtonRef = useRef<HTMLButtonElement>(null);
	const prevResetConfirm = useRef(false);
	useEffect(() => {
		if (prevResetConfirm.current && !resetConfirm) {
			resetButtonRef.current?.focus();
		}
		prevResetConfirm.current = resetConfirm;
	}, [resetConfirm]);
	// Every setting (layout, grouping, sort, fields + order) PREVIEWS LIVE on the
	// roadmap as you edit; the hook holds it as an unsaved draft. Save persists it
	// (survives refresh); Cancel discards it back to the last-saved view.
	const headingId = useId();
	const hiddenId = useId();
	const hiddenHelpId = useId();

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) {
			return;
		}
		const oldIndex = columnOrder.indexOf(active.id as RoadmapFieldKey);
		const newIndex = columnOrder.indexOf(over.id as RoadmapFieldKey);
		if (oldIndex < 0 || newIndex < 0) {
			return;
		}
		onColumnOrderChange(arrayMove(columnOrder, oldIndex, newIndex));
	};

	// Restore this menu's settings (layout, grouping, card fields + order) to
	// their shipped defaults, applying immediately (live). The sort is left
	// alone: it is the toolbar's control and saves on change, so resetting it
	// here would write a change this menu's Cancel could not take back.
	const handleReset = () => {
		onModeChange(DEFAULT_ROADMAP_MODE);
		onGroupByChange("priority");
		onColumnsChange({ ...DEFAULT_ROADMAP_COLUMNS });
		onColumnOrderChange([...DEFAULT_ROADMAP_COLUMN_ORDER]);
	};

	return (
		<Popover
			open={open}
			onOpenChange={(o) => {
				// Closing via outside-click / Esc keeps the live draft (still
				// unsaved — a refresh reverts it); only Cancel discards it now.
				// Never leave a half-open Reset confirm behind.
				setResetConfirm(false);
				setOpen(o);
			}}
		>
			<Tooltip disabled={open}>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className="relative gap-2"
							aria-label={viewLabel}
						>
							<SettingsIcon aria-hidden className="size-4" />
							{t("view", { layout: t(`layouts.${mode}`) })}
							{/* Unsaved-draft cue: the live view differs from the
							    saved one, which a refresh would revert. */}
							{isDirty && (
								<span
									aria-hidden
									className="absolute right-1 top-1 size-1.5 rounded-full bg-primary"
								/>
							)}
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent>
					{isDirty ? t("settingsUnsavedHelp") : t("settingsHelp")}
				</TooltipContent>
			</Tooltip>
			<PopoverContent
				align="end"
				className="w-[320px] max-w-[calc(100vw-2rem)] space-y-4 p-3"
				aria-labelledby={headingId}
			>
				<div>
					<p
						id={headingId}
						className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground"
					>
						{t("settings")}
					</p>
					<p className="mt-1 text-[11px] leading-snug text-muted-foreground">
						{t("personalViewHelp")}
					</p>
				</div>
				{onShowHiddenChange && (
					<div className="space-y-2">
						<label
							htmlFor={hiddenId}
							className="flex items-center gap-2 text-sm"
						>
							<Checkbox
								id={hiddenId}
								aria-describedby={hiddenHelpId}
								checked={showHidden}
								onCheckedChange={(checked) =>
									onShowHiddenChange(checked === true)
								}
							/>
							{t("showHidden")}
						</label>
						<p
							id={hiddenHelpId}
							className="text-sm text-muted-foreground"
						>
							{tTips(
								showHidden
									? "hideClosedFeatures"
									: "showClosedFeatures",
							)}
						</p>
					</div>
				)}
				<div>
					<Segmented<RoadmapViewMode>
						label={t("layout")}
						value={mode}
						onChange={onModeChange}
						options={[
							{
								value: "table",
								label: t("layouts.table"),
								icon: <ListIcon className="size-3.5" />,
							},
							{
								value: "board",
								label: t("layouts.board"),
								icon: <LayoutGridIcon className="size-3.5" />,
							},
							{
								value: "plain",
								label: t("layouts.plain"),
								icon: <Rows3Icon className="size-3.5" />,
							},
							// Priority is deliberately absent: it is a peer SECTION
							// of the roadmap (see RoadmapSectionSwitcher), not a
							// fourth way to draw the work-item list. Layout is back
							// to being purely about rendering.
						]}
					/>
					{/* While Priority is the active section, no layout option is
					    selected and picking one LEAVES Priority — say so instead
					    of silently navigating. */}
					{mode === "priority" && (
						<p className="mt-1 text-[11px] leading-snug text-muted-foreground">
							{t("priorityLayoutHelp")}
						</p>
					)}
				</div>
				{/* Priority is a single ranked worklist and Plain is a flat table —
				    neither has lanes to group, so the control only applies to the
				    two grouped layouts. */}
				{mode !== "plain" && mode !== "priority" && (
					<Segmented<RoadmapGroupBy>
						label={t("groupBy")}
						value={groupBy}
						onChange={onGroupByChange}
						options={[
							{
								value: "priority",
								label: t("priority"),
								tooltip: tTips("groupByPriority"),
							},
							{ value: "stage", label: t("groupStage") },
							{
								value: "track",
								label: t("groupTrack"),
								tooltip: tTips("groupByTrack"),
							},
							{
								value: "phase",
								label: t("groupPhase"),
								tooltip: tTips("groupByPhase"),
							},
						]}
					/>
				)}

				{/* No cards on the Priority section's ranked list — the whole
				    group would apply to nothing visible. */}
				{mode !== "priority" && (
					<div className="space-y-3">
						{/* Card fields — drag to reorder; Title is always first. */}
						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
									{t("cardFields")}
								</p>
								<span className="text-[10px] text-muted-foreground/50">
									{t("reorderHint")}
								</span>
							</div>
							<div className="space-y-1">
								<DndContext
									sensors={sensors}
									collisionDetection={closestCenter}
									onDragEnd={handleDragEnd}
								>
									<SortableContext
										items={columnOrder}
										strategy={verticalListSortingStrategy}
									>
										{columnOrder.map((key) => {
											const isTitle = key === "title";
											return (
												<SortableFieldRow
													key={key}
													id={key}
													label={t(
														`fieldLabels.${key}`,
													)}
													checked={
														isTitle
															? true
															: columns[
																	key as RoadmapColumnKey
																]
													}
													locked={isTitle}
													onCheckedChange={(c) =>
														onColumnsChange({
															...columns,
															[key as RoadmapColumnKey]:
																c,
														})
													}
												/>
											);
										})}
									</SortableContext>
								</DndContext>
							</div>
						</div>
					</div>
				)}
				<div className="space-y-2 border-t border-border/50 pt-3">
					{resetConfirm && (
						<div className="rounded-md border border-border bg-muted/40 p-2">
							<p className="mb-2 text-[11px] text-muted-foreground">
								{t("resetConfirm")}
							</p>
							<div className="flex justify-end gap-2">
								<Button
									// Focus lands here when the confirm appears:
									// the Reset button that opened it becomes
									// disabled in the same commit, and a focused
									// element going disabled drops keyboard
									// focus to <body>.
									autoFocus
									variant="ghost"
									size="sm"
									onClick={() => setResetConfirm(false)}
								>
									{t("cancel")}
								</Button>
								<Button
									variant="destructive"
									size="sm"
									onClick={() => {
										handleReset();
										setResetConfirm(false);
									}}
								>
									{t("resetDefaults")}
								</Button>
							</div>
						</div>
					)}
					{isDirty && (
						<p className="text-center text-[11px] text-primary/80">
							{t("unsavedChanges")}
						</p>
					)}
					<div className="flex items-center justify-between">
						<Button
							ref={resetButtonRef}
							variant="ghost"
							size="sm"
							disabled={resetConfirm}
							onClick={() => setResetConfirm(true)}
							className="px-2 text-muted-foreground hover:text-foreground"
						>
							<RotateCcwIcon className="mr-1.5 size-3.5" />
							{t("reset")}
						</Button>
						<div className="flex gap-2">
							<Button
								variant="ghost"
								size="sm"
								disabled={!isDirty}
								onClick={() => {
									// Discard unsaved edits → snap back to last-saved.
									onCancel();
									setOpen(false);
								}}
							>
								{t("cancel")}
							</Button>
							<Button
								size="sm"
								disabled={!isDirty}
								onClick={() => {
									// Persist the live draft so it survives refresh.
									onSave();
									setOpen(false);
								}}
							>
								{t("save")}
							</Button>
						</div>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
