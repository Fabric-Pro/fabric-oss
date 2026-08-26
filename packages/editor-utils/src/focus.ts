/**
 * Focus utilities for TipTap editor
 * These utilities help scroll to and focus on specific parts of the document
 */

/**
 * TipTap editor type (minimal interface to avoid direct dependency)
 */
export interface EditorLike {
	view: {
		dom: HTMLElement;
		focus: () => void;
		posAtDOM: (node: Node, offset: number) => number;
	};
	commands: {
		setTextSelection: (range: { from: number; to: number }) => void;
		scrollIntoView: () => void;
	};
}

/**
 * Focus on the first diff element (em or s tag)
 * Useful for automatically scrolling to changes during streaming
 */
export function focusOnFirstDiff(editor: EditorLike | null): void {
	if (!editor) {
		return;
	}

	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			try {
				const container = editor.view.dom as HTMLElement;
				const diffEl =
					container.querySelector("em") ||
					container.querySelector("s");
				if (!diffEl) {
					return;
				}

				const heading = diffEl.closest(
					"h1, h2, h3, h4, h5, h6",
				) as HTMLElement | null;
				const scrollTarget = heading || (diffEl as HTMLElement);

				if ("scrollIntoView" in scrollTarget) {
					scrollTarget.scrollIntoView({
						block: "center",
						behavior: "smooth",
					});
				}

				editor.view.focus();
				const pos = editor.view.posAtDOM(diffEl, 0);
				if (typeof pos === "number" && pos > 0) {
					editor.commands.setTextSelection({ from: pos, to: pos });
					editor.commands.scrollIntoView();
				}
			} catch {
				// Silently fail if DOM operations fail
			}
		});
	});
}

/**
 * Focus on the last diff element (em or s tag)
 * Useful for auto-scrolling to latest changes during streaming updates
 */
export function focusOnLastDiff(editor: EditorLike | null): void {
	if (!editor) {
		return;
	}

	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			try {
				const container = editor.view.dom as HTMLElement;
				// Get all diff elements (both additions and deletions)
				const emElements = Array.from(container.querySelectorAll("em"));
				const sElements = Array.from(container.querySelectorAll("s"));
				const allDiffElements = [...emElements, ...sElements];

				if (allDiffElements.length === 0) {
					return;
				}

				// Sort by position in document to get the last one
				allDiffElements.sort((a, b) => {
					const posA = a.compareDocumentPosition(b);
					return posA & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
				});

				const lastDiffEl = allDiffElements[allDiffElements.length - 1];

				// Find the closest heading or use the element itself
				const heading = lastDiffEl.closest(
					"h1, h2, h3, h4, h5, h6",
				) as HTMLElement | null;
				const scrollTarget = heading || (lastDiffEl as HTMLElement);

				if ("scrollIntoView" in scrollTarget) {
					// Use "auto" instead of "smooth" to prevent bouncing during rapid streaming updates
					scrollTarget.scrollIntoView({
						block: "center",
						behavior: "auto",
					});
				}

				editor.view.focus();
				const pos = editor.view.posAtDOM(lastDiffEl, 0);
				if (typeof pos === "number" && pos > 0) {
					editor.commands.setTextSelection({ from: pos, to: pos });
					// Don't call scrollIntoView again as we already scrolled above
				}
			} catch {
				// Silently fail if DOM operations fail
			}
		});
	});
}

/**
 * Focus on a specific markdown heading anchor
 * Used when the agent specifies a focusAnchor in the document
 */
export function focusOnAnchor(editor: EditorLike | null, anchor: string): void {
	if (!editor || !anchor) {
		return;
	}

	requestAnimationFrame(() => {
		try {
			const container = editor.view.dom as HTMLElement;
			const headings = Array.from(
				container.querySelectorAll("h1, h2, h3, h4, h5, h6"),
			) as HTMLElement[];

			// Normalize whitespace for matching
			const normalized = (s: string) => s.replace(/\s+/g, " ").trim();
			const match = headings.find(
				(h) =>
					normalized(h.textContent || "") ===
					normalized(anchor.replace(/^#+\s*/, "")),
			);

			const target =
				match ||
				container.querySelector("em") ||
				container.querySelector("s");
			if (!target) {
				return;
			}

			if ("scrollIntoView" in target) {
				(target as HTMLElement).scrollIntoView({
					block: "center",
					behavior: "smooth",
				});
			}

			editor.view.focus();
			const pos = editor.view.posAtDOM(target, 0);
			if (typeof pos === "number" && pos > 0) {
				editor.commands.setTextSelection({ from: pos, to: pos });
				editor.commands.scrollIntoView();
			}
		} catch {
			// Silently fail if DOM operations fail
		}
	});
}
