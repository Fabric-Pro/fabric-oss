"use client";

import {
	CONTEXT_UPLOAD_ACCEPT_ATTR,
	contextUploadConfigFor,
	resolveContextUploadCategory,
	UPLOAD_SIZE_LIMITS,
} from "@repo/utils";
import { isValidExcalidrawContent } from "@repo/utils/attachment";
import {
	LiveAnnouncerRegion,
	useLiveAnnouncer,
} from "@saas/shared/components/LiveAnnouncer";
import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import {
	CheckIcon,
	FileSpreadsheetIcon,
	FileTextIcon,
	ImageIcon,
	Loader2Icon,
	UploadCloudIcon,
	XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	CONTEXT_UPLOAD_FORMATS_AND_LIMITS,
	oversizeReason,
	unsupportedTypeReason,
} from "../../lib/context-upload-copy";
import { DOCUMENT_TAG_OPTIONS } from "../../lib/document-tag-options";

export interface UploadedFile {
	id: string;
	name: string;
	size: number;
	mimeType: string;
	status: "uploading" | "processing" | "completed" | "failed";
	progress: number;
	error?: string;
	isExisting?: boolean; // true if from existing project context (edit mode)
	documentTag?: string | null;
}

interface WizardFileUploaderProps {
	sessionId: string;
	organizationId?: string;
	onFileUploaded: (contextId: string) => void;
	onFileRemoved: (contextId: string) => void;
	uploadedFiles: UploadedFile[];
	setUploadedFiles: React.Dispatch<React.SetStateAction<UploadedFile[]>>;
}

const POLL_INTERVAL = 2000; // 2 seconds
const MAX_POLL_ATTEMPTS = 60; // 2 minutes max polling

function getFileIcon(mimeType: string) {
	if (mimeType.includes("image")) {
		return ImageIcon;
	}
	if (
		mimeType.includes("spreadsheet") ||
		mimeType.includes("csv") ||
		mimeType.includes("excel")
	) {
		return FileSpreadsheetIcon;
	}
	return FileTextIcon;
}

/**
 * Row id for a file that has no server-side context yet — a queue-time refusal,
 * or an upload still waiting on `createUploadUrl`. The `upload_` prefix is
 * load-bearing: `handleRemoveFile` reads it to know a failed row can be dropped
 * from local state without a delete round-trip for a context that never existed.
 */
function makeLocalRowId(): string {
	return `upload_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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

export function WizardFileUploader({
	sessionId,
	organizationId,
	onFileUploaded,
	onFileRemoved,
	uploadedFiles,
	setUploadedFiles,
}: WizardFileUploaderProps) {
	const [isDragOver, setIsDragOver] = useState(false);
	const [isUploading, setIsUploading] = useState(false);
	// A queue-time refusal inserts a row that is *already* failed, and an
	// inserted node is not an update to a live region — screen readers stay
	// silent on it. This pre-mounted region is what carries the refusal.
	const { announcement, announce } = useLiveAnnouncer();
	const pollingRef = useRef<Map<string, number>>(new Map()); // Track poll attempts per file
	const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
	// Track files that have been notified as uploaded to avoid duplicate notifications
	const notifiedFilesRef = useRef<Set<string>>(new Set());

	// Notify parent of newly completed files (outside of render to avoid setState-during-render)
	// This effect runs AFTER the state update, so it's safe to call onFileUploaded here
	useEffect(() => {
		const completedFiles = uploadedFiles.filter(
			(f) =>
				f.status === "completed" &&
				!f.isExisting && // Don't notify for existing project contexts
				!notifiedFilesRef.current.has(f.id),
		);

		for (const file of completedFiles) {
			// Mark as notified before calling to prevent duplicate calls
			notifiedFilesRef.current.add(file.id);
			// Use setTimeout to ensure this runs after the current render cycle
			setTimeout(() => {
				onFileUploaded(file.id);
			}, 0);
		}
	}, [uploadedFiles, onFileUploaded]);

	// Poll for processing status updates
	useEffect(() => {
		const processingFiles = uploadedFiles.filter(
			(f) => f.status === "processing",
		);

		if (processingFiles.length === 0) {
			// No files processing, stop polling
			if (pollIntervalRef.current) {
				clearInterval(pollIntervalRef.current);
				pollIntervalRef.current = null;
			}
			return;
		}

		// Start polling if not already
		if (!pollIntervalRef.current) {
			pollIntervalRef.current = setInterval(async () => {
				try {
					const result = await orpcClient.wizard.tempContexts.list({
						sessionId,
						organizationId: organizationId ?? null,
					});

					// Update file statuses based on server response
					// Note: Do NOT call onFileUploaded here - it will be called by the effect above
					setUploadedFiles((prev) =>
						prev.map((file) => {
							if (file.status !== "processing") {
								return file;
							}

							const serverContext = result.contexts.find(
								(ctx) => ctx.id === file.id,
							);

							if (!serverContext) {
								return file;
							}

							// Track poll attempts
							const attempts =
								pollingRef.current.get(file.id) || 0;
							pollingRef.current.set(file.id, attempts + 1);

							if (
								serverContext.extractionStatus === "COMPLETED"
							) {
								// Processing complete - just update status
								// onFileUploaded will be called by the effect above
								pollingRef.current.delete(file.id);
								return {
									...file,
									status: "completed" as const,
									progress: 100,
									documentTag: serverContext.documentTag,
								};
							}

							if (serverContext.extractionStatus === "FAILED") {
								// Processing failed
								pollingRef.current.delete(file.id);
								return {
									...file,
									status: "failed" as const,
									error:
										serverContext.extractionError ||
										"Processing failed",
								};
							}

							// Still processing - update progress based on status
							if (attempts >= MAX_POLL_ATTEMPTS) {
								// Timeout
								pollingRef.current.delete(file.id);
								return {
									...file,
									status: "failed" as const,
									error: "Processing timeout",
								};
							}

							// Simulate progress while processing
							const newProgress = Math.min(
								70 + Math.floor(attempts * 0.5),
								95,
							);
							return {
								...file,
								progress: newProgress,
							};
						}),
					);
				} catch (error) {
					console.error("Failed to poll for status:", error);
				}
			}, POLL_INTERVAL);
		}

		return () => {
			if (pollIntervalRef.current) {
				clearInterval(pollIntervalRef.current);
				pollIntervalRef.current = null;
			}
		};
	}, [uploadedFiles, sessionId, organizationId, setUploadedFiles]);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(true);
	}, []);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);
	}, []);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			setIsDragOver(false);

			const files = Array.from(e.dataTransfer.files);
			if (files.length > 0) {
				handleFiles(files);
			}
		},
		[sessionId, organizationId],
	);

	const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files ? Array.from(e.target.files) : [];
		if (files.length > 0) {
			handleFiles(files);
		}
		// Reset input value to allow re-selecting the same file
		e.target.value = "";
	};

	/**
	 * The single funnel every picked or dropped file goes through, so the gates
	 * here are the gates for every way a file can enter this surface.
	 *
	 * Each file is judged before any network call, and judged on its own — a
	 * refused sibling never blocks the batch. Refusals become `failed` rows
	 * rather than a toast that scrolls away: an unsupported file used to start
	 * an upload, show "Uploading…", and only be refused by the server's 400 a
	 * round-trip later, while an oversize file produced no row at all and
	 * vanished with its toast.
	 *
	 * Two gates, type before size:
	 *   1. Type — `contextUploadConfigFor` is the allowlist lookup, and
	 *      `undefined` means this surface does not admit the type. Do NOT test
	 *      the resolved MIME for null instead: the resolver hands back the
	 *      caller's own value when nothing resolves, so it is never null.
	 *   2. Size — against the limit the *resolved* category carries, so an
	 *      untyped `.png` is sized as an image rather than falling through to
	 *      the larger FILE limit its `application/octet-stream` placeholder
	 *      would resolve to.
	 */
	const handleFiles = async (files: File[]) => {
		const admitted: { file: File; resolvedMimeType: string }[] = [];
		const refusedRows: UploadedFile[] = [];
		const refusals: string[] = [];

		for (const file of files) {
			const mimeType = file.type || "application/octet-stream";
			const { resolvedMimeType, category } = resolveContextUploadCategory(
				mimeType,
				file.name,
			);

			const maxSize = UPLOAD_SIZE_LIMITS[category];
			let refusal: string | null = null;
			if (!contextUploadConfigFor(resolvedMimeType)) {
				refusal = unsupportedTypeReason(file.name, resolvedMimeType);
			} else if (file.size > maxSize) {
				refusal = oversizeReason(file.name, maxSize);
			}

			if (refusal) {
				refusals.push(refusal);
				refusedRows.push({
					id: makeLocalRowId(),
					name: file.name,
					size: file.size,
					mimeType,
					status: "failed",
					progress: 0,
					error: refusal,
				});
				continue;
			}

			admitted.push({ file, resolvedMimeType });
		}

		if (refusedRows.length > 0) {
			setUploadedFiles((prev) => [...prev, ...refusedRows]);
			for (const refusal of refusals) {
				toast.error(refusal);
			}
			// One announcement per batch, naming every file it refused.
			announce(refusals.join(" "));
		}

		for (const { file, resolvedMimeType } of admitted) {
			await uploadFile(file, resolvedMimeType);
		}
	};

	/**
	 * Upload one file that has already cleared both gates in `handleFiles`.
	 * `resolvedMimeType` is threaded through rather than re-derived so the
	 * `Content-Type` this PUTs is the same type the gate admitted.
	 */
	const uploadFile = async (file: File, resolvedMimeType: string) => {
		// Create a temporary ID for tracking
		const tempId = makeLocalRowId();

		// Add file to upload list
		const uploadedFile: UploadedFile = {
			id: tempId,
			name: file.name,
			size: file.size,
			mimeType: file.type || "application/octet-stream",
			status: "uploading",
			progress: 0,
		};

		setUploadedFiles((prev) => [...prev, uploadedFile]);
		setIsUploading(true);

		try {
			// Excalidraw content pre-check (#1942): reject a malformed file
			// before upload; the extractor stores the raw JSON.
			if (file.name.toLowerCase().endsWith(".excalidraw")) {
				const text = await file.text();
				if (!isValidExcalidrawContent(text)) {
					throw new Error(
						"The file is not a valid Excalidraw document.",
					);
				}
			}

			// 1. Get signed upload URL
			const { contextId, signedUploadUrl, useServerUpload, contentType } =
				await orpcClient.wizard.tempContexts.createUploadUrl({
					sessionId,
					organizationId: organizationId ?? null,
					filename: file.name,
					mimeType: file.type || "application/octet-stream",
					size: file.size,
				});

			// Update with real context ID
			setUploadedFiles((prev) =>
				prev.map((f) =>
					f.id === tempId ? { ...f, id: contextId, progress: 20 } : f,
				),
			);

			// 2. Upload file
			if (useServerUpload) {
				toast.error(
					"Direct file upload not supported for current storage provider",
				);
				setUploadedFiles((prev) =>
					prev.map((f) =>
						f.id === contextId
							? {
									...f,
									status: "failed",
									error: "Upload method not supported",
								}
							: f,
					),
				);
				return;
			}

			if (!signedUploadUrl) {
				throw new Error("No upload URL provided");
			}

			// Update progress - uploading
			setUploadedFiles((prev) =>
				prev.map((f) =>
					f.id === contextId ? { ...f, progress: 40 } : f,
				),
			);

			// Upload to storage.
			//
			const uploadResponse = await fetch(signedUploadUrl, {
				method: "PUT",
				body: file,
				headers: {
					// Prefer the type the server resolved so the stored object
					// matches the row it persisted; fall back locally for a new
					// bundle talking to a server that predates the field.
					// `content-type` is excluded from the presign signature, so
					// differing from the signed value is accepted.
					"Content-Type": contentType ?? resolvedMimeType,
				},
			});

			if (!uploadResponse.ok) {
				throw new Error(`Upload failed: ${uploadResponse.statusText}`);
			}

			// Update progress - uploaded, starting processing
			setUploadedFiles((prev) =>
				prev.map((f) =>
					f.id === contextId
						? { ...f, progress: 60, status: "processing" }
						: f,
				),
			);

			// 3. Trigger processing workflow (returns immediately)
			const processResult = await orpcClient.wizard.tempContexts.process({
				contextId,
				organizationId: organizationId ?? null,
			});

			// If already processed, mark as complete
			// Note: onFileUploaded will be called by the effect that watches for completed files
			if (processResult.status === "already_processed") {
				setUploadedFiles((prev) =>
					prev.map((f) =>
						f.id === contextId
							? { ...f, progress: 100, status: "completed" }
							: f,
					),
				);
				toast.success(`${file.name} uploaded successfully`);
			} else {
				// Processing started - polling will handle the rest
				setUploadedFiles((prev) =>
					prev.map((f) =>
						f.id === contextId
							? { ...f, progress: 70, status: "processing" }
							: f,
					),
				);
				// Initialize poll counter
				pollingRef.current.set(contextId, 0);
			}
		} catch (error) {
			console.error("File upload error:", error);

			// Update status to failed
			setUploadedFiles((prev) =>
				prev.map((f) =>
					f.id === tempId || f.name === file.name
						? {
								...f,
								status: "failed",
								error:
									error instanceof Error
										? error.message
										: "Upload failed",
							}
						: f,
				),
			);

			toast.error(
				`Failed to upload ${file.name}: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		} finally {
			setIsUploading(false);
		}
	};

	const handleTagChange = async (fileId: string, tag: string) => {
		const documentTag = tag || null;

		// Update local state immediately
		setUploadedFiles((prev) =>
			prev.map((f) => (f.id === fileId ? { ...f, documentTag } : f)),
		);

		// Update on server
		try {
			await orpcClient.wizard.tempContexts.updateTag({
				contextId: fileId,
				organizationId: organizationId ?? null,
				documentTag,
			});
		} catch (error) {
			console.error("Failed to update tag:", error);
			toast.error("Failed to update document tag");
			// Revert local state
			setUploadedFiles((prev) =>
				prev.map((f) =>
					f.id === fileId ? { ...f, documentTag: null } : f,
				),
			);
		}
	};

	const handleRemoveFile = async (fileId: string) => {
		// Find the file to check if it's an existing project context
		const file = uploadedFiles.find((f) => f.id === fileId);

		// Existing project contexts can't be deleted from the wizard
		// (they would need to be deleted from the project page)
		if (file?.isExisting) {
			toast.info(
				"Existing files can be removed from the project settings page",
			);
			return;
		}

		// If the file failed before getting a real contextId, just remove from local state
		if (file?.status === "failed" && fileId.startsWith("upload_")) {
			setUploadedFiles((prev) => prev.filter((f) => f.id !== fileId));
			onFileRemoved(fileId);
			return;
		}

		try {
			// Stop polling for this file
			pollingRef.current.delete(fileId);

			// Call API to delete temp context
			await orpcClient.wizard.tempContexts.delete({
				contextId: fileId,
				organizationId: organizationId ?? null,
			});

			// Remove from local state
			setUploadedFiles((prev) => prev.filter((f) => f.id !== fileId));

			// Notify parent
			onFileRemoved(fileId);
		} catch (error) {
			console.error("Failed to remove file:", error);
			toast.error(
				`Failed to remove file: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	};

	return (
		<div className="space-y-4">
			{/* Drop zone */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: Drop zone requires drag event handlers */}
			<div
				className={cn(
					"relative overflow-hidden rounded-lg border-2 border-dashed transition-all",
					isDragOver
						? "border-primary bg-primary/5"
						: "border-muted-foreground/25 hover:border-muted-foreground/40",
					isUploading && "pointer-events-none opacity-60",
				)}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				{/* Background gradient on drag */}
				{isDragOver && (
					<div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-violet-500/10" />
				)}

				<div className="relative z-10 flex flex-col items-center justify-center p-6">
					<div className="mb-3 rounded-xl bg-muted p-3">
						<UploadCloudIcon className="h-6 w-6 text-muted-foreground" />
					</div>
					<p className="mb-1 text-sm font-medium">
						Drag and drop files here
					</p>
					{/* Derived from the shared vocabulary, so a format admitted
					    later is advertised at its real limit without anyone
					    remembering to edit a string here. The hand-written list
					    this replaced named six formats while the surface
					    accepted sixteen. */}
					<p className="mb-3 max-w-md text-pretty text-center text-xs text-muted-foreground">
						{CONTEXT_UPLOAD_FORMATS_AND_LIMITS}
					</p>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="relative z-20"
						disabled={isUploading}
						onClick={(e) => {
							e.stopPropagation();
							document
								.getElementById("wizard-file-input")
								?.click();
						}}
					>
						Browse Files
					</Button>
				</div>

				<input
					id="wizard-file-input"
					type="file"
					className="sr-only"
					accept={CONTEXT_UPLOAD_ACCEPT_ATTR}
					onChange={handleFileSelect}
					multiple
					disabled={isUploading}
				/>
			</div>

			{/* Uploaded files list */}
			{uploadedFiles.length > 0 && (
				<div className="space-y-2">
					{/* File count header */}
					<div className="flex items-center justify-between text-sm text-muted-foreground">
						<span>
							{uploadedFiles.length} file
							{uploadedFiles.length !== 1 ? "s" : ""} uploaded
						</span>
						{uploadedFiles.length > 5 && (
							<span className="text-xs">Scroll to see all</span>
						)}
					</div>
					{/* Scrollable file list with max height */}
					<div className="max-h-64 overflow-y-auto space-y-2 pr-1">
						{uploadedFiles.map((file) => {
							const FileTypeIcon = getFileIcon(file.mimeType);

							return (
								<div
									key={file.id}
									className={cn(
										"relative flex items-center justify-between rounded-lg border p-3 transition-colors overflow-hidden",
										file.status === "completed" &&
											"border-green-500/30 bg-green-500/5",
										file.status === "failed" &&
											"border-red-500/30 bg-red-500/5",
										(file.status === "uploading" ||
											file.status === "processing") &&
											"border-blue-500/30 bg-blue-500/5",
									)}
								>
									<div className="flex items-center gap-3 min-w-0 flex-1">
										<div
											className={cn(
												"shrink-0 rounded-lg p-2",
												file.status === "completed" &&
													"bg-green-500/10",
												file.status === "failed" &&
													"bg-red-500/10",
												(file.status === "uploading" ||
													file.status ===
														"processing") &&
													"bg-blue-500/10",
											)}
										>
											<FileTypeIcon
												className={cn(
													"h-4 w-4",
													file.status ===
														"completed" &&
														"text-success",
													file.status === "failed" &&
														"text-destructive",
													(file.status ===
														"uploading" ||
														file.status ===
															"processing") &&
														"text-blue-600",
												)}
											/>
										</div>
										<div className="min-w-0 flex-1">
											<p className="text-sm font-medium truncate">
												{file.name}
											</p>
											<div className="flex items-center gap-2 text-xs">
												{file.isExisting && (
													<span className="text-muted-foreground italic">
														Previously uploaded
													</span>
												)}
												{!file.isExisting &&
													file.status ===
														"completed" && (
														<span className="flex items-center gap-1 text-success">
															<CheckIcon className="h-3 w-3" />
															Processed
														</span>
													)}
												{file.status ===
													"uploading" && (
													<span className="flex items-center gap-1 text-blue-600">
														<Loader2Icon className="h-3 w-3 animate-spin" />
														Uploading...
													</span>
												)}
												{file.status ===
													"processing" && (
													<span className="flex items-center gap-1 text-blue-600">
														<Loader2Icon className="h-3 w-3 animate-spin" />
														Processing...
													</span>
												)}
												{file.status === "failed" && (
													<span className="text-destructive">
														Failed:{" "}
														{file.error ||
															"Unknown error"}
													</span>
												)}
												<span className="text-muted-foreground">
													{formatFileSize(file.size)}
												</span>
											</div>
										</div>
									</div>

									{/* Document tag dropdown for completed NEW files */}
									{file.status === "completed" &&
										!file.isExisting && (
											<select
												value={file.documentTag || ""}
												onChange={(e) =>
													handleTagChange(
														file.id,
														e.target.value,
													)
												}
												className="shrink-0 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
											>
												{DOCUMENT_TAG_OPTIONS.map(
													(opt) => (
														<option
															key={opt.value}
															value={opt.value}
														>
															{opt.label}
														</option>
													),
												)}
											</select>
										)}

									{/* Read-only tag badge for existing files */}
									{file.status === "completed" &&
										file.isExisting &&
										file.documentTag && (
											<span className="shrink-0 rounded-md border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
												{DOCUMENT_TAG_OPTIONS.find(
													(o) =>
														o.value ===
														file.documentTag,
												)?.label || file.documentTag}
											</span>
										)}

									{/* Progress bar for uploading/processing */}
									{(file.status === "uploading" ||
										file.status === "processing") && (
										<div className="absolute bottom-0 left-0 right-0 h-1 bg-muted overflow-hidden rounded-b-lg">
											<div
												className="h-full bg-blue-500 transition-all duration-300"
												style={{
													width: `${file.progress}%`,
												}}
											/>
										</div>
									)}

									{/* Hide remove button for existing project contexts */}
									{!file.isExisting && (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="shrink-0 ml-2"
											aria-label={`Remove ${file.name}`}
											onClick={() =>
												handleRemoveFile(file.id)
											}
											disabled={
												file.status === "uploading" ||
												file.status === "processing"
											}
										>
											<XIcon className="h-4 w-4" />
										</Button>
									)}
								</div>
							);
						})}
					</div>
				</div>
			)}

			{/* Mounted with the surface, before any file can be picked, so a
			    refusal written into it later reads as an update to an existing
			    live region rather than an inserted node a screen reader would
			    skip. Last because `sr-only` is position-absolute — `space-y-4`
			    cannot give it a visible gap, and placing it first would push
			    the dropzone down by one step. */}
			<LiveAnnouncerRegion
				announcement={announcement}
				data-testid="wizard-upload-announcer"
			/>
		</div>
	);
}
