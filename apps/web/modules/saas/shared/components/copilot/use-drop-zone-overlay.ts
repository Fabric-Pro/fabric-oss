"use client";

import {
	type DragEvent as ReactDragEvent,
	type RefObject,
	useCallback,
	useRef,
	useState,
} from "react";

/**
 * Drop-zone overlay primitive for the CopilotSidebar input wrapper.
 *
 * Owns the `dragenter` / `dragleave` / `drop` listeners and exposes:
 *   - `isDraggingFile` — true while one or more file-bearing drags are over the
 *     wrapper (used to render the "Drop to attach" overlay).
 *   - `dropZoneProps`  — handlers to spread onto the wrapper element.
 *
 * Counter-based enter/leave (per spec §4.2): native drag events fire on
 * children of the wrapper as the cursor crosses internal boundaries. A naive
 * boolean would flicker off/on as the cursor moves over the textarea, the
 * paperclip button, or the chip strip. The counter is incremented on every
 * `dragenter` and decremented on every `dragleave`; the overlay only hides
 * when the counter returns to zero (or on `drop`).
 *
 * Drags that do not advertise `Files` in `dataTransfer.types` (e.g., text
 * selections within the page) are ignored entirely so the overlay does not
 * appear for non-file drags.
 *
 * The hook only manages overlay visibility — the `onDrop` callback supplied by
 * the caller is responsible for routing files into the upload pipeline.
 *
 * Per `fabric/standards/global/coding-style.md`: strict types, no `any`. Per
 * `fabric/standards/global/conventions.md`: kebab-case file name.
 */

export interface UseDropZoneOverlayOptions {
	/** Invoked with the dropped files when a file-bearing drop completes. */
	onDrop: (files: readonly File[]) => void;
	/**
	 * When the wrapper's interactive surface should not accept drops (e.g.,
	 * textarea is `disabled`), set this to `true` to suppress overlay rendering
	 * and short-circuit drop handling. Defaults to `false`.
	 */
	disabled?: boolean;
}

export interface UseDropZoneOverlayResult {
	/** True while at least one file-bearing drag is over the wrapper. */
	isDraggingFile: boolean;
	/**
	 * Spread onto the wrapper element. Includes `dragenter`, `dragleave`,
	 * `dragover`, and `drop` handlers.
	 */
	dropZoneProps: {
		onDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
		onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
		onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
		onDrop: (event: ReactDragEvent<HTMLElement>) => void;
	};
	/**
	 * Ref defaulted to `null`. Callers may attach this to the wrapper element
	 * if they need a handle for ancillary measurements; the hook itself does
	 * not require the ref to function.
	 */
	wrapperRef: RefObject<HTMLDivElement | null>;
}

/** Returns true if the drag event is carrying file payloads. */
function dragHasFiles(event: ReactDragEvent<HTMLElement>): boolean {
	const types = event.dataTransfer?.types;
	if (!types) {
		return false;
	}
	// `DataTransferItemList.types` is a DOMStringList in some browsers; both
	// expose `includes` indirectly via array iteration. `Array.from` keeps the
	// check engine-agnostic.
	for (const type of Array.from(types as ArrayLike<string>)) {
		if (type === "Files") {
			return true;
		}
	}
	return false;
}

export function useDropZoneOverlay(
	options: UseDropZoneOverlayOptions,
): UseDropZoneOverlayResult {
	const { onDrop, disabled = false } = options;
	const [isDraggingFile, setIsDraggingFile] = useState(false);
	const dragCounterRef = useRef(0);
	const wrapperRef = useRef<HTMLDivElement | null>(null);

	const onDropCallbackRef = useRef(onDrop);
	onDropCallbackRef.current = onDrop;

	const reset = useCallback(() => {
		dragCounterRef.current = 0;
		setIsDraggingFile(false);
	}, []);

	const handleDragEnter = useCallback(
		(event: ReactDragEvent<HTMLElement>) => {
			if (disabled) {
				return;
			}
			if (!dragHasFiles(event)) {
				return;
			}
			event.preventDefault();
			dragCounterRef.current += 1;
			if (dragCounterRef.current === 1) {
				setIsDraggingFile(true);
			}
		},
		[disabled],
	);

	const handleDragLeave = useCallback(
		(event: ReactDragEvent<HTMLElement>) => {
			if (disabled) {
				return;
			}
			if (!dragHasFiles(event)) {
				return;
			}
			event.preventDefault();
			dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
			if (dragCounterRef.current === 0) {
				setIsDraggingFile(false);
			}
		},
		[disabled],
	);

	const handleDragOver = useCallback(
		(event: ReactDragEvent<HTMLElement>) => {
			if (disabled) {
				return;
			}
			if (!dragHasFiles(event)) {
				return;
			}
			// `preventDefault` on dragover is required for the subsequent drop
			// to fire — the browser otherwise treats the wrapper as a non-drop
			// target. Mirrors the contract in `use-clipboard-image-paste.ts`.
			event.preventDefault();
		},
		[disabled],
	);

	const handleDrop = useCallback(
		(event: ReactDragEvent<HTMLElement>) => {
			if (disabled) {
				return;
			}
			if (!dragHasFiles(event)) {
				reset();
				return;
			}
			event.preventDefault();
			const files = event.dataTransfer?.files;
			reset();
			if (!files || files.length === 0) {
				return;
			}
			onDropCallbackRef.current(Array.from(files));
		},
		[disabled, reset],
	);

	return {
		isDraggingFile,
		dropZoneProps: {
			onDragEnter: handleDragEnter,
			onDragLeave: handleDragLeave,
			onDragOver: handleDragOver,
			onDrop: handleDrop,
		},
		wrapperRef,
	};
}
