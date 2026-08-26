"use client";

/**
 * TaskEditPopover - Edit or create tasks in a popover/dialog
 *
 * Used in:
 * - ProjectPipeline (Pipeline tab)
 * - StoryWorkspace (Story editor)
 */

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import {
	ClockIcon,
	FileTextIcon,
	FolderIcon,
	Loader2Icon,
	XIcon,
} from "lucide-react";
import { useState } from "react";
import type { StoryTask } from "../lib/stories/types";

interface TaskEditPopoverProps {
	/** The task to edit, or null for creating new task */
	task?: StoryTask | null;
	/** Project name for breadcrumb display */
	projectName?: string;
	/** Story title for breadcrumb display */
	storyTitle?: string;
	/** Trigger element (button, icon, etc.) */
	children: React.ReactNode;
	/** Called when task is saved */
	onSave: (data: {
		title: string;
		description: string | null;
		estimatedHours: number | null;
	}) => Promise<void>;
	/** Called when popover closes */
	onClose?: () => void;
	/** Whether the popover is controlled externally */
	open?: boolean;
	/** Callback for external open state control */
	onOpenChange?: (open: boolean) => void;
	/** Side of the trigger to show popover */
	side?: "top" | "right" | "bottom" | "left";
	/** Alignment of the popover */
	align?: "start" | "center" | "end";
}

export function TaskEditPopover({
	task,
	projectName,
	storyTitle,
	children,
	onSave,
	onClose,
	open: controlledOpen,
	onOpenChange,
	side = "bottom",
	align = "start",
}: TaskEditPopoverProps) {
	const [internalOpen, setInternalOpen] = useState(false);
	const [title, setTitle] = useState(task?.title || "");
	const [description, setDescription] = useState(task?.description || "");
	const [estimatedHours, setEstimatedHours] = useState(
		task?.estimatedHours?.toString() || "",
	);
	const [isSaving, setIsSaving] = useState(false);

	const isControlled = controlledOpen !== undefined;
	const isOpen = isControlled ? controlledOpen : internalOpen;

	const handleOpenChange = (newOpen: boolean) => {
		if (isControlled) {
			onOpenChange?.(newOpen);
		} else {
			setInternalOpen(newOpen);
		}

		// Reset form when opening
		if (newOpen) {
			setTitle(task?.title || "");
			setDescription(task?.description || "");
			setEstimatedHours(task?.estimatedHours?.toString() || "");
		} else {
			onClose?.();
		}
	};

	const handleSave = async () => {
		if (!title.trim()) {
			return;
		}

		setIsSaving(true);
		try {
			await onSave({
				title: title.trim(),
				description: description.trim() || null,
				estimatedHours: estimatedHours
					? Number.parseFloat(estimatedHours)
					: null,
			});
			handleOpenChange(false);
		} finally {
			setIsSaving(false);
		}
	};

	const isEdit = !!task;

	return (
		<Popover open={isOpen} onOpenChange={handleOpenChange}>
			<PopoverTrigger asChild>{children}</PopoverTrigger>
			<PopoverContent
				side={side}
				align={align}
				className="w-[calc(100vw-1.5rem)] max-w-[400px] p-0"
				onInteractOutside={(e) => {
					// Prevent closing when clicking inside the popover
					if (isSaving) {
						e.preventDefault();
					}
				}}
			>
				<div className="flex flex-col">
					{/* Header with breadcrumb */}
					<div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							{projectName && (
								<>
									<FolderIcon className="w-3.5 h-3.5" />
									<span className="max-w-[100px] truncate">
										{projectName}
									</span>
								</>
							)}
							{projectName && storyTitle && (
								<span className="text-muted-foreground/50">
									&#8226;
								</span>
							)}
							{storyTitle && (
								<>
									<FileTextIcon className="w-3.5 h-3.5" />
									<span className="max-w-[120px] truncate">
										{storyTitle}
									</span>
								</>
							)}
						</div>
						<Button
							variant="ghost"
							size="sm"
							className="h-6 w-6 p-0"
							onClick={() => handleOpenChange(false)}
						>
							<XIcon className="w-4 h-4" />
						</Button>
					</div>

					{/* Form content */}
					<div className="p-4 space-y-4">
						{/* Task title */}
						<div className="space-y-1.5">
							<Input
								value={title}
								onChange={(e) => setTitle(e.target.value)}
								placeholder="Task title"
								className="text-lg font-medium border-0 px-0 h-auto focus-visible:ring-0 placeholder:text-muted-foreground/50"
								autoFocus
								onKeyDown={(e) => {
									if (
										e.key === "Enter" &&
										!e.shiftKey &&
										title.trim()
									) {
										e.preventDefault();
										handleSave();
									}
									if (e.key === "Escape") {
										handleOpenChange(false);
									}
								}}
							/>
						</div>

						{/* Task description */}
						<div className="space-y-1.5">
							<Textarea
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder="Brief description of this task"
								className="min-h-[80px] resize-none text-sm"
								onKeyDown={(e) => {
									if (e.key === "Escape") {
										handleOpenChange(false);
									}
								}}
							/>
						</div>

						{/* Properties row */}
						<div className="flex items-center gap-2 flex-wrap">
							{/* Estimated hours */}
							<div className="flex items-center gap-1.5">
								<Badge
									variant="outline"
									className={cn(
										"gap-1.5 cursor-pointer hover:bg-muted transition-colors",
										estimatedHours &&
											"bg-primary/10 border-primary/30",
									)}
								>
									<ClockIcon className="w-3 h-3" />
									<Input
										type="number"
										value={estimatedHours}
										onChange={(e) =>
											setEstimatedHours(e.target.value)
										}
										placeholder="Hours"
										className="w-14 h-5 text-xs border-0 bg-transparent p-0 focus-visible:ring-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
										step="0.5"
										min="0"
									/>
									{estimatedHours && (
										<span className="text-xs">h</span>
									)}
								</Badge>
							</div>

							{/* Task identifier (if editing) */}
							{task?.identifier && (
								<Badge variant="secondary" className="text-xs">
									{task.identifier}
								</Badge>
							)}
						</div>
					</div>

					{/* Footer with action buttons */}
					<div className="flex items-center justify-end gap-2 px-4 py-3 border-t bg-muted/30">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => handleOpenChange(false)}
							disabled={isSaving}
						>
							Cancel
						</Button>
						<Button
							size="sm"
							onClick={handleSave}
							disabled={!title.trim() || isSaving}
						>
							{isSaving ? (
								<>
									<Loader2Icon className="w-4 h-4 mr-2 animate-spin" />
									Saving...
								</>
							) : isEdit ? (
								"Update Task"
							) : (
								"Create Task"
							)}
						</Button>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
