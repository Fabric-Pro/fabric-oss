"use client";

import { Button } from "@ui/components/button";
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
	BookmarkIcon,
	BookmarkPlusIcon,
	History,
	RotateCcw,
	Trash2,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import * as React from "react";

// ============================================================================
// Types
// ============================================================================

/**
 * Checkpoint data type for managing conversation checkpoints
 */
export interface CheckpointData {
	id: string;
	label?: string;
	/** Index in messages array where checkpoint was created */
	messageIndex: number;
	/** Number of messages at time of checkpoint */
	messageCount: number;
	/** Timestamp of checkpoint creation */
	timestamp: Date;
	/** Optional metadata (token usage at checkpoint, etc.) */
	metadata?: Record<string, unknown>;
}

/**
 * Context value for checkpoint management
 */
interface CheckpointContextValue {
	checkpoints: CheckpointData[];
	onCreateCheckpoint?: (label?: string) => void;
	onRestoreCheckpoint?: (checkpoint: CheckpointData) => void;
	onDeleteCheckpoint?: (checkpointId: string) => void;
	currentMessageIndex?: number;
}

const CheckpointContext = React.createContext<CheckpointContextValue | null>(
	null,
);

function _useCheckpointContext(): CheckpointContextValue {
	const context = React.useContext(CheckpointContext);
	if (!context) {
		throw new Error(
			"Checkpoint components must be used within <CheckpointProvider>",
		);
	}
	return context;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a new checkpoint
 */
export function createCheckpoint(
	messageIndex: number,
	messageCount: number,
	label?: string,
	metadata?: Record<string, unknown>,
): CheckpointData {
	return {
		id: `checkpoint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		label,
		messageIndex,
		messageCount,
		timestamp: new Date(),
		metadata,
	};
}

/**
 * Format relative time for checkpoint display
 */
function formatRelativeTime(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);

	if (diffMins < 1) {
		return "just now";
	}
	if (diffMins < 60) {
		return `${diffMins}m ago`;
	}
	if (diffHours < 24) {
		return `${diffHours}h ago`;
	}
	return `${diffDays}d ago`;
}

// ============================================================================
// Provider Component
// ============================================================================

export type CheckpointProviderProps = {
	children: ReactNode;
	checkpoints: CheckpointData[];
	currentMessageIndex?: number;
	onCreateCheckpoint?: (label?: string) => void;
	onRestoreCheckpoint?: (checkpoint: CheckpointData) => void;
	onDeleteCheckpoint?: (checkpointId: string) => void;
};

export function CheckpointProvider({
	children,
	checkpoints,
	currentMessageIndex,
	onCreateCheckpoint,
	onRestoreCheckpoint,
	onDeleteCheckpoint,
}: CheckpointProviderProps) {
	const value: CheckpointContextValue = {
		checkpoints,
		currentMessageIndex,
		onCreateCheckpoint,
		onRestoreCheckpoint,
		onDeleteCheckpoint,
	};

	return (
		<CheckpointContext.Provider value={value}>
			{children}
		</CheckpointContext.Provider>
	);
}

// ============================================================================
// Main Checkpoint Component (Divider style)
// ============================================================================

export type CheckpointProps = ComponentProps<"div"> & {
	checkpoint?: CheckpointData;
};

export const Checkpoint = ({
	className,
	children,
	checkpoint,
	...props
}: CheckpointProps) => (
	<div
		className={cn(
			"flex items-center gap-2 py-2 my-2 select-none",
			className,
		)}
		{...props}
	>
		<div className="flex-1 h-px bg-border" />
		<div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-muted/50 border">
			<BookmarkIcon className="h-3 w-3 text-primary" />
			{children ?? (
				<span className="text-xs text-muted-foreground">
					{checkpoint?.label ||
						`Checkpoint ${checkpoint?.messageCount || ""}`}
				</span>
			)}
		</div>
		<div className="flex-1 h-px bg-border" />
	</div>
);

// ============================================================================
// Create Checkpoint Button
// ============================================================================

export type CheckpointCreateButtonProps = ComponentProps<typeof Button> & {
	onCreateCheckpoint?: (label?: string) => void;
};

export function CheckpointCreateButton({
	className,
	onCreateCheckpoint: onCreateProp,
	...props
}: CheckpointCreateButtonProps) {
	const context = React.useContext(CheckpointContext);
	const handleCreate = onCreateProp || context?.onCreateCheckpoint;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className={cn("h-8 w-8 p-0", className)}
					onClick={() => handleCreate?.()}
					{...props}
				>
					<BookmarkPlusIcon className="h-4 w-4" />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="top">
				<p>Create checkpoint</p>
			</TooltipContent>
		</Tooltip>
	);
}

// ============================================================================
// Checkpoint Restore Button (Inline)
// ============================================================================

export type CheckpointRestoreButtonProps = ComponentProps<typeof Button> & {
	checkpoint: CheckpointData;
	onRestore?: (checkpoint: CheckpointData) => void;
};

export function CheckpointRestoreButton({
	className,
	checkpoint,
	onRestore: onRestoreProp,
	children,
	...props
}: CheckpointRestoreButtonProps) {
	const context = React.useContext(CheckpointContext);
	const handleRestore = onRestoreProp || context?.onRestoreCheckpoint;

	return (
		<Button
			variant="ghost"
			size="sm"
			className={cn("h-auto py-1 px-2 text-xs", className)}
			onClick={() => handleRestore?.(checkpoint)}
			{...props}
		>
			<RotateCcw className="h-3 w-3 mr-1" />
			{children || "Restore"}
		</Button>
	);
}

// ============================================================================
// Checkpoint History Popover
// ============================================================================

export type CheckpointHistoryProps = {
	className?: string;
	checkpoints?: CheckpointData[];
	onRestore?: (checkpoint: CheckpointData) => void;
	onDelete?: (checkpointId: string) => void;
};

export function CheckpointHistory({
	className,
	checkpoints: checkpointsProp,
	onRestore: onRestoreProp,
	onDelete: onDeleteProp,
}: CheckpointHistoryProps) {
	const context = React.useContext(CheckpointContext);
	const checkpoints = checkpointsProp || context?.checkpoints || [];
	const handleRestore = onRestoreProp || context?.onRestoreCheckpoint;
	const handleDelete = onDeleteProp || context?.onDeleteCheckpoint;

	if (checkpoints.length === 0) {
		return null;
	}

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className={cn("h-8 gap-1.5", className)}
				>
					<History className="h-4 w-4" />
					<span className="text-xs">{checkpoints.length}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-64 p-2" side="top" align="end">
				<div className="space-y-1">
					<div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
						Checkpoints
					</div>
					{checkpoints.map((cp) => (
						<div
							key={cp.id}
							className="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-muted/50 group"
						>
							<div className="flex items-center gap-2 flex-1 min-w-0">
								<BookmarkIcon className="h-3.5 w-3.5 text-primary shrink-0" />
								<div className="min-w-0">
									<div className="text-xs font-medium truncate">
										{cp.label ||
											`After message ${cp.messageIndex + 1}`}
									</div>
									<div className="text-[10px] text-muted-foreground">
										{formatRelativeTime(
											new Date(cp.timestamp),
										)}{" "}
										• {cp.messageCount} messages
									</div>
								</div>
							</div>
							<div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
								<Button
									variant="ghost"
									size="sm"
									className="h-6 w-6 p-0"
									onClick={() => handleRestore?.(cp)}
								>
									<RotateCcw className="h-3 w-3" />
								</Button>
								<Button
									variant="ghost"
									size="sm"
									className="h-6 w-6 p-0 text-destructive hover:text-destructive"
									onClick={() => handleDelete?.(cp.id)}
								>
									<Trash2 className="h-3 w-3" />
								</Button>
							</div>
						</div>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}
