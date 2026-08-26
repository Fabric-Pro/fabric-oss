"use client";

/**
 * FileAutocomplete - Dropdown for @file mention search results
 *
 * Shows matching code files with language icon, file path, and size.
 * Supports keyboard navigation.
 */

import { cn } from "@ui/lib";
import { FileCode, Loader2 } from "lucide-react";
import type { MentionableFile } from "../../../hooks/useFileMention";

export interface FileAutocompleteProps {
	/** Search results to display */
	results: MentionableFile[];
	/** Whether search is loading */
	isLoading: boolean;
	/** Currently selected index */
	selectedIndex: number;
	/** Callback when file is selected */
	onSelect: (file: MentionableFile) => void;
	/** Callback when hovering over an item */
	onHover: (index: number) => void;
	/** Additional class name */
	className?: string;
}

/** Get file extension from path */
function getFileExtension(path: string): string {
	const parts = path.split(".");
	return parts.length > 1
		? (parts[parts.length - 1] || "").toLowerCase()
		: "";
}

/** Get language label from file path and language field */
function getLanguageLabel(file: MentionableFile): string {
	if (file.language) {
		return file.language;
	}
	const ext = getFileExtension(file.path);
	if (ext) {
		return ext.toUpperCase();
	}
	return "FILE";
}

/** Format file size for display */
function formatFileSize(bytes: number | null): string {
	if (bytes === null) {
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

export function FileAutocomplete({
	results,
	isLoading,
	selectedIndex,
	onSelect,
	onHover,
	className,
}: FileAutocompleteProps) {
	if (isLoading) {
		return (
			<div
				className={cn(
					"absolute bottom-full left-0 right-0 mb-2 bg-popover border rounded-lg shadow-lg z-50 p-4",
					className,
				)}
			>
				<div className="flex items-center justify-center gap-2 text-muted-foreground">
					<Loader2 className="h-4 w-4 animate-spin" />
					<span className="text-sm">Searching files...</span>
				</div>
			</div>
		);
	}

	if (results.length === 0) {
		return (
			<div
				className={cn(
					"absolute bottom-full left-0 right-0 mb-2 bg-popover border rounded-lg shadow-lg z-50 p-4",
					className,
				)}
			>
				<p className="text-sm text-muted-foreground text-center">
					No files found
				</p>
			</div>
		);
	}

	return (
		<div
			className={cn(
				"absolute bottom-full left-0 right-0 mb-2 bg-popover border rounded-lg shadow-lg z-50 overflow-hidden",
				className,
			)}
		>
			<div className="max-h-64 overflow-y-auto">
				{results.map((file, index) => (
					<button
						key={file.id}
						type="button"
						className={cn(
							"w-full px-3 py-2.5 text-left flex items-start gap-3 hover:bg-muted/50 transition-colors",
							index === selectedIndex && "bg-muted",
						)}
						onClick={() => onSelect(file)}
						onMouseEnter={() => onHover(index)}
					>
						{/* File icon */}
						<span className="shrink-0 w-8 h-8 flex items-center justify-center rounded bg-muted">
							<FileCode className="h-4 w-4 text-muted-foreground" />
						</span>

						{/* Content */}
						<div className="flex-1 min-w-0">
							<div className="flex items-center gap-2 mb-0.5">
								<span className="font-medium text-sm truncate">
									{file.path}
								</span>
								<span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-muted text-muted-foreground">
									{getLanguageLabel(file)}
								</span>
							</div>
							<p className="text-xs text-muted-foreground">
								{formatFileSize(file.size)}
							</p>
						</div>
					</button>
				))}
			</div>

			{/* Footer hint */}
			<div className="px-3 py-2 border-t bg-muted/30 text-[10px] text-muted-foreground flex items-center gap-3">
				<span>
					<kbd className="px-1 py-0.5 bg-muted rounded text-[9px]">
						↑↓
					</kbd>{" "}
					navigate
				</span>
				<span>
					<kbd className="px-1 py-0.5 bg-muted rounded text-[9px]">
						Enter
					</kbd>{" "}
					select
				</span>
				<span>
					<kbd className="px-1 py-0.5 bg-muted rounded text-[9px]">
						Esc
					</kbd>{" "}
					close
				</span>
			</div>
		</div>
	);
}
