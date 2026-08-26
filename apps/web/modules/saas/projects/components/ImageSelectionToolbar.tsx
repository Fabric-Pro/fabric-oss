"use client";

/**
 * ImageSelectionToolbar - Overlay toolbar shown on every image in the editor.
 *
 * Shows S/M/L size buttons, a caption toggle, and a delete button.
 * Appears on hover over the image wrapper.
 *
 * IMPORTANT: Overlays are created once per image and updated in-place.
 * Destroying and recreating them on every transaction causes:
 * - Hover state loss (new overlay starts hidden)
 * - Size button clicks not registering (overlay destroyed mid-click)
 */

import type { Editor } from "@tiptap/react";
import { useEffect, useRef } from "react";

interface ImageSelectionToolbarProps {
	editor: Editor;
}

// Lucide SVG icon strings
const CAPTION_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><path d="m6 16 6-12 6 12"/><path d="M8 12h8"/></svg>';
const TRASH_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

const SIZE_ACTIVE = "bg-primary text-primary-foreground";
const SIZE_INACTIVE =
	"text-muted-foreground hover:bg-muted hover:text-foreground";

function getPosForImage(editor: Editor, img: Element): number | null {
	try {
		return editor.view.posAtDOM(img, 0);
	} catch {
		return null;
	}
}

function getCaptionAtPos(editor: Editor, pos: number): string | null {
	const node = editor.state.doc.nodeAt(pos);
	return node?.attrs?.caption ?? null;
}

function getImageWidth(img: Element): string {
	return (
		img.getAttribute("data-width") ||
		img.getAttribute("width") ||
		(img as HTMLElement).style?.width ||
		"100%"
	);
}

/**
 * Create or focus a caption input below an element.
 * Wrapper uses contenteditable="false" to prevent ProseMirror from
 * intercepting keystrokes.
 */
function toggleCaptionInput(
	editor: Editor,
	_targetEl: Element,
	parent: HTMLElement,
	opts: {
		getCaption: () => string;
		saveCaption: (value: string | null) => void;
	},
) {
	const existing = parent.querySelector(
		".image-caption-input input",
	) as HTMLInputElement | null;
	if (existing) {
		existing.focus();
		return;
	}

	const currentCaption = opts.getCaption();

	const wrapper = document.createElement("div");
	wrapper.className =
		"image-caption-input flex items-center gap-1.5 mt-2 mx-auto px-2 py-1.5 rounded-lg border border-border bg-card shadow-sm";
	wrapper.style.cssText =
		"max-width: 400px; width: 80%; position: relative; z-index: 10;";
	wrapper.setAttribute("contenteditable", "false");

	const input = document.createElement("input");
	input.type = "text";
	input.value = currentCaption;
	input.placeholder = "Add a caption...";
	input.className =
		"flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none border-none min-w-0";
	input.setAttribute("aria-label", "Caption");

	const doSave = () => {
		const newCaption = input.value.trim() || null;
		opts.saveCaption(newCaption);
		wrapper.remove();
	};

	for (const evtName of [
		"keydown",
		"keyup",
		"keypress",
		"input",
		"beforeinput",
		"compositionstart",
		"compositionend",
	]) {
		input.addEventListener(evtName, (e) => {
			e.stopPropagation();
		});
	}

	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			doSave();
		}
		if (e.key === "Escape") {
			e.preventDefault();
			wrapper.remove();
			editor.commands.focus();
		}
	});

	input.addEventListener("blur", () => {
		setTimeout(() => {
			if (wrapper.isConnected) {
				doSave();
			}
		}, 150);
	});

	wrapper.appendChild(input);
	parent.appendChild(wrapper);
	requestAnimationFrame(() => input.focus());
}

/** Create the overlay element for an image. */
function createOverlay(editor: Editor, img: Element, parent: HTMLElement) {
	const overlay = document.createElement("div");
	overlay.className =
		"image-overlay-controls absolute top-2 right-2 z-10 flex items-center gap-1 rounded-lg border border-border bg-card/95 p-1 shadow-md opacity-0 transition-opacity duration-150 pointer-events-none";
	overlay.setAttribute("role", "toolbar");
	overlay.setAttribute("aria-label", "Image options");

	// Size buttons — store references for in-place updates
	const sizeButtons: HTMLButtonElement[] = [];
	const sizes = [
		{ label: "S", value: "25%" },
		{ label: "M", value: "50%" },
		{ label: "L", value: "100%" },
	];

	for (const { label, value } of sizes) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = label;
		// No native `title` — this overlay is built imperatively outside the React
		// tree, so the shared `<Tooltip>` can't wrap it (no TooltipProvider in
		// scope). The `aria-label` below is the accessibility contract and is
		// sufficient. Documented as an exception in fabric/standards/frontend/tooltips.md.
		btn.setAttribute("aria-label", `Image size ${label}`);
		btn.setAttribute("data-size-value", value);
		btn.className = `h-7 w-7 flex items-center justify-center rounded text-xs font-medium transition-colors cursor-pointer ${SIZE_INACTIVE}`;
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const pos = getPosForImage(editor, img);
			if (pos != null) {
				editor
					.chain()
					.focus()
					.setNodeSelection(pos)
					.updateAttributes("image", { width: value })
					.run();
				// Update active state immediately (don't wait for re-render)
				updateSizeButtons(sizeButtons, value);
			}
		});
		sizeButtons.push(btn);
		overlay.appendChild(btn);
	}

	// Set initial active state
	updateSizeButtons(sizeButtons, getImageWidth(img));

	// Separator
	const sep = document.createElement("div");
	sep.className = "mx-0.5 h-5 w-px bg-border";
	overlay.appendChild(sep);

	// Caption button
	const captionBtn = document.createElement("button");
	captionBtn.type = "button";
	captionBtn.innerHTML = CAPTION_ICON;
	// No native `title` — see the note on the size buttons above.
	captionBtn.setAttribute("aria-label", "Add or edit caption");
	captionBtn.className =
		"h-7 w-7 flex items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer";
	captionBtn.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		toggleCaptionInput(editor, img, parent, {
			getCaption: () => {
				const pos = getPosForImage(editor, img);
				return pos != null ? getCaptionAtPos(editor, pos) || "" : "";
			},
			saveCaption: (value) => {
				const pos = getPosForImage(editor, img);
				if (pos != null) {
					editor
						.chain()
						.focus()
						.setNodeSelection(pos)
						.updateAttributes("image", { caption: value })
						.run();
				}
			},
		});
	});
	overlay.appendChild(captionBtn);

	// Separator
	const sep2 = document.createElement("div");
	sep2.className = "mx-0.5 h-5 w-px bg-border";
	overlay.appendChild(sep2);

	// Delete button
	const delBtn = document.createElement("button");
	delBtn.type = "button";
	delBtn.innerHTML = TRASH_ICON;
	// No native `title` — see the note on the size buttons above.
	delBtn.setAttribute("aria-label", "Delete image");
	delBtn.className =
		"h-7 w-7 flex items-center justify-center rounded text-destructive hover:bg-destructive/10 transition-colors cursor-pointer";
	delBtn.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		const pos = getPosForImage(editor, img);
		if (pos != null) {
			editor
				.chain()
				.focus()
				.setNodeSelection(pos)
				.deleteSelection()
				.run();
		}
	});
	overlay.appendChild(delBtn);

	// Store size button refs on the overlay element for later updates
	(overlay as any)._sizeButtons = sizeButtons;
	(overlay as any)._img = img;

	parent.appendChild(overlay);

	// Hover show/hide
	const showOverlay = () => {
		overlay.style.opacity = "1";
		overlay.style.pointerEvents = "auto";
	};
	const hideOverlay = (e: MouseEvent) => {
		const captionInput = parent.querySelector(".image-caption-input");
		if (captionInput?.contains(e.relatedTarget as Node)) {
			return;
		}
		overlay.style.opacity = "0";
		overlay.style.pointerEvents = "none";
	};

	parent.addEventListener("mouseenter", showOverlay);
	parent.addEventListener("mouseleave", hideOverlay);

	// If the mouse is already over the parent (e.g. image just inserted under cursor),
	// show the overlay immediately
	if (parent.matches(":hover")) {
		showOverlay();
	}

	return overlay;
}

/** Update size button active states without destroying the overlay. */
function updateSizeButtons(buttons: HTMLButtonElement[], currentWidth: string) {
	for (const btn of buttons) {
		const value = btn.getAttribute("data-size-value");
		const isActive = value === currentWidth;
		// Replace only the state-related classes
		btn.className = `h-7 w-7 flex items-center justify-center rounded text-xs font-medium transition-colors cursor-pointer ${isActive ? SIZE_ACTIVE : SIZE_INACTIVE}`;
	}
}

export function ImageSelectionToolbar({ editor }: ImageSelectionToolbarProps) {
	const overlaysCreatedRef = useRef(false);

	useEffect(() => {
		if (!editor.isEditable) {
			return;
		}

		// Ensure overlays exist for all images, update active states for existing ones
		const syncOverlays = () => {
			const editorDom = editor.view.dom;
			const images = editorDom.querySelectorAll(
				"img:not(.ProseMirror-separator)",
			);

			for (const img of images) {
				const parent = img.parentElement;
				if (!parent) {
					continue;
				}

				// Make parent relative for positioning
				if (window.getComputedStyle(parent).position === "static") {
					parent.style.position = "relative";
				}

				const existing = parent.querySelector(
					".image-overlay-controls",
				);
				if (existing) {
					// Update active size button state in-place
					const sizeButtons = (existing as any)._sizeButtons as
						| HTMLButtonElement[]
						| undefined;
					if (sizeButtons) {
						updateSizeButtons(sizeButtons, getImageWidth(img));
					}
				} else {
					// Create new overlay for this image
					createOverlay(editor, img, parent);
				}
			}
		};

		// Debounced sync — only for adding overlays to new images, not destroying existing
		let timer: ReturnType<typeof setTimeout> | null = null;
		const debouncedSync = () => {
			if (timer) {
				clearTimeout(timer);
			}
			timer = setTimeout(syncOverlays, 150);
		};

		editor.on("transaction", debouncedSync);
		// Also listen for update (content changes) which fires after DOM updates
		editor.on("update", debouncedSync);

		// Initial creation — delay slightly so EditorContent has rendered images into DOM
		syncOverlays();
		const initTimer = setTimeout(syncOverlays, 300);
		const initTimer2 = setTimeout(syncOverlays, 1000);
		overlaysCreatedRef.current = true;

		return () => {
			editor.off("transaction", debouncedSync);
			editor.off("update", debouncedSync);
			if (timer) {
				clearTimeout(timer);
			}
			clearTimeout(initTimer);
			clearTimeout(initTimer2);
			// Clean up all overlays on unmount
			const editorDom = editor.view.dom;
			editorDom
				.querySelectorAll(".image-overlay-controls")
				.forEach((el) => {
					el.remove();
				});
		};
	}, [editor]);

	return null;
}
