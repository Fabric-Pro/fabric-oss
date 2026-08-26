"use client";

/**
 * WorkspacePanel - Agent workspace file management panel
 *
 * CUGA-inspired feature that provides:
 * - Visual file tree for agent-generated files
 * - File preview and editing
 * - Multi-file management
 * - Export capabilities
 */

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { ScrollArea } from "@ui/components/scroll-area";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import {
	ChevronDown,
	ChevronRight,
	Copy,
	Download,
	ExternalLink,
	File,
	FileCode,
	FileJson,
	FileText,
	Folder,
	FolderOpen,
	MoreVertical,
	PanelTop,
	Plus,
	Presentation,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

// Types
export interface WorkspaceFile {
	id: string;
	name: string;
	path: string;
	type: "file" | "folder";
	extension?: string;
	fileType?: string;
	size?: number;
	updatedAt?: string;
	children?: WorkspaceFile[];
}

interface WorkspacePanelProps {
	files: WorkspaceFile[];
	isLoading?: boolean;
	selectedFileId?: string | null;
	onSelectFile?: (file: WorkspaceFile) => void;
	onCreateFile?: (parentPath: string, name: string) => void;
	onDeleteFile?: (fileId: string) => void;
	onRefresh?: () => void;
	className?: string;
}

function isFrameFile(file: WorkspaceFile) {
	return file.fileType === "FRAME" || file.fileType === "SLIDESHOW";
}

function getFrameRoute(file: WorkspaceFile) {
	return `/app/frames/${file.id}`;
}

// File icon mapping
function getFileIcon(file: WorkspaceFile) {
	if (file.type === "folder") {
		return Folder;
	}

	if (file.fileType === "FRAME") {
		return PanelTop;
	}

	if (file.fileType === "SLIDESHOW") {
		return Presentation;
	}

	const extension = file.extension?.toLowerCase();
	switch (extension) {
		case "md":
		case "txt":
			return FileText;
		case "js":
		case "ts":
		case "tsx":
		case "jsx":
		case "py":
		case "go":
		case "rs":
			return FileCode;
		case "json":
		case "yaml":
		case "yml":
			return FileJson;
		default:
			return File;
	}
}

// File type colors
function getFileTypeColor(fileType?: string) {
	switch (fileType) {
		case "DOCUMENT":
			return "text-blue-500";
		case "CODE":
			return "text-success";
		case "DATA":
			return "text-highlight";
		case "CONFIG":
			return "text-purple-500";
		case "OUTPUT":
			return "text-teal-500";
		case "ARTIFACT":
			return "text-pink-500";
		case "FRAME":
			return "text-violet-500";
		case "SLIDESHOW":
			return "text-fuchsia-500";
		default:
			return "text-muted-foreground";
	}
}

// Format file size
function formatSize(bytes?: number): string {
	if (!bytes) {
		return "";
	}
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// File tree node component
interface FileTreeNodeProps {
	node: WorkspaceFile;
	depth: number;
	selectedId?: string | null;
	expandedFolders: Set<string>;
	onToggleFolder: (id: string) => void;
	onSelect: (file: WorkspaceFile) => void;
	onOpenFile: (file: WorkspaceFile) => void;
	onDelete?: (id: string) => void;
}

function FileTreeNode({
	node,
	depth,
	selectedId,
	expandedFolders,
	onToggleFolder,
	onSelect,
	onOpenFile,
	onDelete,
}: FileTreeNodeProps) {
	const isFolder = node.type === "folder";
	const isExpanded = expandedFolders.has(node.id);
	const isSelected = node.id === selectedId;
	const Icon = getFileIcon(node);

	return (
		<div>
			<div
				className={cn(
					"group flex items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors hover:bg-muted",
					isSelected && "bg-muted font-medium",
				)}
				style={{ paddingLeft: `${8 + depth * 16}px` }}
			>
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
					onClick={() => {
						if (isFolder) {
							onToggleFolder(node.id);
						} else if (isFrameFile(node)) {
							onOpenFile(node);
						} else {
							onSelect(node);
						}
					}}
				>
					{/* Expand/collapse icon for folders */}
					{isFolder ? (
						<span className="flex h-4 w-4 items-center justify-center rounded">
							{isExpanded ? (
								<ChevronDown className="h-3.5 w-3.5" />
							) : (
								<ChevronRight className="h-3.5 w-3.5" />
							)}
						</span>
					) : (
						<span className="w-4" />
					)}

					{/* File/folder icon */}
					<Icon
						className={cn(
							"h-4 w-4 flex-shrink-0",
							isFolder
								? isExpanded
									? "text-highlight"
									: "text-amber-400"
								: getFileTypeColor(node.fileType),
						)}
					/>

					{/* Name */}
					<span className="flex-1 truncate">{node.name}</span>

					{/* First-class frame badge */}
					{!isFolder && isFrameFile(node) && (
						<Badge variant="outline" className="h-5 text-[10px]">
							{node.fileType === "SLIDESHOW" ? "Slides" : "Frame"}
						</Badge>
					)}

					{/* Size badge for files */}
					{!isFolder && node.size && (
						<span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100">
							{formatSize(node.size)}
						</span>
					)}
				</button>

				{/* Actions menu */}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							className="h-5 w-5 opacity-0 group-hover:opacity-100"
						>
							<MoreVertical className="h-3 w-3" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-40">
						{!isFolder && (
							<>
								<DropdownMenuItem
									onClick={() =>
										isFrameFile(node)
											? onOpenFile(node)
											: onSelect(node)
									}
								>
									<ExternalLink className="mr-2 h-4 w-4" />
									{isFrameFile(node)
										? "Open in Frames"
										: "Open"}
								</DropdownMenuItem>
								<DropdownMenuItem>
									<Copy className="h-4 w-4 mr-2" />
									Copy
								</DropdownMenuItem>
								<DropdownMenuItem>
									<Download className="h-4 w-4 mr-2" />
									Download
								</DropdownMenuItem>
								<DropdownMenuSeparator />
							</>
						)}
						{onDelete && (
							<DropdownMenuItem
								className="text-destructive"
								onClick={() => onDelete(node.id)}
							>
								<Trash2 className="h-4 w-4 mr-2" />
								Delete
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{/* Children (for expanded folders) */}
			{isFolder && isExpanded && node.children && (
				<div>
					{node.children.map((child) => (
						<FileTreeNode
							key={child.id}
							node={child}
							depth={depth + 1}
							selectedId={selectedId}
							expandedFolders={expandedFolders}
							onToggleFolder={onToggleFolder}
							onSelect={onSelect}
							onOpenFile={onOpenFile}
							onDelete={onDelete}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export function WorkspacePanel({
	files,
	isLoading = false,
	selectedFileId,
	onSelectFile,
	onCreateFile,
	onDeleteFile,
	onRefresh,
	className,
}: WorkspacePanelProps) {
	const router = useRouter();
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
		new Set(),
	);
	const [showCreateDialog, setShowCreateDialog] = useState(false);

	const handleToggleFolder = useCallback((folderId: string) => {
		setExpandedFolders((prev) => {
			const next = new Set(prev);
			if (next.has(folderId)) {
				next.delete(folderId);
			} else {
				next.add(folderId);
			}
			return next;
		});
	}, []);

	const handleSelectFile = useCallback(
		(file: WorkspaceFile) => {
			onSelectFile?.(file);
		},
		[onSelectFile],
	);

	const handleOpenFile = useCallback(
		(file: WorkspaceFile) => {
			if (isFrameFile(file)) {
				router.push(getFrameRoute(file));
				return;
			}
			onSelectFile?.(file);
		},
		[onSelectFile, router],
	);

	// Count total files
	const countFiles = (nodes: WorkspaceFile[]): number => {
		return nodes.reduce((count, node) => {
			if (node.type === "file") {
				return count + 1;
			}
			return count + countFiles(node.children || []);
		}, 0);
	};
	const totalFiles = countFiles(files);

	if (isLoading) {
		return (
			<div className={cn("p-3 space-y-2", className)}>
				<div className="flex items-center justify-between mb-3">
					<Skeleton className="h-5 w-24" />
					<Skeleton className="h-6 w-6" />
				</div>
				{[1, 2, 3, 4, 5].map((i) => (
					<Skeleton key={i} className="h-7 w-full" />
				))}
			</div>
		);
	}

	return (
		<div className={cn("flex flex-col h-full", className)}>
			{/* Header */}
			<div className="flex items-center justify-between px-3 py-2 border-b">
				<div className="flex items-center gap-2">
					<FolderOpen className="h-4 w-4 text-muted-foreground" />
					<span className="text-sm font-medium">Workspace</span>
					<Badge variant="secondary" className="text-[10px] h-5">
						{totalFiles} files
					</Badge>
				</div>
				<div className="flex items-center gap-1">
					{onRefresh && (
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={onRefresh}
							className="h-6 w-6"
						>
							<RefreshCw className="h-3.5 w-3.5" />
						</Button>
					)}
					{onCreateFile && (
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={() => setShowCreateDialog(true)}
							className="h-6 w-6"
						>
							<Plus className="h-3.5 w-3.5" />
						</Button>
					)}
				</div>
			</div>

			{/* File Tree */}
			<ScrollArea className="flex-1">
				{files.length === 0 ? (
					<div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
						<Folder className="h-8 w-8 mb-2 opacity-50" />
						<p className="text-sm">No files yet</p>
						<p className="text-xs">
							Files generated by agents will appear here
						</p>
					</div>
				) : (
					<div className="py-1">
						{files.map((file) => (
							<FileTreeNode
								key={file.id}
								node={file}
								depth={0}
								selectedId={selectedFileId}
								expandedFolders={expandedFolders}
								onToggleFolder={handleToggleFolder}
								onSelect={handleSelectFile}
								onOpenFile={handleOpenFile}
								onDelete={onDeleteFile}
							/>
						))}
					</div>
				)}
			</ScrollArea>

			{/* Create File Dialog */}
			<Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Create New File</DialogTitle>
					</DialogHeader>
					{/* TODO: Add form for creating new file */}
					<p className="text-sm text-muted-foreground">
						File creation form coming soon...
					</p>
				</DialogContent>
			</Dialog>
		</div>
	);
}
