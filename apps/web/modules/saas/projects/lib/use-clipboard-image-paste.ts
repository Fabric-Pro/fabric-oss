/**
 * Shared clipboard / drag-drop image-paste hook used by the four content
 * surfaces enumerated in `.claude/specs/2026-04-30-paste-image-everywhere/spec.md`:
 *
 *   - "document" (DocumentEditor — verify-only / regression-locked)
 *   - "story"    (StoryWorkspace TipTap editor)
 *   - "nexus"    (CopilotPage chat input)
 *   - "loom"     (FabricChat shared ChatInput)
 *
 * The hook owns: MIME and size validation, the 5-images-per-paste cap, the
 * mixed-files split, friendly toast surfacing, telemetry emission, abort
 * propagation on host unmount, and accessibility announcements. Each surface
 * supplies its own `uploader` callback so the per-surface oRPC pipeline lives
 * outside the hook (Documents/Story → projects.documents|stories.* media
 * procedures; Nexus/Loom → ai.documents.createUploadUrl → upload → process).
 *
 * NFR §8.3 — handlers returned by this hook are referentially stable across
 * renders. Upload progress is tracked via `useRef` only (never `useState`)
 * to avoid the `<CopilotKit>` re-mount churn called out in PR #688. Friendly
 * error copy never leaks raw provider errors (PR #692 lesson).
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";

/** The four content surfaces wired in the spec. */
type Surface = "document" | "story" | "nexus" | "loom";

/** Hard upper bound on images-per-paste enforced inside the hook. */
const HARD_MAX_FILES_PER_PASTE = 5;

/** MIME types that route to the dedicated HEIC friendly toast. */
const HEIC_MIME_TYPES = new Set(["image/heic", "image/heif"]);

/**
 * Spec §7 / §8.6 toast copy — kept as a frozen object so that any surface
 * importing this module gets exactly the same wording. Strings here MUST
 * match the spec character-for-character.
 */
const TOAST_COPY = Object.freeze({
	heic: "HEIC images aren't supported yet — please paste as PNG or JPEG (Cmd-Shift-4 on Mac saves PNG).",
	tooLargeDocument: "Image is too large (max 5MB). Try compressing it first.",
	tooLargeChat: "Image is too large (max 10MB).",
	network: "Couldn't upload — please try again.",
	cap: (uploaded: number, total: number) =>
		`Pasted ${uploaded} of ${total} images — upload the rest separately.`,
});

/**
 * Spec §8.7 a11y announcements. Hosts wire these into an `aria-live="polite"`
 * region via the `announce` option.
 */
const ANNOUNCE_COPY = Object.freeze({
	start: "Uploading image…",
	success: "Image uploaded.",
	error: "Image upload failed.",
});

export interface UseClipboardImagePasteOptions {
	/** Surface identifier for telemetry and friendly toasts. */
	surface: Surface;
	/** Per-surface size cap (5MB for document/story, 10MB for nexus/loom). */
	maxSizeBytes: number;
	/** Per-surface MIME allowlist (png/jpeg/gif/webp; +tiff for chats). */
	allowedMimeTypes: ReadonlySet<string>;
	/** Optional per-surface override of the 5-image-per-paste cap. */
	maxFilesPerPaste?: 1 | 2 | 3 | 4 | 5;
	/** Surface-owned upload entry point. Receives the abort signal. */
	uploader: (file: File, signal: AbortSignal) => Promise<void>;
	/** Mixed paste: route non-image files elsewhere (e.g., chat picker). */
	onNonImageFiles?: (files: File[]) => void;
	/** Optional accessibility announcer hooked to an `aria-live` region. */
	announce?: (message: string) => void;
}

export interface UseClipboardImagePasteResult {
	/**
	 * Returns `true` when the hook handled the event (so TipTap or React
	 * consumers can skip the default behavior); `false` otherwise.
	 */
	handlePaste: (event: ClipboardEvent | React.ClipboardEvent) => boolean;
	handleDrop: (event: DragEvent | React.DragEvent) => boolean;
	handleDragOver: (event: DragEvent | React.DragEvent) => void;
}

/**
 * Map an Error from the surface-supplied uploader to a friendly toast string
 * + a stable telemetry errorCode. Never leak raw provider error content.
 */
function classifyError(error: unknown): {
	toastMessage: string;
	errorCode: string;
} {
	if (error instanceof DOMException && error.name === "AbortError") {
		return { toastMessage: "", errorCode: "aborted" };
	}
	return { toastMessage: TOAST_COPY.network, errorCode: "upload_failed" };
}

/** Pick the size-limit toast copy for the surface's cap. */
function sizeLimitCopy(surface: Surface, maxSizeBytes: number): string {
	if (surface === "document" || surface === "story") {
		return TOAST_COPY.tooLargeDocument;
	}
	// Nexus / Loom — render the cap actually configured (defaults 10MB).
	const megabytes = Math.round(maxSizeBytes / (1024 * 1024));
	if (megabytes === 10) {
		return TOAST_COPY.tooLargeChat;
	}
	return `Image is too large (max ${megabytes}MB).`;
}

/**
 * Shared paste/drop hook. See module docstring for design notes.
 */
export function useClipboardImagePaste(
	options: UseClipboardImagePasteOptions,
): UseClipboardImagePasteResult {
	// Stash the latest options in a ref so the returned handlers stay
	// referentially stable while the hook still reads the current uploader,
	// announce callback, etc. Spec §8.2 / NFR §8.3.
	const optionsRef = useRef(options);
	useEffect(() => {
		optionsRef.current = options;
	}, [options]);

	// One AbortController owns every in-flight upload spawned by this hook.
	// On unmount we abort it so ongoing surface uploaders can short-circuit.
	//
	// `getActiveController()` lazily replaces the ref whenever the previous
	// controller has already been aborted. This is critical: after the host
	// unmounts (HMR / Fast Refresh / React Strict Mode double-mount), the
	// cleanup below aborts the controller. Without this re-creation guard,
	// every subsequent paste on the re-mounted host hands the surface
	// uploader an already-aborted signal — and any uploader that
	// short-circuits on `signal.aborted` (the documented contract) would
	// silently no-op while the hook still emits a `status=ok` telemetry line.
	const abortControllerRef = useRef<AbortController | null>(null);
	const getActiveController = useCallback((): AbortController => {
		if (
			abortControllerRef.current === null ||
			abortControllerRef.current.signal.aborted
		) {
			abortControllerRef.current = new AbortController();
		}
		return abortControllerRef.current;
	}, []);

	useEffect(() => {
		// Lazy-create on mount so the first paste after re-mount gets a
		// fresh, unaborted signal even after StrictMode's intentional
		// mount → unmount → remount cycle.
		getActiveController();
		return () => {
			abortControllerRef.current?.abort();
		};
	}, [getActiveController]);

	/**
	 * Run a single upload attempt — emits telemetry + announce + toast for
	 * exactly one image. Always resolves; failures are reported via the toast
	 * layer (no rethrow) so caller can use Promise.allSettled-style fan-out.
	 */
	const processOneImage = useCallback(
		async (file: File): Promise<void> => {
			const { surface, uploader, announce } = optionsRef.current;
			const signal = getActiveController().signal;

			const start = Date.now();
			announce?.(ANNOUNCE_COPY.start);
			try {
				await uploader(file, signal);
				const durationMs = Date.now() - start;
				console.log(
					`[PasteImage] surface=${surface} size=${file.size} mime=${file.type} durationMs=${durationMs} status=ok errorCode=`,
				);
				announce?.(ANNOUNCE_COPY.success);
			} catch (error) {
				const durationMs = Date.now() - start;
				const { toastMessage, errorCode } = classifyError(error);
				console.log(
					`[PasteImage] surface=${surface} size=${file.size} mime=${file.type} durationMs=${durationMs} status=error errorCode=${errorCode}`,
				);
				if (toastMessage) {
					toast.error(toastMessage);
				}
				if (errorCode !== "aborted") {
					announce?.(ANNOUNCE_COPY.error);
				}
			}
		},
		[getActiveController],
	);

	/**
	 * Pipeline shared by paste and drop:
	 *   1. Split images vs non-images
	 *   2. Forward non-images to onNonImageFiles (if provided)
	 *   3. Validate MIME (+HEIC special-case) and size
	 *   4. Cap at maxFilesPerPaste
	 *   5. Kick off uploads in parallel
	 * Returns whether the event was handled (≥1 image accepted or rejected
	 * with a toast — both are "we own this event" outcomes for TipTap).
	 */
	const processFiles = useCallback(
		(files: readonly File[]): boolean => {
			if (files.length === 0) {
				return false;
			}

			const {
				surface,
				maxSizeBytes,
				allowedMimeTypes,
				maxFilesPerPaste,
				onNonImageFiles,
			} = optionsRef.current;

			const cap = Math.min(
				maxFilesPerPaste ?? HARD_MAX_FILES_PER_PASTE,
				HARD_MAX_FILES_PER_PASTE,
			);

			const imageCandidates: File[] = [];
			const nonImages: File[] = [];
			for (const file of files) {
				if (file.type.startsWith("image/")) {
					imageCandidates.push(file);
				} else {
					nonImages.push(file);
				}
			}

			if (nonImages.length > 0) {
				onNonImageFiles?.(nonImages);
			}

			if (imageCandidates.length === 0) {
				// Mixed paste with only non-images — caller already routed those.
				return nonImages.length > 0;
			}

			let heicSeen = false;
			let oversizedSeen = false;
			let unsupportedSeen = false;
			const valid: File[] = [];

			for (const file of imageCandidates) {
				if (HEIC_MIME_TYPES.has(file.type)) {
					heicSeen = true;
					continue;
				}
				if (!allowedMimeTypes.has(file.type)) {
					unsupportedSeen = true;
					continue;
				}
				if (file.size > maxSizeBytes) {
					oversizedSeen = true;
					continue;
				}
				valid.push(file);
			}

			if (heicSeen) {
				toast.error(TOAST_COPY.heic);
			}
			if (oversizedSeen) {
				toast.error(sizeLimitCopy(surface, maxSizeBytes));
			}
			if (unsupportedSeen && !heicSeen && !oversizedSeen) {
				// Generic unsupported-MIME fallback. No spec-mandated copy beyond
				// HEIC, so emit a neutral message that does not leak provider
				// detail.
				toast.error(
					"Unsupported image type — use PNG, JPEG, GIF, or WebP.",
				);
			}

			if (valid.length === 0) {
				// We still consumed the event (showed a toast / forwarded
				// non-images), so return true to suppress default handlers.
				return true;
			}

			let toUpload = valid;
			if (valid.length > cap) {
				toUpload = valid.slice(0, cap);
				toast.message(TOAST_COPY.cap(cap, valid.length));
			}

			// Fire and forget — `processOneImage` swallows individual failures
			// so the parallel fan-out behaves like Promise.allSettled.
			void Promise.allSettled(
				toUpload.map((file) => processOneImage(file)),
			);

			return true;
		},
		[processOneImage],
	);

	const handlePaste = useCallback(
		(event: ClipboardEvent | React.ClipboardEvent): boolean => {
			const files = event.clipboardData?.files;
			if (!files || files.length === 0) {
				return false;
			}
			return processFiles(Array.from(files));
		},
		[processFiles],
	);

	const handleDrop = useCallback(
		(event: DragEvent | React.DragEvent): boolean => {
			const files = event.dataTransfer?.files;
			if (!files || files.length === 0) {
				return false;
			}
			event.preventDefault();
			return processFiles(Array.from(files));
		},
		[processFiles],
	);

	const handleDragOver = useCallback(
		(event: DragEvent | React.DragEvent): void => {
			// Always preventDefault on dragover so the subsequent drop fires
			// at all — the browser otherwise treats the editor as not a drop
			// target.
			event.preventDefault();
		},
		[],
	);

	return useMemo(
		() => ({ handlePaste, handleDrop, handleDragOver }),
		[handlePaste, handleDrop, handleDragOver],
	);
}
