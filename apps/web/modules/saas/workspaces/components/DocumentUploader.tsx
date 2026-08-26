"use client";

import {
	resolveWorkspaceDocumentMime,
	WORKSPACE_DOCUMENT_ACCEPT_ATTR,
	WORKSPACE_DOCUMENT_FORMAT_LABELS,
	workspaceDocumentConfigFor,
} from "@repo/utils";
import {
	LiveAnnouncerRegion,
	useLiveAnnouncer,
} from "@saas/shared/components/LiveAnnouncer";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Progress } from "@ui/components/progress";
import { ScrollArea } from "@ui/components/scroll-area";
import { cn } from "@ui/lib";
import {
	CheckCircleIcon,
	FileTextIcon,
	Loader2Icon,
	RefreshCwIcon,
	UploadCloudIcon,
	XCircleIcon,
	XIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
	mapUploadError,
	type UploadErrorCode,
} from "../lib/upload-error-mapper";

interface DocumentUploaderProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceId: string;
	organizationId?: string | null;
	onSuccess?: () => void;
}

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_FILES = 10; // Maximum files per upload batch

/** "50MB" — derived so the copy cannot drift from the constant it describes. */
const MAX_FILE_SIZE_LABEL = `${Math.round(MAX_FILE_SIZE / (1024 * 1024))}MB`;

/**
 * "PDF, DOCX, DOC, …" — the canonical labels, for refusal copy.
 *
 * Derived from the shared vocabulary in `@repo/utils`, never typed out here: a
 * hand-kept list is how this dialog came to advertise four formats while the
 * allowlist carried five. See
 * docs/solutions/conventions/accept-and-validation-share-one-vocabulary.md.
 */
const WORKSPACE_DOCUMENT_SUPPORTED_FORMATS: string =
	WORKSPACE_DOCUMENT_FORMAT_LABELS.join(", ");

/**
 * Refusal copy for a type this surface does not admit. Names all three things a
 * refusal has to name: which file, what it was refused as, and what would have
 * been accepted. The bare "Unsupported file type" it replaces named none of
 * them, so a user holding a `.pptx` learned neither why nor what to bring
 * instead.
 */
function unsupportedTypeReason(filename: string, refusedType: string): string {
	return `${filename} is not a supported file type (${refusedType || "unknown type"}). Supported formats: ${WORKSPACE_DOCUMENT_SUPPORTED_FORMATS}.`;
}

type FileUploadStatus =
	| "pending"
	| "uploading"
	| "retrying"
	| "success"
	| "error";

interface FileUploadState {
	file: File;
	status: FileUploadStatus;
	progress: number;
	error?: string;
	errorCode?: UploadErrorCode;
	/**
	 * Refused by the selection gate (unsupported type / too large) rather than
	 * failed mid-upload. Such a row is removable but NOT retryable: the gate
	 * that refused it is deterministic, so a Retry could only refuse it again.
	 */
	refused?: boolean;
}

export function DocumentUploader({
	open,
	onOpenChange,
	workspaceId,
	organizationId,
	onSuccess,
}: DocumentUploaderProps) {
	const [selectedFiles, setSelectedFiles] = useState<FileUploadState[]>([]);
	const [isUploading, setIsUploading] = useState(false);
	const [dragOver, setDragOver] = useState(false);
	// A refused row is *inserted* already carrying its message, and assistive
	// technology stays silent for a node that arrives complete. The shared
	// region is mounted with the dialog and written to afterwards, which is what
	// makes the refusal audible. WCAG 2.1 AA, 4.1.3 Status Messages.
	const { announcement, announce, clearAnnouncement } = useLiveAnnouncer();

	// Get upload URL mutation
	const getUploadUrlMutation = useMutation({
		mutationFn: async ({
			file,
			mimeType,
		}: {
			file: File;
			mimeType: string;
		}) => {
			return orpc.documentWorkspaces.documents.createUploadUrl.call({
				workspaceId,
				filename: file.name,
				mimeType,
				size: file.size,
			});
		},
	});

	// Server-side upload mutation (for Vercel Blob and other providers without presigned URLs)
	const serverUploadMutation = useMutation({
		mutationFn: async (data: {
			filename: string;
			mimeType: string;
			size: number;
			fileData: string; // base64 encoded
		}) => {
			return orpc.documentWorkspaces.documents.serverUpload.call({
				workspaceId,
				filename: data.filename,
				mimeType: data.mimeType,
				size: data.size,
				fileData: data.fileData,
				organizationId,
			});
		},
	});

	// Confirm upload mutation (for S3/MinIO with presigned URLs)
	const confirmUploadMutation = useMutation({
		mutationFn: async (data: {
			filename: string;
			originalFilename: string;
			mimeType: string;
			size: number;
			s3Bucket: string;
			s3Path: string;
		}) => {
			return orpc.documentWorkspaces.documents.confirmUpload.call({
				workspaceId,
				...data,
				organizationId,
			});
		},
	});

	// Two gates, type before size. Returns the refusal reason, or null to admit.
	//
	// The type gate is a PAIR of calls and cannot be collapsed into one.
	// `resolveWorkspaceDocumentMime` is normalization, never a gate — it hands
	// back the caller's own value when nothing resolves, so `if (!resolved)`
	// would refuse nothing at all. `workspaceDocumentConfigFor` is the allowlist
	// lookup, and `undefined` is the refusal that keeps this fail-closed.
	//
	// It also has to be *this* surface's resolver. The forced-extension layer
	// lives in `workspace-document-upload.ts` and is the only rescue path for
	// `.xml`, `.json`, `.yaml` and `.yml`: the shared `EXTENSION_MIME` map in
	// `attachment.ts` deliberately carries no keys for them, because adding keys
	// there would advertise those extensions on the story-attachment picker,
	// whose gate refuses them. Gating through `resolveAttachmentMime` therefore
	// left the picker advertising the newly admitted formats and then refusing
	// every one of them. Fizzy #2139 / #2149.
	const validateFile = (file: File): string | null => {
		const resolved = resolveWorkspaceDocumentMime(file.name, file.type);
		if (!workspaceDocumentConfigFor(resolved)) {
			return unsupportedTypeReason(file.name, resolved);
		}
		if (file.size > MAX_FILE_SIZE) {
			return `${file.name} is too large (maximum ${MAX_FILE_SIZE_LABEL}).`;
		}
		return null;
	};

	const handleFileSelect = useCallback(
		(files: FileList | null) => {
			if (!files || files.length === 0) {
				return;
			}

			const picked = Array.from(files);
			const refusals: string[] = [];

			// (1) Duplicates, deliberately BEFORE the capacity slice.
			//
			// A duplicate never becomes a row, so it costs the queue nothing to
			// hold and must not consume a slot. Charging it one would refuse
			// genuinely new files whenever a user re-picks a folder: five new
			// files rejected because five already-queued ones came along. The
			// seen-set seeds from the queue and grows as the batch is walked, so
			// a batch that contains the same file twice also yields one row.
			const seen = new Set(
				selectedFiles.map((f) => `${f.file.name}:${f.file.size}`),
			);
			const fresh = picked.filter((file) => {
				const key = `${file.name}:${file.size}`;
				if (seen.has(key)) {
					return false;
				}
				seen.add(key);
				return true;
			});

			// (2) Capacity: take what fits, refuse only the excess.
			//
			// This used to `return` for the whole batch, so selecting eleven
			// files — or six with five already queued — discarded the valid ones
			// along with the excess. The limit is this component's own batch
			// queue (`MAX_FILES` minus what is already selected), not a
			// server-side workspace document limit.
			//
			// Refused rows do not count against it. They can never become
			// uploads, so holding one costs the queue nothing — the same
			// argument the duplicate check above already makes. Counting them
			// meant ten refusals filled the queue and silently discarded the
			// next valid pick.
			const occupied = selectedFiles.filter(
				(entry) => !entry.refused,
			).length;
			const remainingSlots = Math.max(0, MAX_FILES - occupied);
			const admitted = fresh.slice(0, remainingSlots);
			const overCapacity = fresh.slice(remainingSlots);

			// (3) Per-file gate. A refused file becomes an error row rather than
			// vanishing, so the reason stays on screen next to the name it
			// refused until the user removes it. Each file is judged on its own —
			// one refusal never discards its siblings.
			const newFiles: FileUploadState[] = admitted.map((file) => {
				const error = validateFile(file);
				if (!error) {
					return { file, status: "pending" as const, progress: 0 };
				}
				refusals.push(error);
				return {
					file,
					status: "error" as const,
					progress: 0,
					error,
					refused: true,
				};
			});

			if (overCapacity.length > 0) {
				const reason = `${overCapacity.map((f) => f.name).join(", ")} ${
					overCapacity.length === 1 ? "was" : "were"
				} not added — up to ${MAX_FILES} files can be queued at once.`;
				refusals.push(reason);
				// Over-capacity files are the one refusal that gets a toast
				// instead of a row: they were refused *because* the queue is
				// full, so giving each one a row would grow the very list that is
				// already at its limit. Type and size refusals are rows and need
				// no toast on top.
				toast.error(reason);
			}

			// One announcement per batch, naming every file it refused.
			if (refusals.length > 0) {
				announce(refusals.join(" "));
			}

			if (newFiles.length > 0) {
				setSelectedFiles((prev) => [...prev, ...newFiles]);
			}
		},
		[announce, selectedFiles],
	);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			setDragOver(false);
			handleFileSelect(e.dataTransfer.files);
		},
		[handleFileSelect],
	);

	const removeFile = (index: number) => {
		setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
	};

	// Helper to convert File to base64
	const fileToBase64 = async (file: File): Promise<string> => {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.readAsDataURL(file);
			reader.onload = () => {
				const result = reader.result as string;
				// Remove the data URL prefix (e.g., "data:application/pdf;base64,")
				const base64 = result.split(",")[1];
				resolve(base64);
			};
			reader.onerror = (error) => reject(error);
		});
	};

	// Private pipeline helper shared by the bulk-upload path AND the retry
	// handler so the two paths cannot diverge. The caller is
	// responsible for setting the row's pre-work status ("uploading" for the
	// bulk path, "retrying" for the retry path) BEFORE invoking this helper —
	// `uploadOne` then runs `createUploadUrl → fetch PUT → confirmUpload` and
	// transitions the row to the terminal `"success"` or `"error"` state.
	// Every catch path routes through `mapUploadError` so the row's `error`
	// field carries the cause-specific friendly message and never the raw
	// thrown `error.message`.
	const uploadOne = useCallback(
		async (file: File, index: number): Promise<boolean> => {
			// Resolve once and use the same value for the presign, the storage
			// PUT and the persistence call, so the stored row, the object's
			// Content-Type and the extractor's input cannot disagree.
			//
			// `File.type` is empty whenever the OS has no MIME registration for
			// the extension — the defect behind Fizzy #2139, which refused
			// `design.md` on machines with no `.md` registration and on most
			// drag-and-drops.
			const mimeType = resolveWorkspaceDocumentMime(file.name, file.type);
			try {
				// Step 1: Get upload info (presigned URL or server upload indicator).
				// Any thrown value here — typically an ORPCError — falls through
				// to the outer catch and is mapped by `mapUploadError`.
				const { uploadUrl, s3Bucket, s3Path, useServerUpload } =
					await getUploadUrlMutation.mutateAsync({ file, mimeType });

				setSelectedFiles((prev) =>
					prev.map((f, i) =>
						i === index ? { ...f, progress: 30 } : f,
					),
				);

				// Step 2: Upload to storage (either direct or via server)
				if (useServerUpload || !uploadUrl) {
					// Server-side upload for Vercel Blob and other providers
					// without presigned URLs.
					const fileData = await fileToBase64(file);

					setSelectedFiles((prev) =>
						prev.map((f, i) =>
							i === index ? { ...f, progress: 50 } : f,
						),
					);

					await serverUploadMutation.mutateAsync({
						filename: file.name,
						mimeType,
						size: file.size,
						fileData,
					});
				} else {
					// Direct upload with presigned URL (S3/MinIO/R2). The browser
					// PUT is the failing hop diagnosed in spec §2; on `TypeError:
					// Failed to fetch` (CORS preflight rejection) or any non-2xx
					// response, `mapUploadError` resolves a cause-specific code.
					const uploadResponse = await fetch(uploadUrl, {
						method: "PUT",
						body: file,
						headers: {
							"Content-Type": mimeType,
						},
					});

					if (!uploadResponse.ok) {
						// Forward the Response (not a wrapping Error) so the
						// mapper can switch on `.status` per spec §6c.
						throw uploadResponse;
					}

					setSelectedFiles((prev) =>
						prev.map((f, i) =>
							i === index ? { ...f, progress: 70 } : f,
						),
					);

					// Step 3: Confirm upload and start processing
					await confirmUploadMutation.mutateAsync({
						filename: s3Path.split("/").pop() || file.name,
						originalFilename: file.name,
						mimeType,
						size: file.size,
						s3Bucket,
						s3Path,
					});
				}

				setSelectedFiles((prev) =>
					prev.map((f, i) =>
						i === index
							? {
									...f,
									status: "success" as const,
									progress: 100,
									error: undefined,
									errorCode: undefined,
								}
							: f,
					),
				);

				return true;
			} catch (error) {
				const mapped = mapUploadError(error);
				// Preserve original error for logging — never rendered.
				// eslint-disable-next-line no-console
				console.error("[DocumentUploader] upload failed", mapped.cause);
				setSelectedFiles((prev) =>
					prev.map((f, i) =>
						i === index
							? {
									...f,
									status: "error" as const,
									error: mapped.userMessage,
									errorCode: mapped.code,
								}
							: f,
					),
				);
				return false;
			}
		},
		[getUploadUrlMutation, serverUploadMutation, confirmUploadMutation],
	);

	const uploadSingleFile = useCallback(
		async (index: number): Promise<boolean> => {
			const fileState = selectedFiles[index];
			if (!fileState) {
				return false;
			}

			// Bulk path: row → "uploading".
			setSelectedFiles((prev) =>
				prev.map((f, i) =>
					i === index
						? { ...f, status: "uploading" as const, progress: 10 }
						: f,
				),
			);

			return uploadOne(fileState.file, index);
		},
		[selectedFiles, uploadOne],
	);

	const retryRow = useCallback(
		async (index: number) => {
			// Capture the file reference BEFORE the state transition so the
			// retry pipeline does not race with concurrent state updates.
			let file: File | undefined;
			setSelectedFiles((prev) => {
				const row = prev[index];
				if (!row) {
					return prev;
				}
				file = row.file;
				return prev.map((f, i) =>
					i === index
						? {
								...f,
								status: "retrying" as const,
								progress: 10,
								error: undefined,
								errorCode: undefined,
							}
						: f,
				);
			});

			if (!file) {
				return;
			}

			const ok = await uploadOne(file, index);
			if (ok) {
				onSuccess?.();
			}
		},
		[onSuccess, uploadOne],
	);

	const handleUpload = async () => {
		if (selectedFiles.length === 0) {
			return;
		}

		setIsUploading(true);

		// Upload files in parallel (max 3 concurrent)
		const CONCURRENT_UPLOADS = 3;
		const pendingFiles = selectedFiles
			.map((f, i) => ({ file: f, index: i }))
			.filter((f) => f.file.status === "pending");

		let successCount = 0;
		let errorCount = 0;

		// Process in batches
		for (let i = 0; i < pendingFiles.length; i += CONCURRENT_UPLOADS) {
			const batch = pendingFiles.slice(i, i + CONCURRENT_UPLOADS);
			const results = await Promise.all(
				batch.map((f) => uploadSingleFile(f.index)),
			);
			successCount += results.filter((r) => r).length;
			errorCount += results.filter((r) => !r).length;
		}

		setIsUploading(false);

		if (successCount > 0) {
			toast.success(
				`${successCount} document${successCount > 1 ? "s" : ""} uploaded successfully! Processing will begin shortly.`,
			);
			onSuccess?.();
		}

		if (errorCount > 0) {
			toast.error(
				`${errorCount} document${errorCount > 1 ? "s" : ""} failed to upload.`,
			);
		}

		// Remove successful uploads from the list after a short delay
		setTimeout(() => {
			setSelectedFiles((prev) =>
				prev.filter((f) => f.status !== "success"),
			);
		}, 2000);
	};

	const handleClose = () => {
		if (!isUploading) {
			setSelectedFiles([]);
			// The queue and the region reset together, so reopening the dialog
			// never re-announces a refusal about files that are no longer listed.
			clearAnnouncement();
			onOpenChange(false);
		}
	};

	const pendingCount = selectedFiles.filter(
		(f) => f.status === "pending",
	).length;
	const _hasErrors = selectedFiles.some((f) => f.status === "error");

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Upload Documents</DialogTitle>
					<DialogDescription>
						Upload documents to this workspace. Supported formats:{" "}
						{WORKSPACE_DOCUMENT_FORMAT_LABELS.join(", ")}. Maximum
						size: 50MB per file. Up to {MAX_FILES} files at once.
					</DialogDescription>
				</DialogHeader>

				<div className="py-4 space-y-4">
					{/* Drop zone */}
					{/* biome-ignore lint/a11y/noStaticElementInteractions: file drop zone uses drag events, not click; file input inside handles keyboard/click access */}
					<div
						className={cn(
							"border-2 border-dashed rounded-lg p-6 text-center transition-colors",
							dragOver
								? "border-primary bg-primary/5"
								: "border-muted-foreground/25 hover:border-primary/50",
							isUploading && "pointer-events-none opacity-50",
						)}
						onDragOver={(e) => {
							e.preventDefault();
							setDragOver(true);
						}}
						onDragLeave={() => setDragOver(false)}
						onDrop={handleDrop}
					>
						<UploadCloudIcon className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
						<p className="text-sm text-muted-foreground mb-2">
							Drag and drop files here, or click to browse
						</p>
						{/*
						 * `sr-only` (off-screen but rendered), NOT `hidden`
						 * (= display:none). Chromium 124+ blocks the OS
						 * file picker on programmatic `.click()` of a
						 * display:none file input — the "click to browse"
						 * Button below uses exactly that pattern.
						 */}
						<input
							type="file"
							id="file-upload"
							className="sr-only"
							aria-hidden="true"
							tabIndex={-1}
							accept={WORKSPACE_DOCUMENT_ACCEPT_ATTR}
							multiple
							onChange={(e) => {
								handleFileSelect(e.target.files);
								// Reset so re-picking the same file fires again.
								// Without this a user who fixes nothing and
								// re-selects the refused file gets no event at
								// all — the input's value is unchanged — which
								// reads as the picker ignoring them. Both
								// sibling surfaces already do this.
								e.target.value = "";
							}}
						/>
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								document.getElementById("file-upload")?.click()
							}
							disabled={isUploading}
						>
							Browse Files
						</Button>
					</div>

					{/* Selected files list */}
					{selectedFiles.length > 0 && (
						<ScrollArea className="h-[200px] border rounded-lg">
							<div className="p-2 space-y-2">
								{selectedFiles.map((fileState, index) => (
									<div
										key={`${fileState.file.name}-${index}`}
										className="flex items-center gap-3 p-2 rounded-md bg-muted/50"
									>
										{/* Status icon. Spinners use motion-safe so users with
										    prefers-reduced-motion see a static icon (spec §6d, CLAUDE.md §design principle #4). */}
										{fileState.status === "pending" && (
											<FileTextIcon className="h-5 w-5 text-muted-foreground shrink-0" />
										)}
										{fileState.status === "uploading" && (
											<Loader2Icon className="h-5 w-5 text-primary shrink-0 motion-safe:animate-spin" />
										)}
										{fileState.status === "retrying" && (
											<Loader2Icon className="h-5 w-5 text-primary shrink-0 motion-safe:animate-spin" />
										)}
										{fileState.status === "success" && (
											<CheckCircleIcon className="h-5 w-5 text-success shrink-0" />
										)}
										{fileState.status === "error" && (
											<XCircleIcon className="h-5 w-5 text-destructive shrink-0" />
										)}

										{/* File info */}
										<div className="flex-1 min-w-0">
											<p className="text-sm font-medium truncate">
												{fileState.file.name}
											</p>
											<div className="flex items-center gap-2">
												<p className="text-xs text-muted-foreground">
													{(
														fileState.file.size /
														(1024 * 1024)
													).toFixed(2)}{" "}
													MB
												</p>
												{(fileState.status ===
													"uploading" ||
													fileState.status ===
														"retrying") && (
													<Progress
														value={
															fileState.progress
														}
														className="h-1 flex-1 max-w-[100px]"
													/>
												)}
												{fileState.status === "error" &&
													fileState.error && (
														<p
															role="alert"
															className="text-xs text-destructive truncate"
														>
															{fileState.error}
														</p>
													)}
											</div>
										</div>

										{/* File-row actions: Retry (only on error/retrying) +
										    Remove (on pending/error). Wrapped in a role="group"
										    so screen readers announce them as a single cluster. */}
										{(fileState.status === "pending" ||
											fileState.status === "error" ||
											fileState.status ===
												"retrying") && (
											// biome-ignore lint/a11y/useSemanticElements: <fieldset> would require a visible <legend>; aria-label on role="group" gives screen readers the cluster name without the visual chrome.
											<div
												role="group"
												aria-label="File actions"
												className="flex items-center gap-1 shrink-0"
											>
												{/* Retry is offered for a row that failed
												    mid-upload, never for one the
												    selection gate refused — that gate is
												    deterministic, so retrying could only
												    refuse the file again. A refused row is
												    removable, not retryable. */}
												{((fileState.status ===
													"error" &&
													!fileState.refused) ||
													fileState.status ===
														"retrying") && (
													<Button
														variant="ghost"
														size="icon-sm"
														aria-label="Retry upload"
														onClick={() =>
															retryRow(index)
														}
														disabled={
															fileState.status ===
															"retrying"
														}
													>
														<RefreshCwIcon
															className={cn(
																"h-4 w-4",
																fileState.status ===
																	"retrying" &&
																	"motion-safe:animate-spin",
															)}
														/>
													</Button>
												)}
												{(fileState.status ===
													"pending" ||
													fileState.status ===
														"error") && (
													<Button
														variant="ghost"
														size="icon-sm"
														aria-label="Remove file"
														onClick={() =>
															removeFile(index)
														}
														disabled={isUploading}
													>
														<XIcon className="h-4 w-4" />
													</Button>
												)}
											</div>
										)}
									</div>
								))}
							</div>
						</ScrollArea>
					)}

					{/* Mounted with the dialog, before any file can be picked, so
					    a refusal written into it later reads as an update to an
					    existing live region rather than an inserted node a screen
					    reader would skip. Last in the stack because `sr-only` is
					    position-absolute: it takes no visual space here, whereas
					    placing it first would add a `space-y-4` gap above the
					    drop zone. */}
					<LiveAnnouncerRegion
						announcement={announcement}
						data-testid="workspace-document-upload-announcer"
					/>
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={handleClose}
						disabled={isUploading}
					>
						{isUploading ? "Close" : "Cancel"}
					</Button>
					<Button
						onClick={handleUpload}
						disabled={pendingCount === 0 || isUploading}
					>
						{isUploading
							? "Uploading..."
							: `Upload ${pendingCount} File${pendingCount !== 1 ? "s" : ""}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
