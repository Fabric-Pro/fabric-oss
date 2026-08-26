"use client";

/**
 * Version Diff Viewer
 * Fullscreen overlay showing a rich diff comparison between the current document
 * and a selected historical version. Supports Unified (inline diff) and
 * Side-by-Side view modes. Reuses the same diff infrastructure as AI streaming edits.
 */

import type { DocumentVersionAuthor } from "@repo/utils/document-version-author";
import { EditorContent, useEditor } from "@tiptap/react";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { cn } from "@ui/lib";
import {
	ArrowLeftRight,
	ClockIcon,
	Loader2Icon,
	RotateCcwIcon,
	XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
	diffPartialText,
	fromMarkdown,
	stripDiffAdditions,
	stripDiffDeletions,
} from "../lib/diff-utils";
import { advancedExtensions } from "../lib/tiptap-extensions-advanced";
import { VersionAuthorBadge } from "./VersionAuthorBadge";
import "./DocumentEditor.css";

interface SelectedVersion {
	id: string;
	version: number;
	content: string;
	changeDescription: string | null;
	/**
	 * Raw `DocumentVersion.changedBy`: an opaque user id, the auto-refresh
	 * agent's sentinel, or null. NEVER render this — render `author` instead,
	 * which the server resolves into a display name.
	 */
	changedBy: string | null;
	/**
	 * Who wrote the version being compared, resolved server-side. `null` for
	 * legacy rows with no recorded author — the footer then omits the author
	 * rather than inventing one.
	 *
	 * Optional because this viewer is shared with the FEATURE version history,
	 * whose `StoryVersion.changedBy` is not resolved server-side yet (it carries
	 * the same FK-less raw-id shape `DocumentVersion` had before authorship was
	 * fixed). Absent and null both render no author, which is honest — better
	 * than inventing one. Resolving story authorship is a straight reuse of
	 * `resolveDocumentVersionAuthor` whenever that gets picked up.
	 */
	author?: DocumentVersionAuthor | null;
	createdAt: string;
}

interface VersionDiffViewerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	selectedVersion: SelectedVersion;
	currentContent: string;
	currentVersion: number;
	onRestore: () => void;
	isRestoring: boolean;
}

export function VersionDiffViewer({
	open,
	onOpenChange,
	selectedVersion,
	currentContent,
	currentVersion,
	onRestore,
	isRestoring,
}: VersionDiffViewerProps) {
	const [isVisible, setIsVisible] = useState(false);

	// Smooth mount animation
	useEffect(() => {
		if (open) {
			const timer = setTimeout(() => {
				setIsVisible(true);
			}, 10);
			return () => clearTimeout(timer);
		}
		setIsVisible(false);
	}, [open]);

	// Escape key handler
	useEffect(() => {
		if (!open) {
			return;
		}
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onOpenChange(false);
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [open, onOpenChange]);

	// Check if content is identical
	const isIdentical = useMemo(
		() => currentContent.trim() === selectedVersion.content.trim(),
		[currentContent, selectedVersion.content],
	);

	// Compute unified diff. Order: (older, newer) so ADD = newly added in
	// the current version (green) and DEL = removed since the older version
	// (red). Matches the side-by-side direction below — running it the
	// other way around made added-in-newer text show as DELETED.
	const diffHtml = useMemo(() => {
		if (isIdentical) {
			return null;
		}
		const diffText = diffPartialText(
			selectedVersion.content,
			currentContent,
			true,
		);
		return fromMarkdown(diffText);
	}, [currentContent, selectedVersion.content, isIdentical]);

	// Word count stats
	const currentWords = useMemo(
		() => currentContent.split(/\s+/).filter((w) => w.length > 0).length,
		[currentContent],
	);
	const versionWords = useMemo(
		() =>
			selectedVersion.content.split(/\s+/).filter((w) => w.length > 0)
				.length,
		[selectedVersion.content],
	);
	const wordDelta = versionWords - currentWords;

	// Single diff pass for side-by-side: strip opposite markers for each panel
	// diffPartialText(version, current) → ADD = current-unique, DEL = version-unique
	const sideBySideDiffText = useMemo(() => {
		if (isIdentical) {
			return null;
		}
		return diffPartialText(selectedVersion.content, currentContent, true);
	}, [currentContent, selectedVersion.content, isIdentical]);

	// Left panel (current): strip DEL markers (version-unique text), keep ADD (green)
	const currentDiffHtml = useMemo(() => {
		if (!sideBySideDiffText) {
			return fromMarkdown(currentContent);
		}
		return fromMarkdown(stripDiffDeletions(sideBySideDiffText));
	}, [sideBySideDiffText, currentContent]);

	// Right panel (version): strip ADD markers (current-unique text), keep DEL (red)
	const versionDiffHtml = useMemo(() => {
		if (!sideBySideDiffText) {
			return fromMarkdown(selectedVersion.content);
		}
		return fromMarkdown(stripDiffAdditions(sideBySideDiffText));
	}, [sideBySideDiffText, selectedVersion.content]);

	// Unified diff editor (read-only)
	const unifiedEditor = useEditor(
		{
			extensions: advancedExtensions,
			content: diffHtml || "",
			editable: false,
			immediatelyRender: false,
			editorProps: {
				attributes: { class: "p-8 tiptap" },
			},
		},
		[diffHtml],
	);

	// Side-by-side: current content editor (read-only, with diff highlights)
	const currentEditor = useEditor(
		{
			extensions: advancedExtensions,
			content: currentDiffHtml,
			editable: false,
			immediatelyRender: false,
			editorProps: {
				attributes: { class: "p-6 tiptap" },
			},
		},
		[currentDiffHtml],
	);

	// Side-by-side: version content editor (read-only, with diff highlights)
	const versionEditor = useEditor(
		{
			extensions: advancedExtensions,
			content: versionDiffHtml,
			editable: false,
			immediatelyRender: false,
			editorProps: {
				attributes: { class: "p-6 tiptap" },
			},
		},
		[versionDiffHtml],
	);

	const formatDate = useCallback((dateStr: string) => {
		return new Intl.DateTimeFormat("en-US", {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date(dateStr));
	}, []);

	if (!open || typeof window === "undefined") {
		return null;
	}

	const overlay = (
		<div
			className="fixed inset-0 z-[60] bg-background/95 backdrop-blur-sm flex items-center justify-center p-2"
			style={{
				opacity: isVisible ? 1 : 0,
				transition: "opacity 0.2s ease-out",
			}}
		>
			<div
				className="bg-card border border-border rounded-lg shadow-2xl w-[98vw] h-[98vh] overflow-hidden flex flex-col"
				style={{
					transform: isVisible ? "scale(1)" : "scale(0.95)",
					transition: "transform 0.2s ease-out",
				}}
			>
				{/* Header */}
				<div className="shrink-0 px-6 py-4 border-b border-border flex items-center justify-between gap-4">
					<div className="flex items-center gap-3 min-w-0">
						<ArrowLeftRight className="h-5 w-5 text-muted-foreground shrink-0" />
						<h3 className="text-lg font-semibold truncate">
							Comparing{" "}
							<span className="text-primary">
								v{selectedVersion.version}
							</span>{" "}
							with Current{" "}
							<span className="text-muted-foreground">
								(v{currentVersion})
							</span>
						</h3>
						{isIdentical && (
							<Badge
								variant="outline"
								className="text-xs shrink-0"
							>
								Identical
							</Badge>
						)}
					</div>

					<div className="flex items-center gap-2 shrink-0">
						<Button
							variant="ghost"
							size="icon"
							onClick={() => onOpenChange(false)}
							className="h-8 w-8"
						>
							<XIcon className="h-4 w-4" />
						</Button>
					</div>
				</div>

				{/* Content area with tabs */}
				{isIdentical ? (
					<div className="flex-1 flex items-center justify-center">
						<div className="text-center text-muted-foreground">
							<ArrowLeftRight className="h-12 w-12 mx-auto mb-3 opacity-50" />
							<p className="font-medium text-lg">
								No differences found
							</p>
							<p className="text-sm mt-1">
								Version {selectedVersion.version} is identical
								to the current document
							</p>
						</div>
					</div>
				) : (
					<Tabs
						defaultValue="unified"
						className="flex-1 flex flex-col overflow-hidden"
					>
						<div className="shrink-0 px-6 pt-3 border-b border-border">
							<TabsList className="h-9">
								<TabsTrigger
									value="unified"
									className="text-xs"
								>
									Unified Diff
								</TabsTrigger>
								<TabsTrigger
									value="sidebyside"
									className="text-xs"
								>
									Side by Side
								</TabsTrigger>
							</TabsList>
						</div>

						{/* Unified diff view */}
						<TabsContent
							value="unified"
							className="flex-1 overflow-auto mt-0"
						>
							<div className="streaming-diff-active">
								<div className="prose prose-sm max-w-none dark:prose-invert">
									<EditorContent editor={unifiedEditor} />
								</div>
							</div>
						</TabsContent>

						{/* Side-by-side view */}
						<TabsContent
							value="sidebyside"
							className="flex-1 overflow-hidden mt-0"
						>
							<div className="grid grid-cols-2 h-full divide-x divide-border">
								{/* Current version */}
								<div className="flex flex-col overflow-hidden">
									<div className="shrink-0 px-4 py-2 bg-muted/50 border-b border-border">
										<span className="text-sm font-medium">
											Current (v{currentVersion})
										</span>
										<span className="text-xs text-muted-foreground ml-2">
											{currentWords.toLocaleString()}{" "}
											words
										</span>
									</div>
									<div className="flex-1 overflow-auto">
										<div className="streaming-diff-active">
											<div className="prose prose-sm max-w-none dark:prose-invert">
												<EditorContent
													editor={currentEditor}
												/>
											</div>
										</div>
									</div>
								</div>

								{/* Selected version */}
								<div className="flex flex-col overflow-hidden">
									<div className="shrink-0 px-4 py-2 bg-primary/5 border-b border-primary/20">
										<span className="text-sm font-medium">
											Version {selectedVersion.version}
										</span>
										<span className="text-xs text-muted-foreground ml-2">
											{versionWords.toLocaleString()}{" "}
											words
										</span>
									</div>
									<div className="flex-1 overflow-auto">
										<div className="streaming-diff-active">
											<div className="prose prose-sm max-w-none dark:prose-invert">
												<EditorContent
													editor={versionEditor}
												/>
											</div>
										</div>
									</div>
								</div>
							</div>
						</TabsContent>
					</Tabs>
				)}

				{/* Footer */}
				<div className="shrink-0 px-6 py-4 border-t border-border flex items-center justify-between gap-4 bg-muted/30">
					<div className="flex items-center gap-4 text-sm text-muted-foreground">
						<span className="flex items-center gap-1.5">
							<ClockIcon className="h-3.5 w-3.5" />v
							{selectedVersion.version} &middot;{" "}
							{formatDate(selectedVersion.createdAt)}
						</span>
						<VersionAuthorBadge
							author={selectedVersion.author}
							size="md"
						/>
						{selectedVersion.changeDescription && (
							<span className="truncate max-w-[300px]">
								{selectedVersion.changeDescription}
							</span>
						)}
						{!isIdentical && (
							<span
								className={cn(
									"font-medium",
									wordDelta > 0 &&
										"text-success dark:text-green-400",
									wordDelta < 0 && "text-destructive",
									wordDelta === 0 && "text-muted-foreground",
								)}
							>
								{wordDelta > 0 ? "+" : ""}
								{wordDelta.toLocaleString()} words
							</span>
						)}
					</div>

					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => onOpenChange(false)}
						>
							Close
						</Button>
						<Button
							size="sm"
							onClick={onRestore}
							disabled={isRestoring}
						>
							{isRestoring ? (
								<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<RotateCcwIcon className="mr-2 h-4 w-4" />
							)}
							Restore Version {selectedVersion.version}
						</Button>
					</div>
				</div>
			</div>
		</div>
	);

	return createPortal(overlay, document.body);
}
