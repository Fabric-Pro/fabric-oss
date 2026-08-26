"use client";

/**
 * Google Docs / Drive Selector Dialog (MCP-based)
 *
 * Discovers available Google Drive MCP tools (list_files, search_files,
 * google_drive_list) and lets users multi-select documents, sheets, and
 * PDFs to include as project context.
 *
 * Features:
 * - List and grid view modes
 * - File preview/detail panel
 * - Folder navigation with breadcrumbs and back button
 * - Keyboard navigation (arrow keys, Enter, Space, Escape)
 *
 * Used by:
 * - ContextUploaderDialog (unified project setup wizard)
 */

import { TruncatedText } from "@shared/components/TruncatedText";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Separator } from "@ui/components/separator";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	ArrowLeftIcon,
	ChevronRightIcon,
	ExternalLinkIcon,
	FileIcon,
	FileSpreadsheetIcon,
	FileTextIcon,
	FolderIcon,
	HomeIcon,
	LayoutGridIcon,
	LayoutListIcon,
	Loader2Icon,
	PresentationIcon,
	SearchIcon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveFileIdsViaResources } from "../lib/google-drive-content-fetcher";

// ── Types ──────────────────────────────────────────────────────────────────

interface GoogleDriveFile {
	id: string;
	title: string;
	mimeType: string;
	url?: string;
	modifiedTime?: string;
	size?: number;
}

interface BreadcrumbItem {
	id: string;
	name: string;
}

interface GoogleDocsSelectorResult {
	fileId: string;
	title: string;
	mimeType: string;
	url?: string;
	configId: string;
	folderId?: string;
	folderName?: string;
	modifiedTime?: string;
}

interface GoogleDocsSelectorProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	configId: string | null;
	organizationId?: string | null;
	initialSelectedIds?: string[];
	onConfirm: (docs: GoogleDocsSelectorResult[]) => void;
}

// ── Constants ──────────────────────────────────────────────────────────────

const LIST_TOOL_PATTERNS = [
	"list_files",
	"search_files",
	"google_drive_list",
	"drive_list_files",
	"google_drive_search",
	"listfolder", // @piotr-agier/google-drive-mcp
	"search", // Must be last — prefer browse tools over search-only
];

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

// MIME types for documents we support
const DOCUMENT_MIME_TYPES = new Set([
	"application/vnd.google-apps.document",
	"application/vnd.google-apps.spreadsheet",
	"application/vnd.google-apps.presentation",
	"application/vnd.google-apps.form",
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"text/plain",
	"text/markdown",
	"text/csv",
]);

// Human-readable labels for MIME types
const MIME_TYPE_LABELS: Record<string, string> = {
	"application/vnd.google-apps.document": "Google Doc",
	"application/vnd.google-apps.spreadsheet": "Google Sheet",
	"application/vnd.google-apps.presentation": "Google Slides",
	"application/vnd.google-apps.form": "Google Form",
	"application/pdf": "PDF",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		"Word",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
		"Excel",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation":
		"PowerPoint",
	"text/plain": "Text",
	"text/markdown": "Markdown",
	"text/csv": "CSV",
};

// ── Helpers ────────────────────────────────────────────────────────────────

function detectListTool(tools: string[]): string | undefined {
	for (const pattern of LIST_TOOL_PATTERNS) {
		const match = tools.find((t) => t.toLowerCase().includes(pattern));
		if (match) {
			return match;
		}
	}
	return undefined;
}

function getFileTypeLabel(mimeType: string): string {
	return MIME_TYPE_LABELS[mimeType] ?? "File";
}

function FileTypeIcon({
	mimeType,
	className,
}: {
	mimeType: string;
	className?: string;
}) {
	if (
		mimeType.includes("spreadsheet") ||
		mimeType.includes("sheet") ||
		mimeType.includes("csv")
	) {
		return <FileSpreadsheetIcon className={className} />;
	}
	if (mimeType.includes("presentation") || mimeType.includes("slides")) {
		return <PresentationIcon className={className} />;
	}
	if (
		mimeType.includes("document") ||
		mimeType.includes("word") ||
		mimeType.includes("text") ||
		mimeType.includes("markdown") ||
		mimeType.includes("pdf")
	) {
		return <FileTextIcon className={className} />;
	}
	return <FileIcon className={className} />;
}

function formatModifiedTime(dateString?: string): string | undefined {
	if (!dateString) {
		return undefined;
	}
	try {
		const date = new Date(dateString);
		if (Number.isNaN(date.getTime())) {
			return undefined;
		}

		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

		if (diffDays === 0) {
			return "Today";
		}
		if (diffDays === 1) {
			return "Yesterday";
		}
		if (diffDays < 7) {
			return `${diffDays} days ago`;
		}
		if (diffDays < 30) {
			return `${Math.floor(diffDays / 7)} weeks ago`;
		}
		return date.toLocaleDateString();
	} catch {
		return undefined;
	}
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Parse plain text response from MCP servers that return human-readable output.
 * Format: "Found N files:\nfilename1 (mimeType)\nfilename2 (mimeType)"
 */
function parseTextFilesResult(text: string): GoogleDriveFile[] {
	const lines = text.split("\n").filter((l) => l.trim());
	const files: GoogleDriveFile[] = [];

	for (const line of lines) {
		// Match "filename (mimeType)" pattern
		const match = line.trim().match(/^(.+?)\s+\(([^)]+)\)$/);
		if (!match) {
			continue;
		}
		const [, name, mimeType] = match;
		const trimmedName = name.trim();
		if (!trimmedName) {
			continue;
		}
		files.push({
			id: trimmedName,
			title: trimmedName,
			mimeType: mimeType.trim(),
		});
	}

	return files;
}

/**
 * Parse the MCP tool response into a flat array of GoogleDriveFile objects.
 * Handles multiple response shapes from various Google Drive MCP servers,
 * including plain text responses from the official @modelcontextprotocol/server-gdrive.
 */
export function parseFilesResult(result: unknown): GoogleDriveFile[] {
	try {
		let data = typeof result === "string" ? JSON.parse(result) : result;

		// MCP text content array: [{ type: "text", text: "..." }]
		if (Array.isArray(data) && data[0]?.type === "text" && data[0]?.text) {
			data =
				typeof data[0].text === "string"
					? JSON.parse(data[0].text)
					: data[0].text;
		}

		const list: unknown[] = Array.isArray(data)
			? data
			: Array.isArray((data as Record<string, unknown>)?.files)
				? ((data as Record<string, unknown>).files as unknown[])
				: Array.isArray((data as Record<string, unknown>)?.items)
					? ((data as Record<string, unknown>).items as unknown[])
					: [];

		const jsonResult = list
			.map((item: unknown) => {
				const file = item as Record<string, unknown>;
				return {
					id: String(file.id ?? file.fileId ?? ""),
					title: String(file.name ?? file.title ?? ""),
					mimeType: String(file.mimeType ?? file.mime_type ?? ""),
					url: file.webViewLink
						? String(file.webViewLink)
						: file.url
							? String(file.url)
							: file.webContentLink
								? String(file.webContentLink)
								: undefined,
					modifiedTime: file.modifiedTime
						? String(file.modifiedTime)
						: file.modified_time
							? String(file.modified_time)
							: file.updatedAt
								? String(file.updatedAt)
								: undefined,
					size:
						typeof file.size === "number"
							? file.size
							: typeof file.size === "string"
								? Number.parseInt(file.size, 10) || undefined
								: undefined,
				} satisfies GoogleDriveFile;
			})
			.filter((file) => file.id && file.title);

		if (jsonResult.length > 0) {
			return jsonResult;
		}

		// Fallback: parse plain text format from official Google Drive MCP server
		// Format: "Found N file(s):\nfilename1 (mimeType)\nfilename2 (mimeType)"
		const rawText =
			typeof result === "string"
				? result
				: typeof data === "string"
					? data
					: "";
		if (rawText) {
			return parseTextFilesResult(rawText);
		}

		return [];
	} catch {
		// JSON.parse failed — try plain text parsing as fallback
		if (typeof result === "string") {
			return parseTextFilesResult(result);
		}
		return [];
	}
}

// ── File Preview Panel ─────────────────────────────────────────────────────

function FilePreviewPanel({
	file,
	isSelected,
	onToggleSelect,
	onClose,
}: {
	file: GoogleDriveFile;
	isSelected: boolean;
	onToggleSelect: () => void;
	onClose: () => void;
}) {
	const t = useTranslations("tooltips.contextSources");
	const typeLabel = getFileTypeLabel(file.mimeType);
	const modifiedLabel = formatModifiedTime(file.modifiedTime);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between">
				<span className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground font-sans">
					File Details
				</span>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={onClose}
							aria-label="Close preview"
						>
							<XIcon className="size-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("closePreview")}</TooltipContent>
				</Tooltip>
			</div>

			<div className="flex justify-center py-6">
				<FileTypeIcon
					mimeType={file.mimeType}
					className="size-16 text-muted-foreground"
				/>
			</div>

			<h3 className="text-base font-medium text-foreground break-words leading-snug">
				{file.title}
			</h3>

			<Separator />

			<div className="space-y-3 text-sm">
				<div className="flex justify-between items-center">
					<span className="text-muted-foreground">Type</span>
					<span className="rounded bg-muted px-1.5 py-0.5 text-xs">
						{typeLabel}
					</span>
				</div>

				{modifiedLabel && (
					<div className="flex justify-between items-center">
						<span className="text-muted-foreground">Modified</span>
						<span className="text-sm">{modifiedLabel}</span>
					</div>
				)}

				{file.size != null && (
					<div className="flex justify-between items-center">
						<span className="text-muted-foreground">Size</span>
						<span className="text-sm">
							{formatFileSize(file.size)}
						</span>
					</div>
				)}
			</div>

			<Separator />

			<div className="flex flex-col gap-2">
				<Button
					variant={isSelected ? "outline" : "default"}
					size="sm"
					onClick={onToggleSelect}
					className="w-full"
				>
					{isSelected ? "Deselect" : "Select"}
				</Button>

				{file.url && (
					<Button
						variant="outline"
						size="sm"
						asChild
						className="w-full"
					>
						<a
							href={file.url}
							target="_blank"
							rel="noopener noreferrer"
						>
							<ExternalLinkIcon className="size-4 mr-2" />
							Open in Google Drive
						</a>
					</Button>
				)}
			</div>
		</div>
	);
}

// ── Component ──────────────────────────────────────────────────────────────

export function GoogleDocsSelector({
	open,
	onOpenChange,
	configId,
	organizationId,
	initialSelectedIds = [],
	onConfirm,
}: GoogleDocsSelectorProps) {
	const t = useTranslations("tooltips.contextSources");
	const tC = useTranslations("tooltips.common");
	// Tool discovery
	const [availableTools, setAvailableTools] = useState<string[]>([]);
	const [toolsLoading, setToolsLoading] = useState(false);
	const [toolsError, setToolsError] = useState<string | null>(null);

	// Files
	const [files, setFiles] = useState<GoogleDriveFile[]>([]);
	const [filesLoading, setFilesLoading] = useState(false);
	const [filesError, setFilesError] = useState<string | null>(null);

	// Folder navigation
	const [currentFolderId, setCurrentFolderId] = useState<string>("root");
	const [folderBreadcrumbs, setFolderBreadcrumbs] = useState<
		BreadcrumbItem[]
	>([{ id: "root", name: "My Drive" }]);

	// Search and filter
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [filterDocsOnly, setFilterDocsOnly] = useState(true);

	// Selection
	const [localSelection, setLocalSelection] = useState<Set<string>>(
		new Set(),
	);

	// View mode and preview
	const [viewMode, setViewMode] = useState<"list" | "grid">("list");
	const [previewFile, setPreviewFile] = useState<GoogleDriveFile | null>(
		null,
	);
	const [focusedIndex, setFocusedIndex] = useState<number>(-1);
	const fileListRef = useRef<HTMLDivElement>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);

	// Cache file metadata + folder context at selection time so cross-folder
	// selections retain correct title, mimeType, folderId, and folderName.
	const selectionMetadataRef = useRef<
		Map<
			string,
			{ file: GoogleDriveFile; folderId?: string; folderName?: string }
		>
	>(new Map());

	// Derived tool
	const listTool = useMemo(
		() => detectListTool(availableTools),
		[availableTools],
	);

	// Determine if the tool is search-based (requires query) or list-based.
	// Tools like listFolder support browsing without a query.
	const isSearchBasedTool = useMemo(() => {
		if (!listTool) {
			return false;
		}
		const lower = listTool.toLowerCase();
		if (lower.includes("list") || lower.includes("folder")) {
			return false;
		}
		return lower.includes("search");
	}, [listTool]);

	// Client-side filtering
	const filteredFiles = useMemo(() => {
		let result = files;

		// Filter to document types only (always show folders for navigation)
		if (filterDocsOnly) {
			result = result.filter(
				(f) =>
					f.mimeType === FOLDER_MIME_TYPE ||
					DOCUMENT_MIME_TYPES.has(f.mimeType),
			);
		}

		// Text search
		if (searchQuery.trim() && !isSearchBasedTool) {
			const query = searchQuery.toLowerCase().trim();
			result = result.filter(
				(f) =>
					f.title.toLowerCase().includes(query) ||
					getFileTypeLabel(f.mimeType).toLowerCase().includes(query),
			);
		}

		return result;
	}, [files, searchQuery, filterDocsOnly, isSearchBasedTool]);

	// Files eligible for selection (excludes folders)
	const selectableFiles = useMemo(
		() => filteredFiles.filter((f) => f.mimeType !== FOLDER_MIME_TYPE),
		[filteredFiles],
	);

	// Debounce search for server-side search tools
	useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedQuery(searchQuery);
		}, 300);
		return () => clearTimeout(timer);
	}, [searchQuery]);

	// ── Reset on open ──────────────────────────────────────────────────────

	useEffect(() => {
		if (open) {
			setLocalSelection(new Set(initialSelectedIds));
			selectionMetadataRef.current = new Map();
			setSearchQuery("");
			setDebouncedQuery("");
			setFiles([]);
			setFilesError(null);
			setFilterDocsOnly(true);
			setCurrentFolderId("root");
			setFolderBreadcrumbs([{ id: "root", name: "My Drive" }]);
			setViewMode("list");
			setPreviewFile(null);
			setFocusedIndex(-1);
		}
	}, [open, initialSelectedIds]);

	// Reset focus/preview on folder or search change
	useEffect(() => {
		setFocusedIndex(-1);
		setPreviewFile(null);
	}, [currentFolderId, debouncedQuery]);

	// Sync preview when focused index changes
	useEffect(() => {
		if (focusedIndex >= 0 && focusedIndex < filteredFiles.length) {
			const file = filteredFiles[focusedIndex];
			if (file && file.mimeType !== FOLDER_MIME_TYPE) {
				setPreviewFile(file);
			} else {
				setPreviewFile(null);
			}
		}
	}, [focusedIndex, filteredFiles]);

	// Scroll focused item into view
	useEffect(() => {
		if (focusedIndex < 0 || !fileListRef.current) {
			return;
		}
		const el = fileListRef.current.querySelector(
			`[data-file-index="${focusedIndex}"]`,
		);
		el?.scrollIntoView({ block: "nearest" });
	}, [focusedIndex]);

	// Auto-focus search input for search-based tools
	useEffect(() => {
		if (isSearchBasedTool && searchInputRef.current) {
			searchInputRef.current.focus();
		}
	}, [isSearchBasedTool]);

	// ── Fetch tools ────────────────────────────────────────────────────────

	useEffect(() => {
		if (!open || !configId) {
			return;
		}

		async function fetchTools() {
			setToolsLoading(true);
			setToolsError(null);
			try {
				const response = await fetch("/api/pipeline/mcp-tool", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mcpConfigId: configId,
						action: "list_tools",
						organizationId: organizationId ?? undefined,
					}),
				});
				const data = await response.json();
				if (data.error) {
					setToolsError(data.error);
				} else {
					setAvailableTools(data.tools || []);
				}
			} catch (err) {
				setToolsError(
					err instanceof Error ? err.message : "Failed to load tools",
				);
			} finally {
				setToolsLoading(false);
			}
		}

		fetchTools();
	}, [open, configId, organizationId]);

	// ── Fetch files via MCP resources (fallback when no list tool) ────────

	const fetchFilesViaResources = useCallback(async () => {
		setFilesLoading(true);
		setFilesError(null);
		try {
			const response = await fetch("/api/pipeline/mcp-tool", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					mcpConfigId: configId,
					action: "listResources",
					organizationId: organizationId ?? undefined,
				}),
			});
			const data = await response.json();
			if (data.error) {
				setFilesError(data.error);
				return;
			}

			// Parse MCP resources: { resources: [{ uri, name, mimeType }] }
			const resources = data.result?.resources || [];
			const parsed: GoogleDriveFile[] = resources
				.map(
					(r: { uri?: string; name?: string; mimeType?: string }) => {
						// Extract file ID from URI like "gdrive:///1BxiMVs..."
						const uriMatch = r.uri?.match(/gdrive:\/\/\/(.+)/);
						const id = uriMatch?.[1] || "";
						return {
							id,
							title: r.name || "",
							mimeType: r.mimeType || "",
						};
					},
				)
				.filter((f: GoogleDriveFile) => f.id && f.title);

			setFiles(parsed);
		} catch (err) {
			setFilesError(
				err instanceof Error ? err.message : "Failed to load files",
			);
		} finally {
			setFilesLoading(false);
		}
	}, [configId, organizationId]);

	// ── Fetch files via tools ─────────────────────────────────────────────

	useEffect(() => {
		if (!open || !configId || toolsLoading) {
			return;
		}

		// No list tool found and tools have been discovered — try MCP resources as fallback
		if (!listTool && availableTools.length > 0) {
			fetchFilesViaResources();
			return;
		}

		if (!listTool) {
			return;
		}

		// For search-based tools with no query, show browsable files via listResources
		if (isSearchBasedTool && !debouncedQuery.trim()) {
			fetchFilesViaResources();
			return;
		}

		async function fetchFiles() {
			setFilesLoading(true);
			setFilesError(null);
			try {
				const params: Record<string, string> = {};
				if (debouncedQuery.trim()) {
					params.query = debouncedQuery.trim();
				}
				// Pass folderId for folder navigation
				if (currentFolderId && currentFolderId !== "root") {
					params.folderId = currentFolderId;
					params.folder_id = currentFolderId;
				}

				const response = await fetch("/api/pipeline/mcp-tool", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mcpConfigId: configId,
						toolName: listTool,
						params,
						organizationId: organizationId ?? undefined,
					}),
				});
				const data = await response.json();
				if (data.error) {
					setFilesError(data.error);
					return;
				}

				let parsed = parseFilesResult(data.result);

				// If all files have id === title, the text-parse fallback was used
				// and IDs are actually filenames. Resolve real IDs via listResources.
				const hasFilenameIds =
					parsed.length > 0 && parsed.every((f) => f.id === f.title);
				if (hasFilenameIds && configId) {
					try {
						const nameToId = await resolveFileIdsViaResources(
							parsed,
							configId,
							organizationId,
						);
						if (nameToId.size > 0) {
							parsed = parsed.map((f) => {
								const realId = nameToId.get(f.title);
								return realId ? { ...f, id: realId } : f;
							});
						}
					} catch {
						console.warn(
							"[GoogleDocsSelector] Failed to resolve file IDs via resources",
						);
					}
				}

				// Sort: folders first, then by modified time (most recent first)
				setFiles(
					parsed.sort((a, b) => {
						const aIsFolder = a.mimeType === FOLDER_MIME_TYPE;
						const bIsFolder = b.mimeType === FOLDER_MIME_TYPE;
						if (aIsFolder && !bIsFolder) {
							return -1;
						}
						if (!aIsFolder && bIsFolder) {
							return 1;
						}
						if (!a.modifiedTime && !b.modifiedTime) {
							return 0;
						}
						if (!a.modifiedTime) {
							return 1;
						}
						if (!b.modifiedTime) {
							return -1;
						}
						return (
							new Date(b.modifiedTime).getTime() -
							new Date(a.modifiedTime).getTime()
						);
					}),
				);
			} catch (err) {
				setFilesError(
					err instanceof Error ? err.message : "Failed to load files",
				);
			} finally {
				setFilesLoading(false);
			}
		}

		fetchFiles();
	}, [
		open,
		configId,
		toolsLoading,
		listTool,
		availableTools,
		isSearchBasedTool,
		debouncedQuery,
		organizationId,
		currentFolderId,
		fetchFilesViaResources,
	]);

	// Get current folder info for metadata
	const currentFolder = folderBreadcrumbs[folderBreadcrumbs.length - 1];

	// ── Selection helpers ──────────────────────────────────────────────────

	const toggleSelection = useCallback(
		(fileId: string) => {
			setLocalSelection((prev) => {
				const next = new Set(prev);
				if (next.has(fileId)) {
					next.delete(fileId);
					selectionMetadataRef.current.delete(fileId);
				} else {
					next.add(fileId);
					const file = files.find((f) => f.id === fileId);
					if (file) {
						selectionMetadataRef.current.set(fileId, {
							file,
							folderId:
								currentFolder?.id !== "root"
									? currentFolder?.id
									: undefined,
							folderName:
								currentFolder?.id !== "root"
									? currentFolder?.name
									: undefined,
						});
					}
				}
				return next;
			});
		},
		[files, currentFolder],
	);

	const selectAll = useCallback(() => {
		setLocalSelection((prev) => {
			const next = new Set(prev);
			for (const file of selectableFiles) {
				next.add(file.id);
				if (!selectionMetadataRef.current.has(file.id)) {
					selectionMetadataRef.current.set(file.id, {
						file,
						folderId:
							currentFolder?.id !== "root"
								? currentFolder?.id
								: undefined,
						folderName:
							currentFolder?.id !== "root"
								? currentFolder?.name
								: undefined,
					});
				}
			}
			return next;
		});
	}, [selectableFiles, currentFolder]);

	const deselectAll = useCallback(() => {
		const visibleIds = new Set(selectableFiles.map((f) => f.id));
		setLocalSelection((prev) => {
			const next = new Set(prev);
			for (const id of visibleIds) {
				next.delete(id);
				selectionMetadataRef.current.delete(id);
			}
			return next;
		});
	}, [selectableFiles]);

	// ── Folder navigation ─────────────────────────────────────────────────

	const navigateToFolder = useCallback(
		(folderId: string, folderName: string) => {
			setCurrentFolderId(folderId);
			setFolderBreadcrumbs((prev) => [
				...prev,
				{ id: folderId, name: folderName },
			]);
			setSearchQuery("");
			setDebouncedQuery("");
		},
		[],
	);

	const navigateToBreadcrumb = useCallback(
		(index: number) => {
			const target = folderBreadcrumbs[index];
			if (!target) {
				return;
			}
			setCurrentFolderId(target.id);
			setFolderBreadcrumbs((prev) => prev.slice(0, index + 1));
			setSearchQuery("");
			setDebouncedQuery("");
		},
		[folderBreadcrumbs],
	);

	const navigateBack = useCallback(() => {
		if (folderBreadcrumbs.length <= 1) {
			return;
		}
		navigateToBreadcrumb(folderBreadcrumbs.length - 2);
	}, [folderBreadcrumbs, navigateToBreadcrumb]);

	// ── Keyboard navigation ───────────────────────────────────────────────

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			const items = filteredFiles;
			if (items.length === 0) {
				return;
			}

			switch (e.key) {
				case "ArrowDown": {
					e.preventDefault();
					setFocusedIndex((prev) =>
						Math.min(prev + 1, items.length - 1),
					);
					break;
				}
				case "ArrowUp": {
					e.preventDefault();
					setFocusedIndex((prev) => Math.max(prev - 1, 0));
					break;
				}
				case "ArrowRight": {
					if (viewMode === "grid") {
						e.preventDefault();
						setFocusedIndex((prev) =>
							Math.min(prev + 1, items.length - 1),
						);
					}
					break;
				}
				case "ArrowLeft": {
					if (viewMode === "grid") {
						e.preventDefault();
						setFocusedIndex((prev) => Math.max(prev - 1, 0));
					}
					break;
				}
				case "Enter": {
					e.preventDefault();
					const file = items[focusedIndex];
					if (!file) {
						break;
					}
					if (file.mimeType === FOLDER_MIME_TYPE) {
						navigateToFolder(file.id, file.title);
						setFocusedIndex(-1);
					} else {
						toggleSelection(file.id);
					}
					break;
				}
				case " ": {
					e.preventDefault();
					const spaceFile = items[focusedIndex];
					if (spaceFile && spaceFile.mimeType !== FOLDER_MIME_TYPE) {
						toggleSelection(spaceFile.id);
					}
					break;
				}
				case "Escape": {
					if (previewFile) {
						setPreviewFile(null);
					} else if (folderBreadcrumbs.length > 1) {
						navigateBack();
					}
					break;
				}
			}
		},
		[
			filteredFiles,
			focusedIndex,
			viewMode,
			previewFile,
			navigateBack,
			navigateToFolder,
			toggleSelection,
			folderBreadcrumbs,
		],
	);

	const handleConfirm = useCallback(() => {
		const results: GoogleDocsSelectorResult[] = [];
		const cache = selectionMetadataRef.current;

		for (const id of localSelection) {
			const cached = cache.get(id);
			if (cached) {
				results.push({
					fileId: cached.file.id,
					title: cached.file.title,
					mimeType: cached.file.mimeType,
					url: cached.file.url,
					configId: configId ?? "",
					folderId: cached.folderId,
					folderName: cached.folderName,
					modifiedTime: cached.file.modifiedTime,
				});
			} else {
				// Fallback for initialSelectedIds that were never browsed
				results.push({
					fileId: id,
					title: id,
					mimeType: "",
					configId: configId ?? "",
				});
			}
		}

		onConfirm(results);
	}, [localSelection, onConfirm, configId]);

	const clearSearch = useCallback(() => {
		setSearchQuery("");
		setDebouncedQuery("");
	}, []);

	// ── Render ─────────────────────────────────────────────────────────────

	const isLoading = toolsLoading || filesLoading;
	const hasError = toolsError || filesError;
	const _hasRequiredTool = !!listTool;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-5xl max-h-[80vh] flex flex-col overflow-hidden">
				<DialogHeader className="flex-shrink-0">
					<DialogTitle className="flex items-center gap-2">
						<FileTextIcon className="size-5 text-success" />
						Select Google Drive Files
					</DialogTitle>
					<DialogDescription>
						Choose documents, sheets, or other files to include as
						context for your project.
					</DialogDescription>
				</DialogHeader>

				<div className="flex-1 min-h-0 flex flex-col overflow-hidden">
					{toolsLoading ? (
						<div className="flex items-center justify-center py-8">
							<Loader2Icon className="size-6 animate-spin text-muted-foreground mr-2" />
							<span className="text-muted-foreground">
								Connecting to Google Drive...
							</span>
						</div>
					) : toolsError ? (
						<div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
							<div className="flex items-center gap-2 text-destructive">
								<AlertCircleIcon className="size-5" />
								<span>{toolsError}</span>
							</div>
						</div>
					) : (
						<div className="flex flex-col h-full gap-3 min-h-0">
							{/* Navigation bar: back button + breadcrumbs (hidden for search-only tools) */}
							{!isSearchBasedTool && (
								<div className="flex items-center gap-2 text-sm flex-shrink-0">
									{folderBreadcrumbs.length > 1 && (
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													variant="ghost"
													size="icon-sm"
													onClick={navigateBack}
													aria-label="Go back to parent folder"
													className="shrink-0"
												>
													<ArrowLeftIcon className="size-4" />
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												{t("goBackFolder")}
											</TooltipContent>
										</Tooltip>
									)}
									<div className="flex items-center gap-1 flex-wrap">
										{folderBreadcrumbs.map(
											(crumb, index) => (
												<span
													key={crumb.id}
													className="flex items-center gap-1"
												>
													{index > 0 && (
														<ChevronRightIcon className="size-3 text-muted-foreground" />
													)}
													<button
														type="button"
														onClick={() =>
															navigateToBreadcrumb(
																index,
															)
														}
														className={cn(
															"flex items-center gap-1 hover:underline",
															index ===
																folderBreadcrumbs.length -
																	1
																? "font-medium text-foreground"
																: "text-primary cursor-pointer",
														)}
														disabled={
															index ===
															folderBreadcrumbs.length -
																1
														}
													>
														{index === 0 && (
															<HomeIcon className="size-3" />
														)}
														{crumb.name}
													</button>
												</span>
											),
										)}
									</div>
								</div>
							)}

							{/* Search + view toggle + filter row */}
							<div className="flex items-center gap-2 flex-shrink-0">
								<div className="relative flex-1">
									<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
									<Input
										ref={searchInputRef}
										placeholder={
											isSearchBasedTool
												? "Search Google Drive..."
												: "Filter files..."
										}
										value={searchQuery}
										onChange={(e) =>
											setSearchQuery(e.target.value)
										}
										className="pl-10 pr-10"
									/>
									{searchQuery && (
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={clearSearch}
													aria-label="Clear search"
													className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
												>
													<XIcon className="size-4" />
												</button>
											</TooltipTrigger>
											<TooltipContent>
												{tC("clearSearch")}
											</TooltipContent>
										</Tooltip>
									)}
								</div>

								{/* View mode toggle */}
								<div className="flex border rounded-md p-0.5 shrink-0">
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												variant={
													viewMode === "list"
														? "default"
														: "ghost"
												}
												size="icon-sm"
												onClick={() =>
													setViewMode("list")
												}
												aria-label="List view"
											>
												<LayoutListIcon className="size-4" />
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("listView")}
										</TooltipContent>
									</Tooltip>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												variant={
													viewMode === "grid"
														? "default"
														: "ghost"
												}
												size="icon-sm"
												onClick={() =>
													setViewMode("grid")
												}
												aria-label="Grid view"
											>
												<LayoutGridIcon className="size-4" />
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("gridView")}
										</TooltipContent>
									</Tooltip>
								</div>

								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											variant={
												filterDocsOnly
													? "default"
													: "outline"
											}
											size="sm"
											onClick={() =>
												setFilterDocsOnly(
													!filterDocsOnly,
												)
											}
											className="shrink-0 text-xs"
										>
											Docs Only
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{t("docsOnlyFilter")}
									</TooltipContent>
								</Tooltip>
							</div>

							{/* Select All / Deselect All */}
							{selectableFiles.length > 0 && (
								<div className="flex items-center justify-between text-sm flex-shrink-0">
									<span className="text-muted-foreground">
										{localSelection.size > 0
											? `${localSelection.size} selected`
											: `${selectableFiles.length} file${selectableFiles.length !== 1 ? "s" : ""}`}
									</span>
									<div className="flex gap-2">
										<button
											type="button"
											onClick={selectAll}
											className="text-sm text-primary hover:underline cursor-pointer"
										>
											Select All
										</button>
										<span className="text-muted-foreground">
											|
										</span>
										<button
											type="button"
											onClick={deselectAll}
											className="text-sm text-primary hover:underline cursor-pointer"
										>
											Deselect All
										</button>
									</div>
								</div>
							)}

							{/* File browser + preview layout */}
							<div className="flex-1 min-h-0 flex gap-0 overflow-hidden rounded-lg border">
								{/* Left: File list/grid */}
								<div
									ref={fileListRef}
									className={cn(
										"overflow-y-auto",
										previewFile ? "flex-[3]" : "flex-1",
									)}
									onKeyDown={handleKeyDown}
									tabIndex={0}
									role="listbox"
									aria-label="File list"
								>
									{filesLoading ? (
										<div className="flex items-center justify-center h-full min-h-[200px]">
											<Loader2Icon className="size-6 animate-spin text-muted-foreground" />
										</div>
									) : filesError ? (
										<div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground gap-2 p-4">
											<AlertCircleIcon className="size-8 opacity-50" />
											<p className="text-sm text-center">
												{filesError}
											</p>
										</div>
									) : isSearchBasedTool &&
										!debouncedQuery.trim() &&
										filteredFiles.length === 0 ? (
										<div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground gap-2 p-4">
											<SearchIcon className="size-8 opacity-50" />
											<p className="font-medium">
												Search your Google Drive
											</p>
											<p className="text-xs text-center max-w-[250px]">
												Type a file name or keyword in
												the search box above to find
												your documents
											</p>
										</div>
									) : filteredFiles.length === 0 ? (
										<div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground gap-2 p-4">
											<FileIcon className="size-8 opacity-50" />
											<p className="font-medium">
												{searchQuery.trim()
													? "No files match your search"
													: filterDocsOnly
														? "No documents found"
														: "No files found"}
											</p>
											{filterDocsOnly &&
												files.length > 0 && (
													<Button
														variant="ghost"
														size="sm"
														onClick={() =>
															setFilterDocsOnly(
																false,
															)
														}
													>
														Show all file types
													</Button>
												)}
											{searchQuery.trim() && (
												<Button
													variant="ghost"
													size="sm"
													onClick={clearSearch}
												>
													Clear search
												</Button>
											)}
										</div>
									) : viewMode === "list" ? (
										/* ── List View ── */
										<div className="p-2 space-y-1">
											{filteredFiles.map(
												(file, index) => {
													const isFolder =
														file.mimeType ===
														FOLDER_MIME_TYPE;
													const isFocused =
														index === focusedIndex;

													if (isFolder) {
														return (
															<button
																key={file.id}
																type="button"
																data-file-index={
																	index
																}
																onClick={() =>
																	navigateToFolder(
																		file.id,
																		file.title,
																	)
																}
																className={cn(
																	"flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-foreground/5 w-full text-left",
																	isFocused &&
																		"ring-2 ring-primary ring-inset",
																)}
															>
																<FolderIcon className="size-5 text-highlight shrink-0" />
																<div className="flex-1 min-w-0">
																	<TruncatedText
																		as="p"
																		text={
																			file.title
																		}
																		className="font-medium text-sm"
																	/>
																	<p className="text-xs text-muted-foreground">
																		Folder
																	</p>
																</div>
																<ChevronRightIcon className="size-4 text-muted-foreground shrink-0" />
															</button>
														);
													}

													const isSelected =
														localSelection.has(
															file.id,
														);
													const typeLabel =
														getFileTypeLabel(
															file.mimeType,
														);
													const modifiedLabel =
														formatModifiedTime(
															file.modifiedTime,
														);

													return (
														<div
															key={file.id}
															data-file-index={
																index
															}
															className={cn(
																"flex items-center gap-3 p-3 rounded-lg transition-colors",
																isSelected
																	? "bg-primary/10"
																	: "hover:bg-foreground/5",
																isFocused &&
																	"ring-2 ring-primary ring-inset",
															)}
														>
															<Checkbox
																checked={
																	isSelected
																}
																onCheckedChange={() =>
																	toggleSelection(
																		file.id,
																	)
																}
															/>

															<div className="shrink-0">
																<FileTypeIcon
																	mimeType={
																		file.mimeType
																	}
																	className="size-5 text-muted-foreground"
																/>
															</div>

															<button
																type="button"
																className="flex-1 min-w-0 text-left"
																onClick={() => {
																	setPreviewFile(
																		file,
																	);
																	setFocusedIndex(
																		index,
																	);
																}}
															>
																<TruncatedText
																	as="p"
																	text={
																		file.title
																	}
																	className="font-medium text-sm"
																/>
																<div className="flex items-center gap-2 text-xs text-muted-foreground">
																	<span className="rounded bg-muted px-1.5 py-0.5">
																		{
																			typeLabel
																		}
																	</span>
																	{modifiedLabel && (
																		<span>
																			Modified{" "}
																			{
																				modifiedLabel
																			}
																		</span>
																	)}
																</div>
															</button>

															{file.url && (
																<a
																	href={
																		file.url
																	}
																	target="_blank"
																	rel="noopener noreferrer"
																	onClick={(
																		e,
																	) =>
																		e.stopPropagation()
																	}
																	className="shrink-0 text-xs text-primary hover:underline"
																>
																	Open
																</a>
															)}
														</div>
													);
												},
											)}
										</div>
									) : (
										/* ── Grid View ── */
										<div className="p-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
											{filteredFiles.map(
												(file, index) => {
													const isFolder =
														file.mimeType ===
														FOLDER_MIME_TYPE;
													const isFocused =
														index === focusedIndex;

													if (isFolder) {
														return (
															<button
																key={file.id}
																type="button"
																data-file-index={
																	index
																}
																onClick={() =>
																	navigateToFolder(
																		file.id,
																		file.title,
																	)
																}
																className={cn(
																	"group flex flex-col items-center gap-2 p-4 rounded-lg border bg-card",
																	"transition-colors hover:bg-accent/50",
																	isFocused &&
																		"ring-2 ring-primary",
																)}
															>
																<FolderIcon className="size-10 text-highlight" />
																<TruncatedText
																	as="p"
																	text={
																		file.title
																	}
																	className="text-sm font-medium w-full text-center"
																/>
																<span className="text-xs text-muted-foreground">
																	Folder
																</span>
															</button>
														);
													}

													const isSelected =
														localSelection.has(
															file.id,
														);
													const typeLabel =
														getFileTypeLabel(
															file.mimeType,
														);
													const modifiedLabel =
														formatModifiedTime(
															file.modifiedTime,
														);

													return (
														<div
															key={file.id}
															data-file-index={
																index
															}
															role="option"
															tabIndex={0}
															aria-selected={
																isSelected
															}
															onClick={() => {
																setPreviewFile(
																	file,
																);
																setFocusedIndex(
																	index,
																);
															}}
															onKeyDown={(e) => {
																if (
																	e.key ===
																		"Enter" ||
																	e.key ===
																		" "
																) {
																	e.preventDefault();
																	toggleSelection(
																		file.id,
																	);
																}
															}}
															className={cn(
																"group relative flex flex-col items-center gap-2 p-4 rounded-lg border bg-card cursor-pointer",
																"transition-colors hover:bg-accent/50",
																isSelected &&
																	"border-primary bg-primary/5",
																isFocused &&
																	"ring-2 ring-primary",
															)}
														>
															<div className="absolute top-2 left-2">
																<Checkbox
																	checked={
																		isSelected
																	}
																	onCheckedChange={() =>
																		toggleSelection(
																			file.id,
																		)
																	}
																	onClick={(
																		e,
																	) =>
																		e.stopPropagation()
																	}
																/>
															</div>

															<FileTypeIcon
																mimeType={
																	file.mimeType
																}
																className="size-10 text-muted-foreground"
															/>
															<TruncatedText
																as="p"
																text={
																	file.title
																}
																className="text-sm font-medium w-full text-center"
															/>
															<div className="flex flex-col items-center gap-1">
																<span className="text-xs rounded bg-muted px-1.5 py-0.5">
																	{typeLabel}
																</span>
																{modifiedLabel && (
																	<span className="text-xs text-muted-foreground">
																		{
																			modifiedLabel
																		}
																	</span>
																)}
															</div>
														</div>
													);
												},
											)}
										</div>
									)}
								</div>

								{/* Right: Preview panel */}
								{previewFile && (
									<>
										<Separator orientation="vertical" />
										<div className="hidden md:block flex-[2] overflow-y-auto p-4 bg-muted/30">
											<FilePreviewPanel
												file={previewFile}
												isSelected={localSelection.has(
													previewFile.id,
												)}
												onToggleSelect={() =>
													toggleSelection(
														previewFile.id,
													)
												}
												onClose={() =>
													setPreviewFile(null)
												}
											/>
										</div>
									</>
								)}
							</div>
						</div>
					)}
				</div>

				<DialogFooter className="flex-shrink-0 pt-4 border-t">
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								onClick={handleConfirm}
								disabled={
									isLoading ||
									!!hasError ||
									localSelection.size === 0
								}
							>
								{`Add ${localSelection.size} File${localSelection.size !== 1 ? "s" : ""}`}
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("addGoogleDocs")}</TooltipContent>
					</Tooltip>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
