"use client";

import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	DOCUMENT_TOC_DEBOUNCE_MS,
	type DocumentTocItem,
	extractDocumentToc,
	tocItemsEqual,
} from "../lib/document-toc";

/**
 * Live table of contents for a TipTap editor.
 *
 * Subscribes to the editor's `update` event (which fires for local typing,
 * collaborative Yjs transactions and programmatic changes alike) with a
 * trailing debounce, so the ToC follows the document without re-rendering on
 * every keystroke: `items` only changes when a heading's identity, title or
 * level changes, while fresh ProseMirror positions are kept in a ref for
 * click-time navigation.
 */
export function useDocumentToc(editor: Editor | null): {
	items: DocumentTocItem[];
	/**
	 * Scroll the editor to the heading and move the selection there. Returns
	 * false when the heading no longer exists (or scrolling failed) so the
	 * caller can decide whether to announce the jump.
	 */
	navigateToHeading: (item: DocumentTocItem) => boolean;
} {
	const [items, setItems] = useState<DocumentTocItem[]>([]);
	const positionsRef = useRef<Map<string, number>>(new Map());

	useEffect(() => {
		if (!editor || editor.isDestroyed) {
			positionsRef.current = new Map();
			setItems([]);
			return;
		}

		let timer: ReturnType<typeof setTimeout> | null = null;

		const recompute = () => {
			if (editor.isDestroyed) {
				return;
			}
			try {
				const next = extractDocumentToc(editor.state.doc);
				positionsRef.current = new Map(
					next.map((item) => [item.id, item.pos]),
				);
				setItems((prev) => (tocItemsEqual(prev, next) ? prev : next));
			} catch {
				// The document must stay usable if heading detection fails.
				// This runs synchronously inside the effect on mount, so an
				// unguarded throw would take the whole editor tree down; keep
				// the previous items instead.
			}
		};

		const scheduleRecompute = () => {
			if (timer !== null) {
				clearTimeout(timer);
			}
			timer = setTimeout(() => {
				timer = null;
				recompute();
			}, DOCUMENT_TOC_DEBOUNCE_MS);
		};

		recompute();
		editor.on("update", scheduleRecompute);

		return () => {
			if (timer !== null) {
				clearTimeout(timer);
			}
			editor.off("update", scheduleRecompute);
		};
	}, [editor]);

	const navigateToHeading = useCallback(
		(item: DocumentTocItem): boolean => {
			if (!editor || editor.isDestroyed) {
				return false;
			}
			try {
				const doc = editor.state.doc;
				// The cached position is only trusted when it still holds a
				// heading with the *same* text. Checking the node type alone
				// would accept a different heading that happened to shift onto
				// this position inside the debounce window, silently sending
				// the reader to the wrong section.
				const holdsSameHeading = (pos: number) => {
					if (pos < 0 || pos >= doc.content.size) {
						return false;
					}
					const node = doc.nodeAt(pos);
					if (!node || node.type.name !== "heading") {
						return false;
					}
					return (
						node.textContent.replace(/\s+/g, " ").trim() ===
						item.text
					);
				};

				let pos = positionsRef.current.get(item.id) ?? item.pos;
				if (!holdsSameHeading(pos)) {
					// Positions can go stale inside the debounce window —
					// re-extract synchronously and match by id.
					const fresh = extractDocumentToc(doc);
					positionsRef.current = new Map(
						fresh.map((entry) => [entry.id, entry.pos]),
					);
					const match = fresh.find((entry) => entry.id === item.id);
					if (!match) {
						return false; // the heading was deleted or renamed
					}
					pos = match.pos;
				}

				// Selection first (without TipTap's own scroll), so keyboard
				// and assistive-tech context lands in the section while the
				// motion-aware scroll below stays the only scroll.
				editor
					.chain()
					.setTextSelection(Math.min(pos + 1, doc.content.size))
					.focus(undefined, { scrollIntoView: false })
					.run();

				const headingDom = editor.view.nodeDOM(pos);
				if (headingDom instanceof HTMLElement) {
					const reducedMotion =
						typeof window !== "undefined" &&
						window.matchMedia("(prefers-reduced-motion: reduce)")
							.matches;
					headingDom.scrollIntoView({
						block: "start",
						behavior: reducedMotion ? "auto" : "smooth",
					});
				} else {
					editor.commands.scrollIntoView();
				}
				return true;
			} catch {
				// A failed scroll must never break the editor surface.
				return false;
			}
		},
		[editor],
	);

	return { items, navigateToHeading };
}
