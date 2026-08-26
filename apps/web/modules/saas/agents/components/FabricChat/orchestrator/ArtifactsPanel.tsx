"use client";

/**
 * ArtifactsPanel Component
 *
 * A slide-out panel that displays execution artifacts including:
 * - Execution plan and progress
 * - Generated documents
 * - Sources/references used
 * - Other artifacts (code, data, etc.)
 *
 * Based on AI SDK Elements best practices for artifact display.
 * Supports drag-to-resize functionality.
 */

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { ScrollArea } from "@ui/components/scroll-area";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	BookOpen,
	CheckCircle2,
	ChevronRight,
	Circle,
	Clock,
	Code2,
	Copy,
	Database,
	Download,
	ExternalLink,
	File,
	FileCode,
	FileText,
	Folder,
	Globe,
	GripVertical,
	ListTree,
	Loader2,
	PanelRightOpen,
	ShieldAlert,
	X,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

// =============================================================================
// Types
// =============================================================================

interface ExecutionPlanStep {
	id: string;
	description: string;
	status:
		| "pending"
		| "in_progress"
		| "complete"
		| "error"
		| "skipped"
		| "awaiting_approval";
	order: number;
	executor?: string;
	riskLevel?: "low" | "medium" | "high" | "critical";
	requiresApproval?: boolean;
	durationMs?: number;
}

interface ExecutionPlan {
	id: string;
	description?: string;
	riskLevel?: string;
	steps: ExecutionPlanStep[];
}

export interface DocumentArtifact {
	id: string;
	title: string;
	type: "markdown" | "html" | "code" | "json" | "text";
	content: string;
	language?: string;
	createdAt?: string;
	metadata?: Record<string, unknown>;
}

export interface SourceReference {
	id: string;
	title: string;
	type: "workspace" | "web" | "memory" | "document" | "code";
	url?: string;
	excerpt?: string;
	confidence?: number;
	metadata?: Record<string, unknown>;
}

export interface ArtifactsPanelProps {
	isOpen: boolean;
	onClose: () => void;
	plan?: ExecutionPlan | null;
	currentStepId?: string;
	completedSteps?: number;
	totalSteps?: number;
	documents?: DocumentArtifact[];
	sources?: SourceReference[];
	className?: string;
	defaultTab?: "plan" | "documents" | "sources";
}

// =============================================================================
// Sub-Components
// =============================================================================

function PlanStepItem({
	step,
	isCurrent,
}: {
	step: ExecutionPlanStep;
	isCurrent: boolean;
}) {
	const getStatusIcon = () => {
		switch (step.status) {
			case "complete":
				return <CheckCircle2 className="size-4 text-success" />;
			case "in_progress":
				return (
					<Loader2 className="size-4 text-blue-500 animate-spin" />
				);
			case "error":
				return <X className="size-4 text-destructive" />;
			case "skipped":
				return <Circle className="size-4 text-muted-foreground" />;
			case "awaiting_approval":
				return <ShieldAlert className="size-4 text-yellow-500" />;
			default:
				return <Circle className="size-4 text-muted-foreground/50" />;
		}
	};

	const getRiskBadge = () => {
		if (!step.riskLevel || step.riskLevel === "low") {
			return null;
		}
		const colors = {
			medium: "bg-yellow-500/10 text-highlight border-yellow-500/20",
			high: "bg-orange-500/10 text-highlight border-orange-500/20",
			critical: "bg-red-500/10 text-destructive border-red-500/20",
		};
		return (
			<Badge
				variant="outline"
				className={cn(
					"text-[10px] px-1 py-0",
					colors[step.riskLevel as keyof typeof colors],
				)}
			>
				{step.riskLevel}
			</Badge>
		);
	};

	return (
		<div
			className={cn(
				"flex items-start gap-3 p-3 rounded-lg transition-colors",
				isCurrent && "bg-primary/5 border border-primary/20",
				step.status === "error" && "bg-red-500/5",
			)}
		>
			<div className="mt-0.5">{getStatusIcon()}</div>
			<div className="flex-1 min-w-0">
				<div className="flex items-start justify-between gap-2">
					<p
						className={cn(
							"text-sm",
							step.status === "complete" &&
								"text-muted-foreground",
						)}
					>
						{step.description}
					</p>
					{getRiskBadge()}
				</div>
				<div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
					{step.executor && (
						<span className="flex items-center gap-1">
							<Zap className="size-3" />
							{step.executor}
						</span>
					)}
					{step.durationMs && step.status === "complete" && (
						<span className="flex items-center gap-1">
							<Clock className="size-3" />
							{(step.durationMs / 1000).toFixed(1)}s
						</span>
					)}
				</div>
			</div>
		</div>
	);
}

function DocumentItem({
	document,
	onView,
}: {
	document: DocumentArtifact;
	onView: () => void;
}) {
	const [isExpanded, setIsExpanded] = useState(false);
	const [showRaw, setShowRaw] = useState(false);

	const getIcon = () => {
		switch (document.type) {
			case "markdown":
				return <FileText className="size-4 text-blue-500" />;
			case "code":
				return <FileCode className="size-4 text-purple-500" />;
			case "json":
				return <Database className="size-4 text-success" />;
			case "html":
				return <Globe className="size-4 text-orange-500" />;
			default:
				return <File className="size-4 text-muted-foreground" />;
		}
	};

	// Format JSON content nicely
	const formatContent = (content: string, type: string) => {
		if (type === "json") {
			try {
				const parsed = JSON.parse(content);
				return JSON.stringify(parsed, null, 2);
			} catch {
				return content;
			}
		}
		return content;
	};

	const formattedContent = formatContent(document.content, document.type);
	const previewLength = 300;
	const hasLongContent = document.content.length > previewLength;

	return (
		<div className="rounded-lg border bg-card overflow-hidden">
			{/* Header */}
			<div className="flex items-start gap-3 p-3 hover:bg-accent/50 transition-colors">
				<div className="mt-0.5">{getIcon()}</div>
				<div className="flex-1 min-w-0">
					<div className="flex items-start justify-between gap-2">
						<button
							type="button"
							onClick={() => setIsExpanded(!isExpanded)}
							className="font-medium text-sm truncate text-left hover:underline"
						>
							{document.title}
						</button>
						<div className="flex items-center gap-1">
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											variant="ghost"
											size="sm"
											className="size-7 p-0"
											onClick={onView}
										>
											<ExternalLink className="size-3.5" />
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										View full screen
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											variant="ghost"
											size="sm"
											className="size-7 p-0"
											onClick={() =>
												navigator.clipboard.writeText(
													document.content,
												)
											}
										>
											<Copy className="size-3.5" />
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										Copy content
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											variant="ghost"
											size="sm"
											className="size-7 p-0"
											onClick={() =>
												downloadDocument(document)
											}
										>
											<Download className="size-3.5" />
										</Button>
									</TooltipTrigger>
									<TooltipContent>Download</TooltipContent>
								</Tooltip>
							</TooltipProvider>
						</div>
					</div>
					<div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
						<Badge
							variant="secondary"
							className="text-[10px] px-1.5 py-0"
						>
							{document.type}
						</Badge>
						{document.language && (
							<Badge
								variant="outline"
								className="text-[10px] px-1.5 py-0"
							>
								{document.language}
							</Badge>
						)}
						<button
							type="button"
							onClick={() => setIsExpanded(!isExpanded)}
							className="flex items-center gap-1 text-primary hover:underline"
						>
							{isExpanded ? (
								<>
									<ChevronRight className="size-3 rotate-90" />
									Collapse
								</>
							) : (
								<>
									<ChevronRight className="size-3" />
									Preview
								</>
							)}
						</button>
					</div>
				</div>
			</div>

			{/* Expandable Content Preview */}
			{isExpanded && (
				<div className="border-t">
					{/* Raw toggle */}
					<div className="flex items-center justify-end gap-2 px-3 py-1.5 bg-muted/30 border-b">
						<span className="text-[10px] text-muted-foreground">
							View:
						</span>
						<button
							type="button"
							onClick={() => setShowRaw(false)}
							className={cn(
								"text-[10px] px-2 py-0.5 rounded",
								!showRaw
									? "bg-primary text-primary-foreground"
									: "hover:bg-muted",
							)}
						>
							Formatted
						</button>
						<button
							type="button"
							onClick={() => setShowRaw(true)}
							className={cn(
								"text-[10px] px-2 py-0.5 rounded",
								showRaw
									? "bg-primary text-primary-foreground"
									: "hover:bg-muted",
							)}
						>
							Raw
						</button>
					</div>

					{/* Content */}
					<div className="p-3 max-h-64 overflow-auto">
						{showRaw ? (
							<pre className="text-xs font-mono whitespace-pre-wrap break-all">
								{hasLongContent && !isExpanded
									? `${document.content.slice(0, previewLength)}...`
									: formattedContent}
							</pre>
						) : document.type === "json" ? (
							<pre className="text-xs font-mono bg-muted p-2 rounded overflow-x-auto">
								{formattedContent}
							</pre>
						) : document.type === "code" ? (
							<pre className="text-xs font-mono bg-muted p-2 rounded overflow-x-auto">
								<code>{document.content}</code>
							</pre>
						) : (
							<div className="prose prose-sm dark:prose-invert max-w-none text-xs">
								<div className="whitespace-pre-wrap">
									{document.content}
								</div>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * Download a document artifact as a file
 */
function downloadDocument(document: DocumentArtifact) {
	const mimeTypes: Record<string, string> = {
		markdown: "text/markdown",
		html: "text/html",
		code: "text/plain",
		json: "application/json",
		text: "text/plain",
	};
	const extensions: Record<string, string> = {
		markdown: "md",
		html: "html",
		code: document.language || "txt",
		json: "json",
		text: "txt",
	};

	const mimeType = mimeTypes[document.type] || "text/plain";
	const extension = extensions[document.type] || "txt";
	const filename = `${document.title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}.${extension}`;

	const blob = new Blob([document.content], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const a = window.document.createElement("a");
	a.href = url;
	a.download = filename;
	window.document.body.appendChild(a);
	a.click();
	window.document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

function SourceItem({ source }: { source: SourceReference }) {
	const getIcon = () => {
		switch (source.type) {
			case "workspace":
				return <Folder className="size-4 text-blue-500" />;
			case "web":
				return <Globe className="size-4 text-success" />;
			case "memory":
				return <Database className="size-4 text-purple-500" />;
			case "document":
				return <FileText className="size-4 text-orange-500" />;
			case "code":
				return <Code2 className="size-4 text-pink-500" />;
			default:
				return <File className="size-4 text-muted-foreground" />;
		}
	};

	// Extract meaningful display info from metadata
	const getSourceDetails = () => {
		const metadata = source.metadata || {};
		const details: string[] = [];

		// Show actual file/document name if available
		if (metadata.fileName) {
			details.push(String(metadata.fileName));
		}
		if (metadata.documentName) {
			details.push(String(metadata.documentName));
		}
		if (metadata.toolName) {
			details.push(`Tool: ${metadata.toolName}`);
		}
		if (metadata.agentId) {
			details.push(`Agent: ${metadata.agentId}`);
		}
		if (metadata.serverName) {
			details.push(`Server: ${metadata.serverName}`);
		}
		if (metadata.workspaceName) {
			details.push(`Workspace: ${metadata.workspaceName}`);
		}

		return details;
	};

	const sourceDetails = getSourceDetails();

	// Format URL for display
	const getDisplayUrl = () => {
		if (!source.url) {
			return null;
		}
		try {
			const url = new URL(source.url);
			return url.hostname + (url.pathname !== "/" ? url.pathname : "");
		} catch {
			return (
				source.url.slice(0, 50) + (source.url.length > 50 ? "..." : "")
			);
		}
	};

	const displayUrl = getDisplayUrl();

	return (
		<div className="flex items-start gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors">
			<div className="mt-0.5">{getIcon()}</div>
			<div className="flex-1 min-w-0">
				<div className="flex items-start justify-between gap-2">
					<p className="font-medium text-sm">{source.title}</p>
					{source.url && (
						<a
							href={source.url}
							target="_blank"
							rel="noopener noreferrer"
							className="text-primary hover:text-primary/80 transition-colors shrink-0"
						>
							<ExternalLink className="size-3.5" />
						</a>
					)}
				</div>

				{/* Show URL if available */}
				{displayUrl && (
					<p className="text-[10px] text-blue-600 dark:text-blue-400 mt-0.5 truncate">
						{displayUrl}
					</p>
				)}

				{/* Show source details from metadata */}
				{sourceDetails.length > 0 && (
					<div className="flex flex-wrap items-center gap-1 mt-1">
						{sourceDetails.map((detail, idx) => (
							<span
								key={idx}
								className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded"
							>
								{detail}
							</span>
						))}
					</div>
				)}

				{source.excerpt && (
					<p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">
						{source.excerpt}
					</p>
				)}
				<div className="flex items-center gap-2 mt-2">
					<Badge
						variant="secondary"
						className="text-[10px] px-1.5 py-0"
					>
						{source.type}
					</Badge>
					{source.confidence !== undefined && (
						<span className="text-[10px] text-muted-foreground">
							{Math.round(source.confidence * 100)}% match
						</span>
					)}
				</div>
			</div>
		</div>
	);
}

// =============================================================================
// Main Component
// =============================================================================

export function ArtifactsPanel({
	isOpen,
	onClose,
	plan,
	currentStepId,
	completedSteps = 0,
	totalSteps = 0,
	documents = [],
	sources = [],
	className,
	defaultTab = "plan",
}: ArtifactsPanelProps) {
	const [activeTab, setActiveTab] = useState(defaultTab);
	const [selectedDocument, setSelectedDocument] =
		useState<DocumentArtifact | null>(null);

	// Resizable panel state
	const [panelWidth, setPanelWidth] = useState(540);
	const [isResizing, setIsResizing] = useState(false);
	const resizeRef = useRef<HTMLButtonElement>(null);
	const startXRef = useRef(0);
	const startWidthRef = useRef(0);

	const MIN_WIDTH = 320;
	const MAX_WIDTH = 900;

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			setIsResizing(true);
			startXRef.current = e.clientX;
			startWidthRef.current = panelWidth;
		},
		[panelWidth],
	);

	useEffect(() => {
		const handleMouseMove = (e: MouseEvent) => {
			if (!isResizing) {
				return;
			}

			// Calculate new width (dragging left increases width for right-side panel)
			const delta = startXRef.current - e.clientX;
			const newWidth = Math.min(
				MAX_WIDTH,
				Math.max(MIN_WIDTH, startWidthRef.current + delta),
			);
			setPanelWidth(newWidth);
		};

		const handleMouseUp = () => {
			setIsResizing(false);
		};

		if (isResizing) {
			document.addEventListener("mousemove", handleMouseMove);
			document.addEventListener("mouseup", handleMouseUp);
			// Prevent text selection while resizing
			document.body.style.userSelect = "none";
			document.body.style.cursor = "col-resize";
		}

		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
			document.body.style.userSelect = "";
			document.body.style.cursor = "";
		};
	}, [isResizing]);

	// Calculate progress
	const progress =
		totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

	// Count items per tab for badges
	const planStepsCount = plan?.steps.length || 0;
	const documentsCount = documents.length;
	const sourcesCount = sources.length;

	return (
		<>
			<Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
				<SheetContent
					side="right"
					className={cn("p-0 transition-none", className)}
					style={{ width: `${panelWidth}px`, maxWidth: "90vw" }}
				>
					{/* Resize Handle */}
					<button
						ref={resizeRef}
						type="button"
						aria-label="Resize artifacts panel"
						onMouseDown={handleMouseDown}
						className={cn(
							"absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-50",
							"hover:bg-primary/20 active:bg-primary/30 transition-colors",
							"flex items-center justify-center group",
							isResizing && "bg-primary/30",
						)}
					>
						<div
							className={cn(
								"absolute left-0 w-4 h-12 flex items-center justify-center",
								"opacity-0 group-hover:opacity-100 transition-opacity",
								isResizing && "opacity-100",
							)}
						>
							<GripVertical className="size-4 text-muted-foreground" />
						</div>
					</button>

					<div className="flex flex-col h-full">
						<SheetHeader className="px-4 py-3 border-b">
							<SheetTitle className="text-base font-semibold">
								Artifacts
							</SheetTitle>
						</SheetHeader>

						<Tabs
							value={activeTab}
							onValueChange={(v) =>
								setActiveTab(v as typeof activeTab)
							}
							className="flex-1 flex flex-col min-h-0"
						>
							<div className="border-b px-4">
								<TabsList className="h-10 w-full justify-start gap-2 bg-transparent p-0">
									<TabsTrigger
										value="plan"
										className="relative h-10 rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-3"
									>
										<ListTree className="size-4 mr-1.5" />
										Plan
										{planStepsCount > 0 && (
											<Badge
												variant="secondary"
												className="ml-1.5 text-[10px] px-1.5 py-0"
											>
												{completedSteps}/
												{planStepsCount}
											</Badge>
										)}
									</TabsTrigger>
									<TabsTrigger
										value="documents"
										className="relative h-10 rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-3"
									>
										<FileText className="size-4 mr-1.5" />
										Documents
										{documentsCount > 0 && (
											<Badge
												variant="secondary"
												className="ml-1.5 text-[10px] px-1.5 py-0"
											>
												{documentsCount}
											</Badge>
										)}
									</TabsTrigger>
									<TabsTrigger
										value="sources"
										className="relative h-10 rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-3"
									>
										<BookOpen className="size-4 mr-1.5" />
										Sources
										{sourcesCount > 0 && (
											<Badge
												variant="secondary"
												className="ml-1.5 text-[10px] px-1.5 py-0"
											>
												{sourcesCount}
											</Badge>
										)}
									</TabsTrigger>
								</TabsList>
							</div>

							<TabsContent
								value="plan"
								className="flex-1 m-0 overflow-hidden"
							>
								<ScrollArea className="h-full">
									<div className="p-4 space-y-4">
										{plan ? (
											<>
												{/* Progress header */}
												<div className="space-y-2">
													{plan.description && (
														<p className="text-sm text-muted-foreground">
															{plan.description}
														</p>
													)}
													<div className="flex items-center gap-3">
														<div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
															<div
																className="h-full bg-primary transition-all duration-300"
																style={{
																	width: `${progress}%`,
																}}
															/>
														</div>
														<span className="text-xs text-muted-foreground font-medium">
															{progress}%
														</span>
													</div>
												</div>

												{/* Steps list */}
												<div className="space-y-2">
													{plan.steps.map((step) => (
														<PlanStepItem
															key={step.id}
															step={step}
															isCurrent={
																step.id ===
																currentStepId
															}
														/>
													))}
												</div>
											</>
										) : (
											<div className="text-center py-8 text-muted-foreground">
												<ListTree className="size-8 mx-auto mb-2 opacity-50" />
												<p className="text-sm">
													No execution plan yet
												</p>
												<p className="text-xs mt-1">
													Send a message to generate a
													plan
												</p>
											</div>
										)}
									</div>
								</ScrollArea>
							</TabsContent>

							<TabsContent
								value="documents"
								className="flex-1 m-0 overflow-hidden"
							>
								<ScrollArea className="h-full">
									<div className="p-4 space-y-3">
										{documents.length > 0 ? (
											documents.map((doc) => (
												<DocumentItem
													key={doc.id}
													document={doc}
													onView={() =>
														setSelectedDocument(doc)
													}
												/>
											))
										) : (
											<div className="text-center py-8 text-muted-foreground">
												<FileText className="size-8 mx-auto mb-2 opacity-50" />
												<p className="text-sm">
													No documents generated
												</p>
												<p className="text-xs mt-1">
													Generated documents will
													appear here
												</p>
											</div>
										)}
									</div>
								</ScrollArea>
							</TabsContent>

							<TabsContent
								value="sources"
								className="flex-1 m-0 overflow-hidden"
							>
								<ScrollArea className="h-full">
									<div className="p-4 space-y-3">
										{sources.length > 0 ? (
											sources.map((source) => (
												<SourceItem
													key={source.id}
													source={source}
												/>
											))
										) : (
											<div className="text-center py-8 text-muted-foreground">
												<BookOpen className="size-8 mx-auto mb-2 opacity-50" />
												<p className="text-sm">
													No sources referenced
												</p>
												<p className="text-xs mt-1">
													Sources used in planning
													will appear here
												</p>
											</div>
										)}
									</div>
								</ScrollArea>
							</TabsContent>
						</Tabs>
					</div>
				</SheetContent>
			</Sheet>

			{/* Document Viewer Dialog - Full Screen */}
			<Dialog
				open={!!selectedDocument}
				onOpenChange={(open) => !open && setSelectedDocument(null)}
			>
				<DialogContent className="w-[95vw] max-w-[95vw] h-[95vh] max-h-[95vh] flex flex-col p-0 gap-0">
					<DialogHeader className="flex-shrink-0 px-6 py-4 border-b">
						<DialogTitle className="flex items-center gap-2">
							<FileText className="size-5" />
							{selectedDocument?.title || "Document"}
							<Badge variant="secondary" className="ml-2 text-xs">
								{selectedDocument?.type}
							</Badge>
						</DialogTitle>
					</DialogHeader>
					<div className="flex-1 overflow-auto px-6 py-4">
						{selectedDocument?.type === "code" ? (
							<pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm font-mono min-h-full">
								<code>{selectedDocument.content}</code>
							</pre>
						) : selectedDocument?.type === "json" ? (
							<pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm font-mono min-h-full">
								<code>{selectedDocument.content}</code>
							</pre>
						) : (
							<div className="prose prose-sm dark:prose-invert max-w-none">
								<div className="whitespace-pre-wrap">
									{selectedDocument?.content}
								</div>
							</div>
						)}
					</div>
					<div className="flex justify-end gap-2 px-6 py-4 border-t flex-shrink-0 bg-background">
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								if (selectedDocument) {
									navigator.clipboard.writeText(
										selectedDocument.content,
									);
								}
							}}
						>
							<Copy className="size-4 mr-2" />
							Copy
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								if (selectedDocument) {
									downloadDocument(selectedDocument);
								}
							}}
						>
							<Download className="size-4 mr-2" />
							Download
						</Button>
						<Button
							variant="default"
							size="sm"
							onClick={() => setSelectedDocument(null)}
						>
							Close
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

// =============================================================================
// Trigger Button Component
// =============================================================================

interface ArtifactsPanelTriggerProps {
	onClick: () => void;
	planSteps?: number;
	completedSteps?: number;
	documentsCount?: number;
	sourcesCount?: number;
	isActive?: boolean;
	className?: string;
}

export function ArtifactsPanelTrigger({
	onClick,
	planSteps = 0,
	completedSteps = 0,
	documentsCount = 0,
	sourcesCount = 0,
	isActive = false,
	className,
}: ArtifactsPanelTriggerProps) {
	const totalItems = planSteps + documentsCount + sourcesCount;

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant={isActive ? "secondary" : "ghost"}
						size="sm"
						className={cn(
							"gap-2 transition-colors",
							isActive && "bg-primary/10",
							className,
						)}
						onClick={onClick}
					>
						<PanelRightOpen className="size-4" />
						<span className="hidden sm:inline">Artifacts</span>
						{totalItems > 0 && (
							<Badge
								variant="secondary"
								className="text-[10px] px-1.5 py-0"
							>
								{totalItems}
							</Badge>
						)}
					</Button>
				</TooltipTrigger>
				<TooltipContent side="bottom">
					<div className="text-xs space-y-0.5">
						<p className="font-medium">View Artifacts</p>
						{planSteps > 0 && (
							<p>
								{completedSteps}/{planSteps} steps
							</p>
						)}
						{documentsCount > 0 && (
							<p>{documentsCount} documents</p>
						)}
						{sourcesCount > 0 && <p>{sourcesCount} sources</p>}
					</div>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
