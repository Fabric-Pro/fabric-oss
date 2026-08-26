"use client";

/**
 * AgentMemoryPanel Component
 *
 * Main panel for managing agent memory files.
 * Features:
 * - File tree browser with icons for different file types
 * - File editor with syntax highlighting for markdown/json
 * - Pending edits approval with diff viewer
 * - Import/Export functionality
 * - YOLO mode toggle for auto-approval
 */

import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { ScrollArea } from "@ui/components/scroll-area";
import { Separator } from "@ui/components/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	BookOpenIcon,
	BrainIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	DownloadIcon,
	FileIcon,
	FileJsonIcon,
	FileTextIcon,
	FolderIcon,
	FolderOpenIcon,
	MessageSquareIcon,
	RefreshCwIcon,
	SaveIcon,
	SettingsIcon,
	SparklesIcon,
	TrashIcon,
	XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type MemoryFile = {
	id: string;
	path: string;
	fileType: string;
	content: string;
	version: number;
	createdAt: Date | string;
	updatedAt: Date | string;
	pendingEditCount?: number;
};

type PendingEdit = {
	id: string;
	path: string;
	operation: string;
	proposedContent: string | null;
	reason: string | null;
	status: string;
	createdAt: Date | string;
};

const FILE_TYPE_ICONS: Record<string, React.ElementType> = {
	AGENTS_MD: BrainIcon,
	MCP_JSON: SettingsIcon,
	SKILL: SparklesIcon,
	KNOWLEDGE: BookOpenIcon,
	CONVERSATION: MessageSquareIcon,
};

const FILE_TYPE_COLORS: Record<string, string> = {
	AGENTS_MD: "text-purple-500",
	MCP_JSON: "text-blue-500",
	SKILL: "text-highlight",
	KNOWLEDGE: "text-success",
	CONVERSATION: "text-cyan-500",
};

function getFileIcon(fileType: string, path: string) {
	if (FILE_TYPE_ICONS[fileType]) {
		const Icon = FILE_TYPE_ICONS[fileType];
		return <Icon className={cn("h-4 w-4", FILE_TYPE_COLORS[fileType])} />;
	}
	if (path.endsWith(".json")) {
		return <FileJsonIcon className="h-4 w-4 text-yellow-500" />;
	}
	if (path.endsWith(".md")) {
		return <FileTextIcon className="h-4 w-4 text-blue-400" />;
	}
	return <FileIcon className="h-4 w-4 text-muted-foreground" />;
}

type FileTreeNode = {
	name: string;
	path: string;
	type: "file" | "folder";
	fileType?: string;
	children?: FileTreeNode[];
	pendingEditCount?: number;
	sourceSkillId?: string | null;
};

type FileTreeBuildNode = {
	name: string;
	path: string;
	type: "file" | "folder";
	fileType?: string;
	children?: Record<string, FileTreeBuildNode>;
	pendingEditCount?: number;
	sourceSkillId?: string | null;
};

function buildFileTree(files: MemoryFile[]): FileTreeNode[] {
	const root: Record<string, FileTreeBuildNode> = {};

	for (const file of files) {
		const parts = file.path.split("/");
		let current = root;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isFile = i === parts.length - 1;
			const currentPath = parts.slice(0, i + 1).join("/");

			if (!current[part]) {
				current[part] = {
					name: part,
					path: currentPath,
					type: isFile ? "file" : "folder",
					fileType: isFile ? file.fileType : undefined,
					children: isFile ? undefined : {},
					pendingEditCount: isFile
						? file.pendingEditCount
						: undefined,
					sourceSkillId: isFile
						? (
								file as MemoryFile & {
									sourceSkillId?: string | null;
								}
							).sourceSkillId
						: undefined,
				};
			}

			if (!isFile && current[part].children) {
				current = current[part].children as Record<
					string,
					FileTreeBuildNode
				>;
			}
		}
	}

	function convertToArray(
		nodes: Record<string, FileTreeBuildNode>,
	): FileTreeNode[] {
		return Object.values(nodes)
			.map((node) => ({
				name: node.name,
				path: node.path,
				type: node.type,
				fileType: node.fileType,
				pendingEditCount: node.pendingEditCount,
				sourceSkillId: node.sourceSkillId,
				children: node.children
					? convertToArray(node.children)
					: undefined,
			}))
			.sort((a, b) => {
				if (a.type !== b.type) {
					return a.type === "folder" ? -1 : 1;
				}
				return a.name.localeCompare(b.name);
			});
	}

	return convertToArray(root);
}

function FileTreeItem({
	node,
	depth,
	selectedPath,
	onSelect,
	expandedFolders,
	onToggleFolder,
}: {
	node: FileTreeNode;
	depth: number;
	selectedPath: string | null;
	onSelect: (path: string) => void;
	expandedFolders: Set<string>;
	onToggleFolder: (path: string) => void;
}) {
	const isExpanded = expandedFolders.has(node.path);
	const isSelected = selectedPath === node.path;

	if (node.type === "folder") {
		return (
			<div>
				<button
					type="button"
					onClick={() => onToggleFolder(node.path)}
					className={cn(
						"flex w-full items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-muted/50 transition-colors",
						"text-left",
					)}
					style={{ paddingLeft: `${depth * 12 + 8}px` }}
				>
					{isExpanded ? (
						<ChevronDownIcon className="h-4 w-4 text-muted-foreground" />
					) : (
						<ChevronRightIcon className="h-4 w-4 text-muted-foreground" />
					)}
					{isExpanded ? (
						<FolderOpenIcon className="h-4 w-4 text-highlight" />
					) : (
						<FolderIcon className="h-4 w-4 text-highlight" />
					)}
					<span className="font-medium">{node.name}</span>
				</button>
				{isExpanded && node.children && (
					<div>
						{node.children.map((child) => (
							<FileTreeItem
								key={child.path}
								node={child}
								depth={depth + 1}
								selectedPath={selectedPath}
								onSelect={onSelect}
								expandedFolders={expandedFolders}
								onToggleFolder={onToggleFolder}
							/>
						))}
					</div>
				)}
			</div>
		);
	}

	return (
		<button
			type="button"
			onClick={() => onSelect(node.path)}
			className={cn(
				"flex w-full items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors",
				"text-left hover:bg-muted/50",
				isSelected && "bg-primary/10 text-primary font-medium",
			)}
			style={{ paddingLeft: `${depth * 12 + 28}px` }}
		>
			{getFileIcon(node.fileType || "", node.path)}
			<span className="truncate flex-1">{node.name}</span>
			{node.sourceSkillId && node.fileType === "SKILL" && (
				<Badge
					variant="outline"
					className="text-xs text-amber-600 border-amber-300"
				>
					Inherited
				</Badge>
			)}
			{node.pendingEditCount && node.pendingEditCount > 0 && (
				<Badge variant="secondary" className="ml-auto text-xs">
					{node.pendingEditCount}
				</Badge>
			)}
		</button>
	);
}

type Props = {
	instanceId: string;
	organizationId?: string | null;
	templateId?: string;
};

export function AgentMemoryPanel({
	instanceId,
	organizationId,
	templateId,
}: Props) {
	const queryClient = useQueryClient();
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
		new Set(["skills", "knowledge", "conversations"]),
	);
	const [editedContent, setEditedContent] = useState<string>("");
	const [hasChanges, setHasChanges] = useState(false);
	const [activeTab, setActiveTab] = useState<"files" | "pending">("files");

	// Fetch memory files
	const {
		data: filesData,
		isLoading: filesLoading,
		refetch: refetchFiles,
	} = useQuery(
		orpc.agentMemory.files.list.queryOptions({
			input: {
				agentInstanceId: instanceId,
				organizationId: organizationId ?? null,
			},
		}),
	);

	// Fetch pending edits
	const { data: editsData, isLoading: editsLoading } = useQuery(
		orpc.agentMemory.edits.list.queryOptions({
			input: {
				agentInstanceId: instanceId,
				organizationId: organizationId ?? null,
			},
		}),
	);

	// Fetch selected file content
	const { data: fileData, isLoading: fileLoading } = useQuery({
		...orpc.agentMemory.files.read.queryOptions({
			input: {
				agentInstanceId: instanceId,
				path: selectedPath || "",
				organizationId: organizationId ?? null,
			},
		}),
		enabled: !!selectedPath,
	});

	// Mutations
	const writeMutation = useMutation(
		orpc.agentMemory.files.write.mutationOptions({
			onSuccess: () => {
				toast.success("File saved successfully");
				setHasChanges(false);
				queryClient.invalidateQueries({
					queryKey: ["agentMemory"],
				});
			},
			onError: (error: Error) => {
				toast.error(error.message || "Failed to save file");
			},
		}),
	);

	const deleteMutation = useMutation(
		orpc.agentMemory.files.delete.mutationOptions({
			onSuccess: () => {
				toast.success("File deleted");
				setSelectedPath(null);
				queryClient.invalidateQueries({
					queryKey: ["agentMemory"],
				});
			},
			onError: (error: Error) => {
				toast.error(error.message || "Failed to delete file");
			},
		}),
	);

	const approveMutation = useMutation(
		orpc.agentMemory.edits.approve.mutationOptions({
			onSuccess: () => {
				toast.success("Edit approved and applied");
				queryClient.invalidateQueries({
					queryKey: ["agentMemory"],
				});
			},
			onError: (error: Error) => {
				toast.error(error.message || "Failed to approve edit");
			},
		}),
	);

	const rejectMutation = useMutation(
		orpc.agentMemory.edits.reject.mutationOptions({
			onSuccess: () => {
				toast.success("Edit rejected");
				queryClient.invalidateQueries({
					queryKey: ["agentMemory"],
				});
			},
			onError: (error: Error) => {
				toast.error(error.message || "Failed to reject edit");
			},
		}),
	);

	const initializeMutation = useMutation(
		orpc.agentMemory.initialize.mutationOptions({
			onSuccess: () => {
				toast.success("Memory initialized from template");
				queryClient.invalidateQueries({
					queryKey: ["agentMemory"],
				});
			},
			onError: (error: Error) => {
				toast.error(error.message || "Failed to initialize memory");
			},
		}),
	);

	const exportMutation = useMutation(
		orpc.agentMemory.export.mutationOptions({
			onSuccess: (data) => {
				const blob = new Blob([JSON.stringify(data, null, 2)], {
					type: "application/json",
				});
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = `agent-memory-${instanceId}.json`;
				a.click();
				URL.revokeObjectURL(url);
				toast.success("Memory exported");
			},
			onError: (error: Error) => {
				toast.error(error.message || "Failed to export memory");
			},
		}),
	);

	// Update edited content when file changes
	useEffect(() => {
		if (fileData?.file) {
			setEditedContent(fileData.file.content);
			setHasChanges(false);
		}
	}, [fileData?.file]);

	const files = (filesData?.files || []) as unknown as MemoryFile[];
	const pendingEdits = (editsData?.edits || []) as unknown as PendingEdit[];
	const fileTree = useMemo(() => buildFileTree(files), [files]);

	const handleToggleFolder = useCallback((path: string) => {
		setExpandedFolders((prev) => {
			const next = new Set(prev);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
			}
			return next;
		});
	}, []);

	const handleContentChange = useCallback(
		(content: string) => {
			setEditedContent(content);
			setHasChanges(content !== fileData?.file?.content);
		},
		[fileData?.file?.content],
	);

	const handleSave = useCallback(() => {
		if (!selectedPath || !hasChanges) {
			return;
		}
		writeMutation.mutate({
			agentInstanceId: instanceId,
			path: selectedPath,
			content: editedContent,
			organizationId: organizationId ?? null,
		});
	}, [
		selectedPath,
		hasChanges,
		editedContent,
		instanceId,
		organizationId,
		writeMutation,
	]);

	const handleDelete = useCallback(() => {
		if (!selectedPath) {
			return;
		}
		deleteMutation.mutate({
			agentInstanceId: instanceId,
			path: selectedPath,
			organizationId: organizationId ?? null,
		});
	}, [selectedPath, instanceId, organizationId, deleteMutation]);

	const selectedFile = files.find((f) => f.path === selectedPath);

	return (
		<Card className="h-full">
			<CardHeader className="pb-3">
				<div className="flex items-center justify-between">
					<div>
						<CardTitle className="flex items-center gap-2">
							<BrainIcon className="h-5 w-5" />
							Agent Memory
						</CardTitle>
						<CardDescription>
							Persistent memory files that improve over time
						</CardDescription>
					</div>
					<div className="flex items-center gap-2">
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="outline"
										size="icon"
										onClick={() => refetchFiles()}
									>
										<RefreshCwIcon className="h-4 w-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>Refresh</TooltipContent>
							</Tooltip>
						</TooltipProvider>
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								exportMutation.mutate({
									agentInstanceId: instanceId,
									organizationId: organizationId ?? null,
								})
							}
							disabled={exportMutation.isPending}
						>
							<DownloadIcon className="mr-2 h-4 w-4" />
							Export
						</Button>
						{files.length === 0 && templateId && (
							<Button
								size="sm"
								onClick={() =>
									initializeMutation.mutate({
										agentInstanceId: instanceId,
										templateId: templateId,
										organizationId: organizationId ?? null,
									})
								}
								disabled={initializeMutation.isPending}
							>
								<SparklesIcon className="mr-2 h-4 w-4" />
								Initialize
							</Button>
						)}
					</div>
				</div>
			</CardHeader>
			<Separator />
			<CardContent className="p-0 h-[calc(100%-80px)]">
				<Tabs
					value={activeTab}
					onValueChange={(v) =>
						setActiveTab(v as "files" | "pending")
					}
					className="h-full flex flex-col"
				>
					<TabsList className="mx-4 mt-4 grid w-auto grid-cols-2">
						<TabsTrigger value="files">
							Files
							{files.length > 0 && (
								<Badge variant="secondary" className="ml-2">
									{files.length}
								</Badge>
							)}
						</TabsTrigger>
						<TabsTrigger value="pending">
							Pending
							{pendingEdits.length > 0 && (
								<Badge variant="destructive" className="ml-2">
									{pendingEdits.length}
								</Badge>
							)}
						</TabsTrigger>
					</TabsList>

					<TabsContent value="files" className="flex-1 m-0 p-4 pt-2">
						{filesLoading ? (
							<div className="flex items-center justify-center h-full">
								<Spinner className="h-8 w-8" />
							</div>
						) : files.length === 0 ? (
							<div className="flex flex-col items-center justify-center h-full text-center">
								<BrainIcon className="h-12 w-12 text-muted-foreground/50 mb-4" />
								<h3 className="font-semibold">
									No Memory Files
								</h3>
								<p className="text-sm text-muted-foreground mt-1 max-w-xs">
									Initialize memory from the template to get
									started with AGENTS.md and MCP
									configuration.
								</p>
							</div>
						) : (
							<div className="grid grid-cols-3 gap-4 h-full">
								{/* File Tree */}
								<div className="col-span-1 border rounded-lg overflow-hidden">
									<div className="bg-muted/50 px-3 py-2 border-b">
										<span className="text-sm font-medium">
											Memory Files
										</span>
									</div>
									<ScrollArea className="h-[calc(100%-40px)]">
										<div className="p-2">
											{fileTree.map((node) => (
												<FileTreeItem
													key={node.path}
													node={node}
													depth={0}
													selectedPath={selectedPath}
													onSelect={setSelectedPath}
													expandedFolders={
														expandedFolders
													}
													onToggleFolder={
														handleToggleFolder
													}
												/>
											))}
										</div>
									</ScrollArea>
								</div>

								{/* File Editor */}
								<div className="col-span-2 border rounded-lg overflow-hidden flex flex-col">
									{selectedPath ? (
										<>
											<div className="bg-muted/50 px-3 py-2 border-b flex items-center justify-between">
												<div className="flex items-center gap-2">
													{getFileIcon(
														selectedFile?.fileType ||
															"",
														selectedPath,
													)}
													<span className="text-sm font-medium">
														{selectedPath}
													</span>
													{hasChanges && (
														<Badge
															variant="outline"
															className="text-amber-600"
														>
															Unsaved
														</Badge>
													)}
												</div>
												<div className="flex items-center gap-2">
													<Button
														variant="ghost"
														size="sm"
														onClick={handleSave}
														disabled={
															!hasChanges ||
															writeMutation.isPending
														}
													>
														<SaveIcon className="mr-2 h-4 w-4" />
														Save
													</Button>
													<AlertDialog>
														<AlertDialogTrigger
															asChild
														>
															<Button
																variant="ghost"
																size="sm"
																className="text-destructive hover:text-destructive"
															>
																<TrashIcon className="h-4 w-4" />
															</Button>
														</AlertDialogTrigger>
														<AlertDialogContent>
															<AlertDialogHeader>
																<AlertDialogTitle>
																	Delete File
																</AlertDialogTitle>
																<AlertDialogDescription>
																	Are you sure
																	you want to
																	delete "
																	{
																		selectedPath
																	}
																	"? This
																	cannot be
																	undone.
																</AlertDialogDescription>
															</AlertDialogHeader>
															<AlertDialogFooter>
																<AlertDialogCancel>
																	Cancel
																</AlertDialogCancel>
																<AlertDialogAction
																	onClick={
																		handleDelete
																	}
																	variant="destructive"
																>
																	Delete
																</AlertDialogAction>
															</AlertDialogFooter>
														</AlertDialogContent>
													</AlertDialog>
												</div>
											</div>
											<div className="flex-1 p-0">
												{fileLoading ? (
													<div className="flex items-center justify-center h-full">
														<Spinner className="h-6 w-6" />
													</div>
												) : (
													<Textarea
														value={editedContent}
														onChange={(e) =>
															handleContentChange(
																e.target.value,
															)
														}
														className="h-full w-full resize-none border-0 rounded-none font-mono text-sm focus-visible:ring-0"
														placeholder="File content..."
													/>
												)}
											</div>
										</>
									) : (
										<div className="flex flex-col items-center justify-center h-full text-center">
											<FileTextIcon className="h-12 w-12 text-muted-foreground/50 mb-4" />
											<p className="text-sm text-muted-foreground">
												Select a file to view and edit
											</p>
										</div>
									)}
								</div>
							</div>
						)}
					</TabsContent>

					<TabsContent
						value="pending"
						className="flex-1 m-0 p-4 pt-2"
					>
						{editsLoading ? (
							<div className="flex items-center justify-center h-full">
								<Spinner className="h-8 w-8" />
							</div>
						) : pendingEdits.length === 0 ? (
							<div className="flex flex-col items-center justify-center h-full text-center">
								<CheckIcon className="h-12 w-12 text-success/50 mb-4" />
								<h3 className="font-semibold">
									No Pending Edits
								</h3>
								<p className="text-sm text-muted-foreground mt-1 max-w-xs">
									All memory edits have been reviewed. The
									agent will create new edits as it learns.
								</p>
							</div>
						) : (
							<ScrollArea className="h-full">
								<div className="space-y-4">
									{pendingEdits.map((edit) => (
										<PendingEditCard
											key={edit.id}
											edit={edit}
											onApprove={() =>
												approveMutation.mutate({
													editId: edit.id,
													organizationId:
														organizationId ?? null,
												})
											}
											onReject={() =>
												rejectMutation.mutate({
													editId: edit.id,
													organizationId:
														organizationId ?? null,
												})
											}
											isApproving={
												approveMutation.isPending
											}
											isRejecting={
												rejectMutation.isPending
											}
										/>
									))}
								</div>
							</ScrollArea>
						)}
					</TabsContent>
				</Tabs>
			</CardContent>
		</Card>
	);
}

function PendingEditCard({
	edit,
	onApprove,
	onReject,
	isApproving,
	isRejecting,
}: {
	edit: PendingEdit;
	onApprove: () => void;
	onReject: () => void;
	isApproving: boolean;
	isRejecting: boolean;
}) {
	const [showDiff, setShowDiff] = useState(false);

	return (
		<Card>
			<CardHeader className="pb-2">
				<div className="flex items-start justify-between">
					<div>
						<CardTitle className="text-base flex items-center gap-2">
							<FileTextIcon className="h-4 w-4" />
							{edit.path}
						</CardTitle>
						<CardDescription className="mt-1">
							{edit.operation === "CREATE"
								? "Create new file"
								: edit.operation === "UPDATE"
									? "Update existing file"
									: "Delete file"}
						</CardDescription>
					</div>
					<Badge
						variant={
							edit.operation === "CREATE"
								? "default"
								: edit.operation === "DELETE"
									? "destructive"
									: "secondary"
						}
					>
						{edit.operation}
					</Badge>
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				{edit.reason && (
					<div className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-md">
						<strong>Reason:</strong> {edit.reason}
					</div>
				)}

				{edit.proposedContent && (
					<div>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setShowDiff(!showDiff)}
							className="mb-2"
						>
							{showDiff ? (
								<ChevronDownIcon className="mr-2 h-4 w-4" />
							) : (
								<ChevronRightIcon className="mr-2 h-4 w-4" />
							)}
							{showDiff ? "Hide" : "Show"} Changes
						</Button>
						{showDiff && (
							<div className="border rounded-md overflow-hidden">
								<div className="bg-muted/50 px-3 py-1.5 border-b text-xs text-muted-foreground">
									Proposed Content
								</div>
								<pre className="p-3 text-sm overflow-auto max-h-64 bg-muted/20">
									<code>{edit.proposedContent}</code>
								</pre>
							</div>
						)}
					</div>
				)}

				<div className="flex items-center gap-2 pt-2">
					<Button
						size="sm"
						onClick={onApprove}
						disabled={isApproving || isRejecting}
					>
						<CheckIcon className="mr-2 h-4 w-4" />
						Approve
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={onReject}
						disabled={isApproving || isRejecting}
					>
						<XIcon className="mr-2 h-4 w-4" />
						Reject
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}
