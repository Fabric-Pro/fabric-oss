"use client";

import {
	AI_CHAT_ALLOWED_EXTENSIONS,
	AI_CHAT_BINARY_DOCUMENT_MIME_TYPES,
	AI_CHAT_CLIENT_MIME_TYPES,
	AI_CHAT_TEXT_MIME_TYPES,
	AI_CHAT_WORKBOOK_SIGNATURE_BYTES,
	type AiChatExtractionOutcome,
	type AiChatWorkbookClassification,
	applyAiChatTextBudget,
	buildAiChatAttachmentEntry,
	classifyAiChatWorkbook,
	DEFAULT_AI_CHAT_MAX_FILE_BYTES,
	isAiChatWorkbookFilename,
	isClientRenderableAiChatImage,
} from "@repo/utils/ai-chat-attachment";
import {
	encodedSizeOf,
	MAX_TOTAL_CONTEXT_BYTES,
} from "@saas/projects/lib/ai-context-budget";
import {
	compressImage,
	prepareImageForAi,
} from "@saas/projects/lib/image-upload-utils";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { guardOpenApiAttachment } from "./openapi-attachment-guard";

/**
 * Entry point that produced this attachment. Used solely by the telemetry
 * emitter in `CopilotSidebarInput` (per spec §14) — never branches runtime
 * behavior. Defaults to `"paperclip"` when callers do not supply it (the
 * paperclip is the historical default and the only one before paste/drop
 * landed).
 */
export type AttachmentSource = "paperclip" | "paste" | "drop";

/** Attached file for document upload */
export interface AttachedFile {
	id: string;
	file: File;
	name: string;
	type: string;
	size: number;
	/** Document ID after upload (null if pending) */
	documentId: string | null;
	/** Chat ID where document is stored (for RAG retrieval) */
	chatId?: string;
	/** Upload status */
	status: "pending" | "uploading" | "processing" | "ready" | "error";
	/** Error message if status is error */
	error?: string;
	/** Extracted text content (for text files read client-side, or fetched after processing) */
	extractedContent?: string;
	/**
	 * What was actually read out of this file — truncation, no readable text, or
	 * a reason it could not be read at all.
	 *
	 * A second dimension alongside `status`, not a replacement for it. `status`
	 * tracks the upload round-trip; this tracks the content. They genuinely
	 * disagree: a password-protected workbook uploads perfectly and carries
	 * nothing, which is exactly the case that used to render as a clean `ready`
	 * chip.
	 *
	 * Two producers write it, and which one you get depends on the partition the
	 * file lands in. Binary documents are extracted server-side and the
	 * procedure returns the outcome. Text formats are read in the browser and
	 * bounded there, so the outcome is built client-side and carries a character
	 * count rather than rows and sheets. Only images leave it `undefined` —
	 * nothing reads text out of them on this path.
	 */
	extraction?: AiChatExtractionOutcome;
	/** Whether this is an image file */
	isImage?: boolean;
	/**
	 * Telemetry-only: which entry point produced this chip. Read by the
	 * `copilot_attachment_added` emitter in the input factory after the chip
	 * transitions to `ready`. Per spec §14, never gates runtime behavior.
	 */
	source?: AttachmentSource;
}

/**
 * Format vocabulary, size cap, and the text/binary/image partition all come
 * from `@repo/utils/ai-chat-attachment` so this hook and the server admission
 * path cannot drift apart. The client set is deliberately narrower than the
 * server's allowlist — see that module on why TIFF is server-only.
 *
 * This validation is advisory. The server is authoritative: `accept` is only a
 * picker hint, and paste/drop bypass it entirely.
 */
const MAX_FILE_SIZE = DEFAULT_AI_CHAT_MAX_FILE_BYTES;
const TEXT_TYPES = AI_CHAT_TEXT_MIME_TYPES;
const DOCUMENT_TYPES = AI_CHAT_BINARY_DOCUMENT_MIME_TYPES;
const ALLOWED_TYPES = AI_CHAT_CLIENT_MIME_TYPES;
const ALLOWED_EXTENSIONS = AI_CHAT_ALLOWED_EXTENSIONS;

interface UseCopilotDocumentUploadOptions {
	organizationId?: string | null;
	/**
	 * Called when extracted content becomes available for a file, with the
	 * finished rag-context entry — the `[Uploaded Document: …]` /
	 * `[Uploaded Image: …]` envelope, filename already neutralized by
	 * `buildAttachmentContextEntry`. Callers push it into their rag-context
	 * state and nothing else; deliberately NOT `(fileName, content)`, so no
	 * host can interpolate a raw filename into the model's prompt.
	 */
	onContentExtracted?: (entry: string) => void;
	/**
	 * Called synchronously the moment a chip transitions to `ready`. Used by
	 * the `CopilotSidebarInput` factory to emit `copilot_attachment_added`
	 * telemetry — a `useEffect` over `attachedFiles` cannot observe
	 * this transition reliably because the upload pipeline frequently writes
	 * `ready` and the Send handler calls `clearAttachments()` in the same
	 * React render batch (the effect sees `processing → []`).
	 *
	 * The callback receives the minimal PII-free shape the telemetry payload
	 * needs. Per `fabric/standards/global/error-handling.md`: filename and
	 * content stay inside the hook and never reach this callback.
	 */
	onAttachmentReady?: (info: {
		id: string;
		mime: string;
		sizeBytes: number;
		source: AttachmentSource;
	}) => void;
	/**
	 * Restrict the image MIME allowlist for this caller. When provided, image
	 * files are validated against this narrower set instead. Non-image types
	 * are unaffected. Default: the full client-renderable image set.
	 *
	 * Used by the AI Feature Assistant (StoryWorkspace) to limit attachments
	 * to PNG/JPEG, while DocumentEditor / DocumentGeneratorEditor keep accepting
	 * GIF and WEBP.
	 */
	allowedImageTypes?: readonly string[];
	/**
	 * Maximum number of image chips per session. When the cap is reached,
	 * additional image attachments are rejected with an inline toast. Non-image
	 * files are unaffected. Default: no cap.
	 *
	 * Enforced before compression and chip creation so we don't waste compute
	 * on rejected files.
	 */
	maxImageCount?: number;
	/**
	 * Override the max longest-side dimension when compressing image uploads on
	 * this surface. Defaults to the module-level `MAX_IMAGE_DIMENSION` (2000)
	 * inside `compressImage` when undefined. Used by the AI Feature Assistant
	 * surface (1024 px per spec 2026-05-19-feature-assistant-images §5.1);
	 * document editor surfaces inherit the existing 2000 px default.
	 */
	compressionMaxDimension?: number;
	/**
	 * Override the JPEG canvas quality when compressing image uploads on this
	 * surface. Defaults to 0.85 inside `compressImage` when undefined. Used by
	 * the AI Feature Assistant surface (0.80 per spec
	 * 2026-05-19-feature-assistant-images §5.1); document editor surfaces
	 * inherit the existing 0.85 default.
	 */
	compressionQuality?: number;
	/**
	 * Report what the host is ALREADY carrying in rag context, so an attachment
	 * can be judged against the request it will actually ride in rather than on
	 * its own.
	 *
	 * The hook can only see the files in front of it; the entries already
	 * published by the host outlive any one message and are what push a request
	 * over the body cap. Without this, two images that each satisfy every
	 * per-file rule are both accepted and the request is refused with a 413
	 * (Fizzy #2167). Read through a callback rather than passed as a value so
	 * the long-lived `addFiles` closure always sees current state.
	 *
	 * `imageCount` also makes `maxImageCount` mean what it says. Chip state is
	 * cleared on every send, so counting chips caps images per MESSAGE while the
	 * copy promises per SESSION; the host's resident entries are the honest
	 * count. Default when omitted: fall back to chip state, preserving existing
	 * behaviour for surfaces that don't supply it.
	 */
	getResidentContext?: () => { bytes: number; imageCount: number };
}

interface UseCopilotDocumentUploadReturn {
	attachedFiles: AttachedFile[];
	handleFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
	/**
	 * Add files directly (paste/drop entry points). Runs the same allowlist and
	 * size check that `handleFileSelect` runs — within this hook there is one
	 * validation locus, so paste, drop, and the picker cannot diverge. Per spec
	 * §3.2.
	 *
	 * Scope note: "one locus" is a statement about this hook, NOT about the app.
	 * Only `CopilotSidebarInput` calls this hook. Loom Direct carries its own
	 * `handleFileSelect` with its own allowlist and cap, and Nexus queues files
	 * with no client validation at all. Read the sentence above as app-wide and
	 * you will conclude the three AI surfaces share a validation path; they do
	 * not, and the server is the only common gate.
	 *
	 * The optional `source` arg tags the resulting `AttachedFile` rows for the
	 * telemetry emitter in `CopilotSidebarInput` (per spec §14). It defaults
	 * to `"paperclip"` so existing callers compile without change. Telemetry
	 * only — does not gate runtime behavior.
	 */
	addFiles: (
		files: FileList | readonly File[],
		source?: AttachmentSource,
	) => Promise<void>;
	removeAttachment: (fileId: string) => void;
	uploadAttachments: () => Promise<{
		documentIds: string[];
		chatId: string | undefined;
		uploadedFiles: Array<{
			name: string;
			documentId: string;
			chatId: string | undefined;
			type: string;
			size: number;
			extractedContent?: string;
			/**
			 * S3 storage key returned by the upload-url procedure. Used by the
			 * History drawer's per-message attachment persistence so the
			 * read-side procedures can sign a fresh GET URL on every load
			 * (signed URLs go stale within an hour and we don't store the
			 * stale URL — only the key).
			 */
			s3Path?: string;
		}>;
	}>;
	clearAttachments: () => void;
	isUploading: boolean;
	/**
	 * True while any `addFiles` invocation is still compressing images before
	 * the chip lands in `attachedFiles`. Callers gate Send on this so the user
	 * can't fire `uploadAttachments()` in the window between paste/drop and
	 * the chip appearing — that race would omit the image from the message
	 * and leave a ghost `pending` chip after `clearAttachments()` runs.
	 */
	isPreparing: boolean;
	fileInputRef: React.RefObject<HTMLInputElement | null>;
}

function isTextFile(mimeType: string): boolean {
	return TEXT_TYPES.includes(mimeType);
}

/**
 * Gates canvas compression and the `data:` URL read below.
 *
 * Deliberately "can a browser decode this", not "is this an image". The two
 * coincide here only because this surface's format list stops short of TIFF;
 * a surface that accepts TIFF and reused an image-prefix test would hand a
 * canvas an image it cannot decode, then ship a `data:image/tiff` vision part
 * the model rejects.
 */
function isImageFile(mimeType: string): boolean {
	return isClientRenderableAiChatImage(mimeType);
}

function isBinaryDocument(mimeType: string): boolean {
	return DOCUMENT_TYPES.includes(mimeType);
}

/**
 * Read a blob's bytes using FileReader.
 *
 * Deliberately FileReader rather than `Blob.arrayBuffer()`: it matches the two
 * readers below, and `Blob.arrayBuffer` is absent in jsdom (so the upload
 * hook's tests could never exercise the signature check through it) as well as
 * on older Safari.
 */
function readBlobAsBytes(blob: Blob): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () =>
			resolve(new Uint8Array(reader.result as ArrayBuffer));
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(blob);
	});
}

/**
 * Leading bytes for each file the workbook classifier can speak about, aligned
 * to the caller's list by index. Non-workbook filenames read `null` — no read
 * at all, and the classifier accepts them regardless.
 *
 * A read failure also maps to `null`, which skips the client check for that
 * file rather than rejecting it. This check is advisory; the server re-runs it
 * on the real bytes, so a browser that cannot read a slice must not manufacture
 * a rejection the server would not make.
 */
async function readWorkbookSignatures(
	files: readonly File[],
): Promise<Array<Uint8Array | null>> {
	return Promise.all(
		files.map(async (file) => {
			if (!isAiChatWorkbookFilename(file.name)) {
				return null;
			}
			try {
				return await readBlobAsBytes(
					file.slice(0, AI_CHAT_WORKBOOK_SIGNATURE_BYTES),
				);
			} catch {
				return null;
			}
		}),
	);
}

/**
 * Toast copy per rejection reason, in the register of the errors around it.
 * Tone per `fabric/standards/ai/ai-copy-tone.md` — advisory, and "likely" for
 * the password branch because OLE is the container for every legacy Office
 * format, so the signature can only guess (see the classifier's own note).
 */
function workbookRejectionMessage(
	classification: Exclude<AiChatWorkbookClassification, "accepted">,
	filename: string,
): string {
	switch (classification) {
		case "legacy-unsupported":
			return `File "${filename}" is in the legacy Excel format. You can save it as .xlsx and attach it again.`;
		case "likely-password-protected":
			return `File "${filename}" couldn't be read — it's likely password-protected. You may want to attach a copy without protection.`;
		case "unreadable":
			return `File "${filename}" couldn't be read. It may be corrupt, or not a valid .xlsx workbook.`;
	}
}

/** Read a text file's content using FileReader */
function readFileAsText(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsText(file);
	});
}

/** Read a file as base64 data URL */
function readFileAsDataURL(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

/**
 * Build the rag-context entry for one attached file.
 *
 * The envelope, its tag, and both neutralizers now live in
 * `@repo/utils/ai-chat-attachment` rather than here, because this hook is not
 * the only producer: the server-side story-media resolver builds the same
 * entry, and R6 wants exactly one place that constructs it and exactly one that
 * neutralizes. Re-exported under the original name so the existing call sites
 * and their tests keep working.
 *
 * `onContentExtracted` still hands callers the finished string rather than
 * `(fileName, content)`: no call site holds a filename to interpolate, so a new
 * host cannot forget the neutralizer, because it is never given the input the
 * neutralizer protects.
 */
export const buildAttachmentContextEntry = buildAiChatAttachmentEntry;

/** One decimal place, so a budget message reads "1.4 MB" rather than "1.43871 MB". */
function formatBudgetMb(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function useCopilotDocumentUpload(
	options: UseCopilotDocumentUploadOptions,
): UseCopilotDocumentUploadReturn {
	const {
		organizationId,
		onContentExtracted,
		onAttachmentReady,
		allowedImageTypes,
		maxImageCount,
		compressionMaxDimension,
		compressionQuality,
		getResidentContext,
	} = options;
	const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
	const [isUploading, setIsUploading] = useState(false);
	// Counter (not boolean) so concurrent paste/drop don't toggle prematurely.
	const [preparingCount, setPreparingCount] = useState(0);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const chatIdRef = useRef<string | undefined>(undefined);

	// Mirror the latest image-cap config so the `addFiles` closure can read
	// the current count without re-creating itself (which would break its
	// useCallback identity). Same pattern as `onAttachmentReadyRef`.
	const attachedFilesRef = useRef<AttachedFile[]>([]);
	attachedFilesRef.current = attachedFiles;
	const maxImageCountRef = useRef<number | undefined>(maxImageCount);
	maxImageCountRef.current = maxImageCount;

	// Same mirror pattern, for the same reason: `addFiles` is declared with an
	// empty dependency array, so a value read directly inside it would be the
	// one that existed on first render. This flag is admin-toggled and can
	// change while the sidebar is open.
	const specContextEnabled = useFeatureFlag("OPENAPI_SPEC_CONTEXT");
	const specContextEnabledRef = useRef(specContextEnabled);
	specContextEnabledRef.current = specContextEnabled;
	const getResidentContextRef = useRef<
		(() => { bytes: number; imageCount: number }) | undefined
	>(getResidentContext);
	getResidentContextRef.current = getResidentContext;
	const allowedImageTypesRef = useRef<readonly string[] | undefined>(
		allowedImageTypes,
	);
	allowedImageTypesRef.current = allowedImageTypes;
	// Surface-scoped compression overrides (spec 2026-05-19-feature-assistant-
	// images §5.1). Mirror the per-call config into refs so the long-lived
	// `addFiles` closure reads the current values without re-creating itself.
	// Same pattern as `allowedImageTypesRef`. When both are `undefined`,
	// `addFiles` calls `compressImage(file)` with no options so the default-path
	// (2000 / 0.85) behaviour is byte-identical for the document editor.
	const compressionMaxDimensionRef = useRef<number | undefined>(
		compressionMaxDimension,
	);
	compressionMaxDimensionRef.current = compressionMaxDimension;
	const compressionQualityRef = useRef<number | undefined>(
		compressionQuality,
	);
	compressionQualityRef.current = compressionQuality;
	// In-flight image reservations: images that passed validation but whose
	// chips haven't landed in `attachedFiles` yet (compression still running).
	// Counted against `maxImageCount` so a second paste/drop during the
	// compression window can't bypass the cap.
	const inFlightImageCountRef = useRef(0);

	// Mirror the latest `onAttachmentReady` so the callback can be invoked
	// from inside the long-lived `uploadAttachments` closure without making
	// the closure depend on the callback identity (which would force every
	// caller to memoize it).
	const onAttachmentReadyRef = useRef<typeof onAttachmentReady>(undefined);
	onAttachmentReadyRef.current = onAttachmentReady;

	const addFiles = useCallback(
		async (
			files: FileList | readonly File[],
			source: AttachmentSource = "paperclip",
		): Promise<void> => {
			const list = Array.from(files);
			if (list.length === 0) {
				return;
			}

			// Workbook signatures are read HERE, before the image-cap state is
			// read below, and deliberately not inside the validation loop.
			//
			// The loop must stay synchronous: it reads `currentImageCount` and
			// then reserves against `inFlightImageCountRef` further down, and
			// those two only guard `maxImageCount` against a concurrent
			// paste/drop while nothing awaits between them. Await inside the
			// loop and two invocations both read a pre-reservation count and
			// both admit a full quota of images. Hoisting the only await above
			// the count read keeps read → validate → reserve one atomic block:
			// whichever invocation resumes first finishes reserving before the
			// other can look.
			const signatures = await readWorkbookSignatures(list);

			const callerImageAllowlist = allowedImageTypesRef.current;
			const imageCap = maxImageCountRef.current;
			// What the host is already carrying, when it can tell us. Chip state
			// is cleared on every send, so counting chips alone caps images per
			// message while the copy promises per session (Fizzy #2167).
			const resident = getResidentContextRef.current?.();
			const currentImageCount =
				(resident?.imageCount ??
					attachedFilesRef.current.filter((f) => f.isImage).length) +
				inFlightImageCountRef.current;
			let acceptedImageCount = 0;

			const validated: Array<{ file: File; isImage: boolean }> = [];

			for (const [index, file] of list.entries()) {
				if (file.size > MAX_FILE_SIZE) {
					toast.error(
						`File "${file.name}" exceeds the ${Math.round(MAX_FILE_SIZE / (1024 * 1024))}MB limit (${(file.size / (1024 * 1024)).toFixed(2)}MB)`,
					);
					continue;
				}

				// Workbook signature check. Placed ahead of both guards below
				// on purpose:
				//
				//   - Ahead of the extension/MIME guard, because `.xls` is
				//     absent from the allowed extensions and that guard would
				//     refuse it first with the generic "not supported" line —
				//     the user would never learn `.xlsx` is what to save as
				//     (AE3).
				//   - Ahead of the empty-file notice, because a 0-byte `.xlsx`
				//     is unreadable (R12) and is refused here. Letting the
				//     notice fire first would promise "attached" and then take
				//     it back in the very next toast. FR-15's accept-an-empty-
				//     file behavior still holds for every non-workbook format.
				//
				// Only workbook filenames carry a signature; everything else is
				// `null` here and falls through untouched.
				//
				// Advisory only. `accept` is a picker hint, paste/drop bypass
				// it, and any caller can post straight to the oRPC endpoint —
				// the server re-runs this on the bytes it actually received.
				const signature = signatures[index];
				if (signature) {
					const classification = classifyAiChatWorkbook(
						signature,
						file.name,
					);
					if (classification !== "accepted") {
						toast.error(
							workbookRejectionMessage(classification, file.name),
						);
						continue;
					}
				}

				// An empty (0-byte) file carries no content. Per FR-15 we
				// still accept it — the user may have attached it deliberately —
				// but surface an informational notice so it is not silently
				// ingested as zero context. Intentionally no `continue`: the file
				// falls through to normal validation below.
				if (file.size === 0) {
					toast.info(
						`File "${file.name}" is empty — attached, but it adds no context.`,
					);
				}

				const isImage = isImageFile(file.type);

				// Image-specific allowlist (caller-scoped). For non-image
				// files, the broader `ALLOWED_TYPES` check below applies.
				if (
					isImage &&
					callerImageAllowlist &&
					!callerImageAllowlist.includes(file.type)
				) {
					toast.error(
						`File type not supported: ${file.name}. Supported image formats: ${callerImageAllowlist
							.map((t) => t.replace("image/", "").toUpperCase())
							.join(", ")}.`,
					);
					continue;
				}

				if (
					!ALLOWED_TYPES.includes(file.type) &&
					!file.name.match(ALLOWED_EXTENSIONS)
				) {
					toast.error(`File type not supported: ${file.name}`);
					continue;
				}

				if (isImage && imageCap !== undefined) {
					if (currentImageCount + acceptedImageCount >= imageCap) {
						toast.error(
							`You can attach up to ${imageCap} image${imageCap === 1 ? "" : "s"} per chat session. Remove an image to add another.`,
						);
						continue;
					}
					acceptedImageCount += 1;
				}

				validated.push({ file, isImage });
			}

			if (validated.length === 0) {
				return;
			}

			// Compression: run in parallel for batch performance, but preserve
			// user-selected order via the Promise.all index. Compression for
			// non-image files is a no-op. `compressImage` returns the original
			// File for small images, GIFs, and cases where compression didn't
			// actually shrink — so it's safe to call universally.
			//
			// `preparingCount` is incremented around this await so the Send
			// button can stay disabled in the window between paste/drop and
			// the chip landing in state; otherwise a user who types text and
			// immediately pastes an image can fire `uploadAttachments` before
			// the image exists.
			const reservedImageCount = validated.filter(
				(v) => v.isImage,
			).length;
			inFlightImageCountRef.current += reservedImageCount;
			setPreparingCount((c) => c + 1);
			let prepared: Array<{ file: File; isImage: boolean } | null>;
			try {
				try {
					prepared = await Promise.all(
						validated.map(async ({ file, isImage }) => {
							if (!isImage) {
								return { file, isImage };
							}
							// Forward surface-scoped overrides only when at
							// least one is defined. With both undefined the
							// call is exactly `compressImage(file)` so the
							// existing default-path tests (and behaviour)
							// stay intact for the document editor.
							const compressionOptions =
								compressionMaxDimensionRef.current !==
									undefined ||
								compressionQualityRef.current !== undefined
									? {
											maxDimension:
												compressionMaxDimensionRef.current,
											quality:
												compressionQualityRef.current,
										}
									: undefined;

							let compressed = file;
							try {
								compressed = await compressImage(
									file,
									compressionOptions,
								);
							} catch (err) {
								console.warn(
									`[Upload] compressImage failed for ${file.name}; using original.`,
									err,
								);
							}

							// Deliberately OUTSIDE the catch above. `compressImage`
							// is pixel-blind — it shrinks by dimension, so an image
							// already inside the dimension cap comes back untouched
							// however heavy it is, which is how a screenshot inside
							// the upload limit still reached the model over the
							// provider's ENCODED-size ceiling and had the whole
							// request refused. Folding the budget decision into
							// that catch would turn "this image is too big to send"
							// back into "use the original" — the very outcome this
							// guards against. `compressImageToBudget` handles its
							// own decode failures and never rejects.
							const shaped = await prepareImageForAi(compressed);
							if (!shaped.ok) {
								toast.error(shaped.error);
								return null;
							}
							return { file: shaped.file, isImage };
						}),
					);
				} finally {
					setPreparingCount((c) => c - 1);
				}

				// Cumulative body budget. Deliberately here rather than inside the
				// `Promise.all` above: the running total has to be accumulated in
				// a fixed order, and concurrent tasks would each read a total that
				// does not yet include the others.
				//
				// Judged on the ENCODED size, because that is what the entry costs
				// once it becomes a base64 data URL in the request, and against the
				// host's already-resident context, because the request carries that
				// too. Everything up to here is per-file; per-file checks cannot
				// catch two individually-legal images that only break the cap
				// together, which is what killed the thread in Fizzy #2167.
				let projectedBytes =
					getResidentContextRef.current?.().bytes ?? 0;

				for (const entry of prepared) {
					if (!entry) {
						// Rejected above with its own toast.
						continue;
					}
					const { file, isImage } = entry;

					const entryBytes = encodedSizeOf(file.size);
					if (projectedBytes + entryBytes > MAX_TOTAL_CONTEXT_BYTES) {
						const remaining = Math.max(
							0,
							MAX_TOTAL_CONTEXT_BYTES - projectedBytes,
						);
						toast.error(
							remaining === 0
								? `"${file.name}" won't fit — this conversation is already at its attachment limit. Start a new chat, or remove an attachment, to add more.`
								: `"${file.name}" is too large for this conversation (${formatBudgetMb(entryBytes)} needed, ${formatBudgetMb(remaining)} left). Try a smaller crop or a lower-resolution copy.`,
						);
						continue;
					}
					projectedBytes += entryBytes;

					const fileId = `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;

					const attachedFile: AttachedFile = {
						id: fileId,
						file,
						name: file.name,
						type: file.type,
						size: file.size,
						documentId: null,
						status: "pending",
						isImage,
						source,
					};

					setAttachedFiles((prev) => [...prev, attachedFile]);

					// Read content client-side for text files and images.
					// The character budget is applied here, at the point the
					// string is produced: everything downstream of this line
					// treats `extractedContent` as the model's copy, so a bound
					// applied later would be a bound applied after the prompt
					// was already assembled.
					if (isTextFile(file.type)) {
						readFileAsText(file).then((content) => {
							const budgeted = applyAiChatTextBudget(content);
							// An API spec cut at 100k characters is worse than
							// no spec: the model gets broken JSON and then
							// denies that the endpoints past the cut exist.
							// Decline instead, and point at project context,
							// which indexes by endpoint and has no ceiling.
							const specRefusal = guardOpenApiAttachment({
								filename: file.name,
								content,
								budgetedOutcome: budgeted.outcome,
								enabled: specContextEnabledRef.current,
							});
							setAttachedFiles((prev) =>
								prev.map((f) =>
									f.id === fileId
										? {
												...f,
												extractedContent: specRefusal
													? ""
													: budgeted.text,
												extraction:
													specRefusal ??
													budgeted.outcome,
											}
										: f,
								),
							);
						});
					} else if (isImage) {
						readFileAsDataURL(file).then((dataUrl) => {
							setAttachedFiles((prev) =>
								prev.map((f) =>
									f.id === fileId
										? { ...f, extractedContent: dataUrl }
										: f,
								),
							);
						});
					}
				}
			} finally {
				// Release reservations after chips have been queued into state.
				// React commits before the next event-loop tick, so by the time
				// another paste/drop handler fires, `attachedFilesRef` already
				// includes the new chips — no double-count, no leak.
				inFlightImageCountRef.current -= reservedImageCount;
			}
		},
		[],
	);

	const handleFileSelect = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const files = event.target.files;
			if (!files || files.length === 0) {
				return;
			}

			void addFiles(files, "paperclip");

			// Reset file input
			if (fileInputRef.current) {
				fileInputRef.current.value = "";
			}
		},
		[addFiles],
	);

	const removeAttachment = useCallback((fileId: string) => {
		setAttachedFiles((prev) => prev.filter((f) => f.id !== fileId));
	}, []);

	const clearAttachments = useCallback(() => {
		setAttachedFiles([]);
	}, []);

	const uploadAttachments = useCallback(async (): Promise<{
		documentIds: string[];
		chatId: string | undefined;
		uploadedFiles: Array<{
			name: string;
			documentId: string;
			chatId: string | undefined;
			type: string;
			size: number;
			extractedContent?: string;
			s3Path?: string;
		}>;
	}> => {
		const pendingFiles = attachedFiles.filter(
			(f) => f.status === "pending",
		);
		if (pendingFiles.length === 0) {
			return {
				documentIds: [],
				chatId: chatIdRef.current,
				uploadedFiles: [],
			};
		}

		setIsUploading(true);
		const documentIds: string[] = [];
		const uploadedFiles: Array<{
			name: string;
			documentId: string;
			chatId: string | undefined;
			type: string;
			size: number;
			extractedContent?: string;
			s3Path?: string;
		}> = [];
		let aiChatId = chatIdRef.current;

		for (const attachedFile of pendingFiles) {
			try {
				// Update status to uploading
				setAttachedFiles((prev) =>
					prev.map((f) =>
						f.id === attachedFile.id
							? { ...f, status: "uploading" as const }
							: f,
					),
				);

				// Request signed upload URL
				const {
					documentId,
					signedUploadUrl,
					useServerUpload,
					chatId,
					s3Path,
				} = await orpcClient.ai.documents.createUploadUrl({
					chatId: aiChatId,
					organizationId: organizationId ?? null,
					filename: attachedFile.name,
					mimeType: attachedFile.type || "application/octet-stream",
					size: attachedFile.size,
				});

				// Track chat ID for subsequent uploads
				if (!aiChatId && chatId) {
					aiChatId = chatId;
					chatIdRef.current = chatId;
				}

				// Upload file
				if (signedUploadUrl) {
					const uploadResponse = await fetch(signedUploadUrl, {
						method: "PUT",
						body: attachedFile.file,
						headers: {
							"Content-Type":
								attachedFile.type || "application/octet-stream",
						},
					});
					if (!uploadResponse.ok) {
						throw new Error(
							`Upload failed with status ${uploadResponse.status}`,
						);
					}
				} else if (useServerUpload) {
					const arrayBuffer = await attachedFile.file.arrayBuffer();
					const base64 = btoa(
						new Uint8Array(arrayBuffer).reduce(
							(data, byte) => data + String.fromCharCode(byte),
							"",
						),
					);
					await orpcClient.ai.documents.upload({
						documentId,
						fileData: base64,
						mimeType:
							attachedFile.type || "application/octet-stream",
					});
				} else {
					throw new Error("No upload method available");
				}

				// Update status to processing
				setAttachedFiles((prev) =>
					prev.map((f) =>
						f.id === attachedFile.id
							? {
									...f,
									status: "processing" as const,
									documentId,
									chatId: aiChatId,
								}
							: f,
					),
				);

				let extractedContent = attachedFile.extractedContent;
				if (isBinaryDocument(attachedFile.type)) {
					// `process` runs the same extraction the Temporal
					// chunking pipeline uses (LocalPdfExtractor / LocalDocxExtractor
					// for native files, with OCR fallback when configured) and
					// returns the text inline alongside kicking off the
					// chunking/embedding workflow. Awaiting it gives us the
					// PDF/DOCX body in the FIRST turn, which is what the agent
					// actually reads — the previous "fire `process`, then poll
					// `getStatus` for 8s" path stalled forever whenever the
					// Temporal worker was unreachable (a common local-dev
					// state) and shipped an empty rag-context entry that
					// reduced the agent to filename-only awareness.
					let extraction: AiChatExtractionOutcome | undefined;
					try {
						const result = await orpcClient.ai.documents.process({
							documentId,
						});
						extraction = result.extraction;
						if (result.extractedContent) {
							extractedContent = result.extractedContent;
						}
					} catch (err) {
						// The server refused the file (a verdict — see the
						// workbook classifier) or the pipeline broke. Either way
						// the upload itself stands, so this stays non-blocking
						// and the chip keeps its lifecycle; what changes is that
						// the reason now lands on the chip instead of only in
						// this console line. The server's message is already a
						// user-facing sentence.
						console.warn(
							`[Upload] process() failed for ${attachedFile.name}; sending filename-only context.`,
							err,
						);
						extraction = {
							status: "failed",
							reason:
								err instanceof Error && err.message
									? err.message
									: `"${attachedFile.name}" couldn't be read, so the assistant sees only its filename.`,
						};
					}

					// Written unconditionally: an outcome that only landed when
					// there was content would leave exactly the silent cases —
					// empty, failed — with nothing on the chip.
					const resolvedExtraction = extraction;
					const resolvedContent = extractedContent;
					setAttachedFiles((prev) =>
						prev.map((f) =>
							f.id === attachedFile.id
								? {
										...f,
										extractedContent: resolvedContent,
										extraction: resolvedExtraction,
									}
								: f,
						),
					);
					// Always fire onContentExtracted, even when extraction
					// returned nothing — supplies the filename so the agent
					// at minimum knows the file is in scope. Agent-side RAG
					// retrieval (when the Temporal workflow eventually
					// completes) is a separate channel and not relied on
					// here.
					onContentExtracted?.(
						buildAttachmentContextEntry(
							attachedFile.name,
							extractedContent ?? "",
						),
					);
				} else {
					// Text and image files: `addFiles` kicks off `readFileAsText`
					// /`readFileAsDataURL` ASYNCHRONOUSLY. If the user clicks
					// Send before that promise resolves, our snapshot of
					// `attachedFile.extractedContent` is undefined — without an
					// inline await here, `onContentExtracted` would never fire
					// for an image and the agent would receive no rag content
					// (the bug behind "image with text doesn't work").
					if (!extractedContent) {
						extractedContent = isImageFile(attachedFile.type)
							? await readFileAsDataURL(attachedFile.file)
							: isTextFile(attachedFile.type)
								? await readFileAsText(attachedFile.file)
								: undefined;
						if (extractedContent) {
							const finalContent = extractedContent;
							setAttachedFiles((prev) =>
								prev.map((f) =>
									f.id === attachedFile.id
										? {
												...f,
												extractedContent: finalContent,
											}
										: f,
								),
							);
						}
					}
					if (extractedContent) {
						// Text: raw text. Images: data URL, which
						// `buildAttachmentContextEntry` turns into the markdown
						// image link vision-capable LLMs consume.
						onContentExtracted?.(
							buildAttachmentContextEntry(
								attachedFile.name,
								extractedContent,
							),
						);
					}
				}

				// Update status to ready
				setAttachedFiles((prev) =>
					prev.map((f) =>
						f.id === attachedFile.id
							? { ...f, status: "ready" as const }
							: f,
					),
				);

				// Notify telemetry consumer synchronously at the moment the chip
				// flips to `ready`. A `useEffect` over `attachedFiles` cannot see
				// this transition reliably because Send commonly calls
				// `clearAttachments()` in the same React batch (the effect would
				// observe `processing → []`). PII-free shape per
				// `fabric/standards/global/error-handling.md`.
				onAttachmentReadyRef.current?.({
					id: attachedFile.id,
					mime: attachedFile.type,
					sizeBytes: attachedFile.size,
					source: attachedFile.source ?? "paperclip",
				});

				documentIds.push(documentId);
				uploadedFiles.push({
					name: attachedFile.name,
					documentId,
					chatId: aiChatId,
					type: attachedFile.type,
					size: attachedFile.size,
					extractedContent,
					s3Path,
				});
			} catch (error) {
				console.error("File upload error:", error);
				setAttachedFiles((prev) =>
					prev.map((f) =>
						f.id === attachedFile.id
							? {
									...f,
									status: "error" as const,
									error:
										error instanceof Error
											? error.message
											: "Upload failed",
								}
							: f,
					),
				);
				toast.error(`Failed to upload ${attachedFile.name}`);
			}
		}

		setIsUploading(false);
		return { documentIds, chatId: aiChatId, uploadedFiles };
	}, [attachedFiles, organizationId, onContentExtracted]);

	return {
		attachedFiles,
		handleFileSelect,
		addFiles,
		removeAttachment,
		uploadAttachments,
		clearAttachments,
		isUploading,
		isPreparing: preparingCount > 0,
		fileInputRef,
	};
}
