"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { cn } from "@ui/lib";
import {
	CheckCircle2Icon,
	CheckIcon,
	ChevronDownIcon,
	CircleIcon,
	ClockIcon,
	CopyIcon,
	GripHorizontalIcon,
	GripVerticalIcon,
	Loader2Icon,
	MaximizeIcon,
	MinimizeIcon,
	SquareIcon,
	XCircleIcon,
	XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatDuration } from "../lib/format-duration";

const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 1200;
const DEFAULT_PANEL_WIDTH = 420;
const INITIAL_OFFSET_RIGHT = 20;
const INITIAL_OFFSET_TOP = 20;

interface ExecutionPanelProps {
	executionId: string;
	workflowId: string;
	onClose: () => void;
}

type ExecutionStatus =
	| "PENDING"
	| "RUNNING"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED"
	| "PAUSED";

type NodeStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED";

interface ExecutionLog {
	id: string;
	nodeId: string;
	nodeName?: string;
	nodeType: string;
	status: NodeStatus;
	input?: Record<string, unknown> | null;
	output?: Record<string, unknown> | null;
	error?: string | null;
	startedAt?: Date;
	completedAt?: Date | null;
	duration?: number | null;
}

const statusColors: Record<ExecutionStatus, string> = {
	PENDING: "bg-yellow-500",
	RUNNING: "bg-blue-500",
	COMPLETED: "bg-green-500",
	FAILED: "bg-red-500",
	CANCELLED: "bg-gray-500",
	PAUSED: "bg-orange-500",
};

const nodeStatusIcons: Record<NodeStatus, React.ReactNode> = {
	PENDING: <CircleIcon className="h-4 w-4 text-muted-foreground" />,
	RUNNING: <Loader2Icon className="h-4 w-4 text-blue-500 animate-spin" />,
	COMPLETED: <CheckCircle2Icon className="h-4 w-4 text-success" />,
	FAILED: <XCircleIcon className="h-4 w-4 text-destructive" />,
	SKIPPED: <CircleIcon className="h-4 w-4 text-gray-400" />,
};

/**
 * Copy button component with feedback
 */
function CopyButton({ text, className }: { text: string; className?: string }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Fallback for older browsers
			const textarea = document.createElement("textarea");
			textarea.value = text;
			document.body.appendChild(textarea);
			textarea.select();
			document.execCommand("copy");
			document.body.removeChild(textarea);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	};

	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			onClick={handleCopy}
			className={cn("h-6 px-2", className)}
			title={copied ? "Copied!" : "Copy to clipboard"}
		>
			{copied ? (
				<CheckIcon className="h-3 w-3 text-success" />
			) : (
				<CopyIcon className="h-3 w-3" />
			)}
		</Button>
	);
}

function NodeLogItem({ log }: { log: ExecutionLog }) {
	const [isOpen, setIsOpen] = useState(false);
	const hasInputOutput = log.input || log.output;

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen}>
			<div
				className={cn(
					"rounded-md bg-muted/50 overflow-hidden",
					log.status === "FAILED" && "bg-red-50 dark:bg-red-950/30",
				)}
			>
				<CollapsibleTrigger
					className="w-full flex items-start gap-3 p-3 hover:bg-muted/70 transition-colors cursor-pointer"
					disabled={!hasInputOutput}
				>
					<div className="mt-0.5">{nodeStatusIcons[log.status]}</div>
					<div className="flex-1 min-w-0 text-left">
						<div className="flex items-center gap-2">
							<p className="text-sm font-medium truncate">
								{log.nodeName || log.nodeId}
							</p>
							{log.duration && (
								<span className="flex items-center gap-1 text-xs text-muted-foreground">
									<ClockIcon className="h-3 w-3" />
									{formatDuration(log.duration)}
								</span>
							)}
						</div>
						<p className="text-xs text-muted-foreground">
							{log.nodeType}
						</p>
						{log.error && (
							<p className="text-xs text-destructive mt-1 line-clamp-2">
								{log.error}
							</p>
						)}
					</div>
					{hasInputOutput && (
						<ChevronDownIcon
							className={cn(
								"h-4 w-4 text-muted-foreground transition-transform",
								isOpen && "rotate-180",
							)}
						/>
					)}
				</CollapsibleTrigger>

				<CollapsibleContent>
					<div className="px-3 pb-3 space-y-3">
						{/* Input Section */}
						{log.input && Object.keys(log.input).length > 0 && (
							<div>
								<div className="flex items-center justify-between mb-1">
									<p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
										Input
									</p>
									<CopyButton
										text={JSON.stringify(
											log.input,
											null,
											2,
										)}
									/>
								</div>
								<pre className="max-h-48 overflow-auto rounded-md border bg-background p-3 text-xs font-mono whitespace-pre-wrap break-all">
									{JSON.stringify(log.input, null, 2)}
								</pre>
							</div>
						)}

						{/* Output Section */}
						{log.output && Object.keys(log.output).length > 0 && (
							<div>
								<div className="flex items-center justify-between mb-1">
									<p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
										Output
									</p>
									<CopyButton
										text={JSON.stringify(
											log.output,
											null,
											2,
										)}
									/>
								</div>
								<pre className="max-h-48 overflow-auto rounded-md border bg-background p-3 text-xs font-mono whitespace-pre-wrap break-all">
									{JSON.stringify(log.output, null, 2)}
								</pre>
							</div>
						)}

						{/* Error Details (if longer than the preview) */}
						{log.error && log.error.length > 100 && (
							<div>
								<div className="flex items-center justify-between mb-1">
									<p className="text-xs font-medium text-destructive uppercase tracking-wide">
										Error Details
									</p>
									<CopyButton text={log.error} />
								</div>
								<pre className="max-h-32 overflow-auto rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/50 p-2 text-xs text-destructive whitespace-pre-wrap break-all">
									{log.error}
								</pre>
							</div>
						)}
					</div>
				</CollapsibleContent>
			</div>
		</Collapsible>
	);
}

export function ExecutionPanel({
	executionId,
	workflowId: _workflowId,
	onClose,
}: ExecutionPanelProps) {
	const { organizationId } = useOrganizationContext();
	const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
	const [isResizing, setIsResizing] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
	const [position, setPosition] = useState({ x: 0, y: INITIAL_OFFSET_TOP });
	const [hasInitialized, setHasInitialized] = useState(false);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);
	const dragStartRef = useRef({ x: 0, y: 0, posX: 0, posY: 0 });

	// Initialize position on mount (right side of viewport)
	useEffect(() => {
		if (!hasInitialized && typeof window !== "undefined") {
			setPosition({
				x:
					window.innerWidth -
					DEFAULT_PANEL_WIDTH -
					INITIAL_OFFSET_RIGHT,
				y: INITIAL_OFFSET_TOP,
			});
			setHasInitialized(true);
		}
	}, [hasInitialized]);

	// Fetch execution data with polling
	const { data, isLoading, refetch } = useQuery(
		orpc.workflows.executions.get.queryOptions({
			input: { executionId, organizationId },
		}),
	);

	const cancelMutation = useMutation({
		mutationFn: async () =>
			await orpcClient.workflows.executions.cancel({
				executionId,
				organizationId,
			}),
		onSuccess: (result) => {
			// The workflow writes its own terminal state on the way out, so
			// refetch rather than guessing at the status here.
			refetch();
			toast.success(result.message ?? "Cancellation requested");
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to cancel execution",
			);
		},
	});

	const handleCancel = useCallback(() => {
		cancelMutation.mutate();
	}, [cancelMutation]);

	// Handle drag start
	const handleDragStart = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			setIsDragging(true);
			dragStartRef.current = {
				x: e.clientX,
				y: e.clientY,
				posX: position.x,
				posY: position.y,
			};
		},
		[position],
	);

	// Handle resize start
	const handleResizeStart = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsResizing(true);
	}, []);

	// Handle drag move and end
	useEffect(() => {
		if (!isDragging) {
			return;
		}

		const handleMouseMove = (e: MouseEvent) => {
			const deltaX = e.clientX - dragStartRef.current.x;
			const deltaY = e.clientY - dragStartRef.current.y;

			// Calculate new position with bounds checking
			const newX = Math.max(
				0,
				Math.min(
					window.innerWidth - panelWidth,
					dragStartRef.current.posX + deltaX,
				),
			);
			const newY = Math.max(
				0,
				Math.min(
					window.innerHeight - 100, // Keep at least 100px visible
					dragStartRef.current.posY + deltaY,
				),
			);

			setPosition({ x: newX, y: newY });
		};

		const handleMouseUp = () => {
			setIsDragging(false);
		};

		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);

		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
		};
	}, [isDragging, panelWidth]);

	// Handle resize move and end
	useEffect(() => {
		if (!isResizing) {
			return;
		}

		const handleMouseMove = (e: MouseEvent) => {
			if (!panelRef.current) {
				return;
			}
			const panelRect = panelRef.current.getBoundingClientRect();
			const newWidth = panelRect.right - e.clientX;
			const clampedWidth = Math.min(
				MAX_PANEL_WIDTH,
				Math.max(MIN_PANEL_WIDTH, newWidth),
			);

			// Adjust position to keep right edge in place
			const widthDelta = clampedWidth - panelWidth;
			setPosition((prev) => ({
				...prev,
				x: Math.max(0, prev.x - widthDelta),
			}));
			setPanelWidth(clampedWidth);
		};

		const handleMouseUp = () => {
			setIsResizing(false);
		};

		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);

		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
		};
	}, [isResizing, panelWidth]);

	// Poll for updates while execution is running
	useEffect(() => {
		if (!data?.execution) {
			return;
		}

		const status = data.execution.status as ExecutionStatus;
		if (status === "RUNNING" || status === "PENDING") {
			const interval = setInterval(() => {
				refetch();
			}, 2000);
			return () => clearInterval(interval);
		}
	}, [data?.execution, refetch]);

	// Common overlay styles - fullscreen overrides position and size
	const overlayStyles = isFullscreen
		? {
				width: "100vw",
				height: "100vh",
				left: 0,
				top: 0,
				maxHeight: "100vh",
				borderRadius: 0,
			}
		: {
				width: panelWidth,
				left: position.x,
				top: position.y,
				maxHeight: "calc(100vh - 40px)",
			};

	if (isLoading) {
		return (
			<div
				ref={panelRef}
				style={overlayStyles}
				className="fixed z-50 bg-background border rounded-lg shadow-2xl flex items-center justify-center h-64"
			>
				<Spinner className="h-6 w-6" />
			</div>
		);
	}

	if (!data?.execution) {
		return (
			<div
				ref={panelRef}
				style={overlayStyles}
				className="fixed z-50 bg-background border rounded-lg shadow-2xl p-4"
			>
				<p className="text-muted-foreground">Execution not found</p>
			</div>
		);
	}

	const execution = data.execution;
	const status = execution.status as ExecutionStatus;
	// Only an in-flight run can be cancelled; the button is absent otherwise
	// rather than disabled, so there is nothing to click on a finished run.
	const isActive = status === "RUNNING" || status === "PENDING";
	const logs = (execution.logs || []) as unknown as ExecutionLog[];

	// Calculate total duration
	const totalDuration = logs.reduce(
		(sum, log) => sum + (log.duration || 0),
		0,
	);

	return (
		<div
			ref={panelRef}
			style={overlayStyles}
			className={cn(
				"fixed z-50 bg-background border shadow-2xl flex flex-col overflow-hidden",
				!isFullscreen && "rounded-lg",
				(isDragging || isResizing) && "select-none",
			)}
		>
			{/* Resize Handle - hidden in fullscreen */}
			{!isFullscreen && (
				/* biome-ignore lint/a11y/useSemanticElements: Custom resize handle requires div for styling */
				<div
					role="separator"
					aria-orientation="vertical"
					aria-valuenow={panelWidth}
					aria-valuemin={MIN_PANEL_WIDTH}
					aria-valuemax={MAX_PANEL_WIDTH}
					aria-label="Resize execution panel"
					tabIndex={0}
					className={cn(
						"absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize group hover:bg-primary/20 transition-colors z-10 rounded-l-lg",
						isResizing && "bg-primary/30",
					)}
					onMouseDown={handleResizeStart}
					onKeyDown={(e) => {
						if (e.key === "ArrowLeft") {
							const newWidth = Math.min(
								MAX_PANEL_WIDTH,
								panelWidth + 20,
							);
							setPosition((prev) => ({
								...prev,
								x: Math.max(0, prev.x - 20),
							}));
							setPanelWidth(newWidth);
						} else if (e.key === "ArrowRight") {
							const newWidth = Math.max(
								MIN_PANEL_WIDTH,
								panelWidth - 20,
							);
							setPosition((prev) => ({
								...prev,
								x: prev.x + 20,
							}));
							setPanelWidth(newWidth);
						}
					}}
				>
					<div
						className={cn(
							"absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 p-1 rounded bg-muted border opacity-0 group-hover:opacity-100 transition-opacity",
							isResizing && "opacity-100",
						)}
					>
						<GripVerticalIcon className="h-4 w-4 text-muted-foreground" />
					</div>
				</div>
			)}

			{/* Header - draggable only when not fullscreen */}
			<div
				role="toolbar"
				aria-label={
					isFullscreen ? "Panel header" : "Drag to reposition panel"
				}
				className={cn(
					"p-4 border-b flex items-center justify-between shrink-0",
					!isFullscreen && "cursor-grab rounded-t-lg",
					isDragging &&
						!isFullscreen &&
						"cursor-grabbing bg-muted/50",
				)}
				onMouseDown={isFullscreen ? undefined : handleDragStart}
			>
				<div className="flex items-center gap-3">
					{!isFullscreen && (
						<GripHorizontalIcon className="h-4 w-4 text-muted-foreground" />
					)}
					<div>
						<h3 className="font-semibold">Execution Details</h3>
						<div className="flex items-center gap-2 mt-1">
							<Badge className={statusColors[status]}>
								{status}
							</Badge>
							{totalDuration > 0 && (
								<span className="flex items-center gap-1 text-xs text-muted-foreground">
									<ClockIcon className="h-3 w-3" />
									{formatDuration(totalDuration)}
								</span>
							)}
						</div>
					</div>
				</div>
				<div className="flex items-center gap-1">
					{isActive && (
						<Button
							variant="outline"
							size="sm"
							onClick={handleCancel}
							onMouseDown={(e) => e.stopPropagation()}
							disabled={cancelMutation.isPending}
							title="Stop this run"
							data-testid="execution-cancel"
						>
							<SquareIcon className="h-3.5 w-3.5 mr-1.5" />
							{cancelMutation.isPending
								? "Cancelling…"
								: "Cancel"}
						</Button>
					)}
					<Button
						variant="ghost"
						size="icon"
						onClick={() => setIsFullscreen(!isFullscreen)}
						onMouseDown={(e) => e.stopPropagation()}
						title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
					>
						{isFullscreen ? (
							<MinimizeIcon className="h-4 w-4" />
						) : (
							<MaximizeIcon className="h-4 w-4" />
						)}
					</Button>
					<Button
						variant="ghost"
						size="icon"
						onClick={onClose}
						onMouseDown={(e) => e.stopPropagation()}
					>
						<XIcon className="h-4 w-4" />
					</Button>
				</div>
			</div>

			{/* Scrollable Content Area - always show scrollbar */}
			<div className="flex-1 min-h-0 overflow-y-auto">
				<div className="flex flex-col">
					{/* Node Logs */}
					<div className="p-4 space-y-2">
						{logs.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								{status === "PENDING" || status === "RUNNING"
									? "Waiting for execution to start..."
									: "No execution logs"}
							</p>
						) : (
							<>
								<p className="text-xs text-muted-foreground mb-3">
									{logs.length} node
									{logs.length !== 1 ? "s" : ""} executed •
									Click to expand input/output
								</p>
								{logs.map((log) => (
									<NodeLogItem key={log.id} log={log} />
								))}
							</>
						)}
					</div>

					{/* Overall Output (if available) */}
					{execution.output && (
						<div className="border-t p-4">
							<Collapsible>
								<div className="flex items-center justify-between">
									<CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium">
										<ChevronDownIcon className="h-4 w-4" />
										Final Workflow Output
									</CollapsibleTrigger>
									<CopyButton
										text={JSON.stringify(
											execution.output,
											null,
											2,
										)}
									/>
								</div>
								<CollapsibleContent>
									<pre className="mt-2 max-h-64 overflow-auto rounded-md border bg-muted/50 p-3 text-xs font-mono whitespace-pre-wrap break-all">
										{JSON.stringify(
											execution.output,
											null,
											2,
										)}
									</pre>
								</CollapsibleContent>
							</Collapsible>
						</div>
					)}

					{/* Error Footer */}
					{execution.error && (
						<div className="p-4 border-t bg-red-50 dark:bg-red-950">
							<div className="flex items-center justify-between mb-1">
								<p className="text-sm font-medium text-destructive">
									Execution Failed
								</p>
								<CopyButton text={execution.error} />
							</div>
							<p className="text-xs text-destructive whitespace-pre-wrap">
								{execution.error}
							</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
