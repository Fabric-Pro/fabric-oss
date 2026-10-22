"use client";

import { isWorkflowLive } from "@repo/utils/workflow-status";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ArrowLeftIcon,
	DownloadIcon,
	HistoryIcon,
	PencilIcon,
	PlayIcon,
	RedoIcon,
	RocketIcon,
	UndoIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import {
	WORKFLOW_STATUS_DISPLAY,
	type WorkflowStatus,
} from "../../lib/workflow-status-display";

function ToolbarIconButton({
	label,
	shortcut,
	onClick,
	disabled,
	children,
}: {
	label: string;
	shortcut?: string;
	onClick: () => void;
	disabled?: boolean;
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={label}
					onClick={onClick}
					disabled={disabled}
					className="flex h-7 w-[30px] items-center justify-center rounded-md text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:text-muted-foreground/60 motion-safe:transition-colors"
				>
					{children}
				</button>
			</TooltipTrigger>
			<TooltipContent>
				{label}
				{shortcut ? (
					<span className="ml-2 font-mono text-[11px] opacity-70">
						{shortcut}
					</span>
				) : null}
			</TooltipContent>
		</Tooltip>
	);
}

/** "Published · v3", "Draft · v4": the status and the version it describes. */
export function WorkflowStatusPill({
	status,
	version,
	publishedVersion,
	className,
}: {
	status: WorkflowStatus;
	version: number;
	publishedVersion?: number | null;
	className?: string;
}) {
	const display = WORKFLOW_STATUS_DISPLAY[status];
	const shownVersion = isWorkflowLive(status)
		? (publishedVersion ?? version)
		: version;
	return (
		<span
			className={cn(
				"flex h-6 shrink-0 items-center gap-1.5 rounded-full border bg-muted px-2.5 text-xs",
				className,
			)}
		>
			<span
				className={cn("size-1.5 rounded-full", display.dot)}
				aria-hidden="true"
			/>
			{display.label} · v{shownVersion}
		</span>
	);
}

function WorkflowTitle({
	workflowName,
	onRename,
}: {
	workflowName: string;
	onRename?: (name: string) => void;
}) {
	const tTooltips = useTranslations("tooltips.common");
	const [isEditing, setIsEditing] = useState(false);
	const [draft, setDraft] = useState(workflowName);

	useEffect(() => {
		setDraft(workflowName);
	}, [workflowName]);

	const commit = () => {
		const name = draft.trim();
		if (name && name !== workflowName) {
			onRename?.(name);
		}
		setIsEditing(false);
	};

	if (isEditing) {
		return (
			<Input
				aria-label="Workflow name"
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						commit();
					} else if (e.key === "Escape") {
						setDraft(workflowName);
						setIsEditing(false);
					}
				}}
				onBlur={commit}
				autoFocus
				className="h-8 min-w-0 max-w-md flex-1"
			/>
		);
	}

	return (
		<>
			<span
				title={workflowName}
				className="min-w-0 truncate text-[15px] font-medium"
			>
				{workflowName}
			</span>
			{onRename ? (
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={() => setIsEditing(true)}
							className="flex shrink-0 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
							aria-label="Rename workflow"
						>
							<PencilIcon
								className="size-3.5"
								aria-hidden="true"
							/>
						</button>
					</TooltipTrigger>
					<TooltipContent>
						{tTooltips("clickToRename", { subject: "workflow" })}
					</TooltipContent>
				</Tooltip>
			) : null}
		</>
	);
}

interface EditorHeaderProps {
	workflowsPath: string;
	workflowName: string;
	onRename?: (name: string) => void;
	status: WorkflowStatus;
	version: number;
	publishedVersion?: number | null;
	canUndo: boolean;
	canRedo: boolean;
	onUndo: () => void;
	onRedo: () => void;
	/** Absent until the workflow has been saved once. */
	onOpenVersions?: () => void;
	onExport: () => void;
	onSave: () => void;
	/** Absent until the workflow has been saved once. */
	onPublish?: () => void;
	onRun: () => void;
	hasSteps: boolean;
	isBusy: boolean;
}

/**
 * The editor's single-line header: where you are and what the workflow is
 * on the left, history tools in one group, then Save, Publish and Run.
 */
export function EditorHeader({
	workflowsPath,
	workflowName,
	onRename,
	status,
	version,
	publishedVersion,
	canUndo,
	canRedo,
	onUndo,
	onRedo,
	onOpenVersions,
	onExport,
	onSave,
	onPublish,
	onRun,
	hasSteps,
	isBusy,
}: EditorHeaderProps) {
	return (
		<header className="flex h-[52px] shrink-0 items-center gap-3 border-b bg-background pl-2 pr-3">
			<Tooltip>
				<TooltipTrigger asChild>
					<Link
						href={workflowsPath}
						aria-label="Back to workflows"
						className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
					>
						<ArrowLeftIcon className="size-4" aria-hidden="true" />
					</Link>
				</TooltipTrigger>
				<TooltipContent>Back to workflows</TooltipContent>
			</Tooltip>

			<nav
				aria-label="Breadcrumb"
				className="flex min-w-0 flex-1 items-center gap-2"
			>
				<Link
					href={workflowsPath}
					className="shrink-0 text-[13px] text-muted-foreground hover:text-foreground"
				>
					Workflows
				</Link>
				<span
					className="shrink-0 text-muted-foreground/60"
					aria-hidden="true"
				>
					/
				</span>
				<WorkflowTitle
					workflowName={workflowName}
					onRename={onRename}
				/>
				<WorkflowStatusPill
					status={status}
					version={version}
					publishedVersion={publishedVersion}
				/>
			</nav>

			<div className="flex shrink-0 items-center gap-0.5 rounded-lg border p-0.5">
				<ToolbarIconButton
					label="Undo"
					shortcut="⌘Z"
					onClick={onUndo}
					disabled={!canUndo}
				>
					<UndoIcon className="size-[15px]" aria-hidden="true" />
				</ToolbarIconButton>
				<ToolbarIconButton
					label="Redo"
					shortcut="⌘⇧Z"
					onClick={onRedo}
					disabled={!canRedo}
				>
					<RedoIcon className="size-[15px]" aria-hidden="true" />
				</ToolbarIconButton>
				<span
					className="mx-0.5 h-4 w-px bg-border"
					aria-hidden="true"
				/>
				<button
					type="button"
					onClick={onOpenVersions}
					disabled={!onOpenVersions}
					className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:text-muted-foreground/60 motion-safe:transition-colors"
				>
					<HistoryIcon className="size-[15px]" aria-hidden="true" />
					Versions
				</button>
				<ToolbarIconButton
					label="Export as JSON"
					onClick={onExport}
					disabled={!hasSteps}
				>
					<DownloadIcon className="size-[15px]" aria-hidden="true" />
				</ToolbarIconButton>
			</div>

			<Button
				variant="outline"
				size="sm"
				onClick={onSave}
				disabled={isBusy || !hasSteps}
				data-testid="workflow-save"
				aria-keyshortcuts="Meta+S Control+S"
				className="rounded-lg"
			>
				Save
				<span
					className="font-mono text-[11px] text-muted-foreground"
					aria-hidden="true"
				>
					⌘S
				</span>
			</Button>
			<Button
				variant="secondary"
				size="sm"
				onClick={onPublish}
				disabled={isBusy || !hasSteps || !onPublish}
				className="rounded-lg"
			>
				<RocketIcon className="size-[15px]" aria-hidden="true" />
				Publish v{version + 1}
			</Button>
			<Button
				size="sm"
				onClick={onRun}
				disabled={isBusy || !hasSteps}
				data-testid="workflow-run"
				className="rounded-lg"
			>
				<PlayIcon className="size-3.5" aria-hidden="true" />
				Run
			</Button>
		</header>
	);
}
