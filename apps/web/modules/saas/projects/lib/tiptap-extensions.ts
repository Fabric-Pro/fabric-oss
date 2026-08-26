import type { AnyExtension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { StarterKit } from "@tiptap/starter-kit";
import type YPartyKitProvider from "y-partykit/provider";
import type * as Y from "yjs";
import { createSharedRichDocumentExtensions } from "./tiptap-extensions-advanced";

// ============================================
// SINGLE SOURCE OF TRUTH: Core Extensions
// ============================================
// These extensions are REQUIRED for document editing to work correctly.
// Any new core extension (like Table) must be added HERE, not in separate files.
// This prevents extension drift between collaborative and non-collaborative modes.

/**
 * StarterKit configuration shared across all modes
 */
const starterKitConfig = {
	heading: {
		levels: [1, 2, 3, 4, 5, 6] as [1, 2, 3, 4, 5, 6],
	},
	bulletList: {
		keepMarks: true,
		keepAttributes: false,
	},
	orderedList: {
		keepMarks: true,
		keepAttributes: false,
	},
	// Disable link and underline — configured separately in sharedRichDocumentExtensions
	link: false as const,
	underline: false as const,
};

// ============================================
// Collaborative Extensions
// ============================================

/**
 * Options for creating collaborative extensions
 */
interface CollaborativeExtensionsOptions {
	ydoc: Y.Doc | null;
	provider: YPartyKitProvider | null;
	user: {
		name: string;
		color: string;
	};
	/**
	 * Active project id (null disables the mention popover). Forwarded
	 * to the @-mention suggestion popover so it can resolve project
	 * collaborators via `projects.documents.searchMentionables`.
	 */
	projectId: string | null;
	/**
	 * Active document id (null disables the mention popover). Forwarded
	 * to the @-mention suggestion popover so it can resolve project
	 * collaborators via `projects.documents.searchMentionables`.
	 */
	documentId: string | null;
}

/**
 * Create TipTap extensions for collaborative editing with Yjs
 *
 * IMPORTANT: This builds on top of core extensions to ensure feature parity.
 * Any core extension added to coreExtensions is automatically included here.
 *
 * Disables built-in undoRedo (Yjs handles undo/redo via its own history)
 * Returns null if ydoc is not available (SSR or not yet initialized)
 */
export function createCollaborativeExtensions(
	options: CollaborativeExtensionsOptions,
): AnyExtension[] | null {
	const { ydoc, provider, user, projectId, documentId } = options;

	// Guard against SSR or uninitialized state
	if (!ydoc) {
		return null;
	}

	// Verify ydoc has the required methods
	if (typeof ydoc.getXmlFragment !== "function") {
		console.error(
			"[createCollaborativeExtensions] ydoc does not have getXmlFragment method",
		);
		return null;
	}

	try {
		// Test that we can actually access the XML fragment - this validates the ydoc is ready
		const testFragment = ydoc.getXmlFragment("prosemirror");
		if (!testFragment) {
			console.error(
				"[createCollaborativeExtensions] ydoc.getXmlFragment returned null/undefined",
			);
			return null;
		}
	} catch (err) {
		console.error(
			"[createCollaborativeExtensions] Error testing ydoc.getXmlFragment:",
			err,
		);
		return null;
	}

	try {
		const collaborativeExtensions: AnyExtension[] = [
			// StarterKit with undoRedo disabled (Yjs handles undo/redo)
			StarterKit.configure({
				...starterKitConfig,
				codeBlock: false,
				undoRedo: false,
			}),
			...createSharedRichDocumentExtensions({ projectId, documentId }),
			// Yjs document synchronization
			Collaboration.configure({
				document: ydoc,
			}),
		];

		// Add caret extension if provider and its awareness are available
		// The CollaborationCaret extension requires provider.awareness to be initialized
		if (
			provider?.awareness &&
			typeof provider.awareness.getStates === "function"
		) {
			collaborativeExtensions.push(
				CollaborationCaret.configure({
					provider,
					user,
					// Custom render function for inline cursor with floating label
					render: (user: { name: string; color: string }) => {
						// Calculate contrasting text color based on background luminance
						const getContrastColor = (hexColor: string): string => {
							// Remove # if present
							const hex = hexColor.replace("#", "");
							// Parse RGB values
							const r = Number.parseInt(hex.substring(0, 2), 16);
							const g = Number.parseInt(hex.substring(2, 4), 16);
							const b = Number.parseInt(hex.substring(4, 6), 16);
							// Calculate relative luminance (WCAG formula)
							const luminance =
								(0.299 * r + 0.587 * g + 0.114 * b) / 255;
							// Use higher threshold (0.65) - most saturated colors should use white text
							// Only very light colors (yellow, lime, cyan) should use black text
							return luminance > 0.65 ? "#1a1a1a" : "#ffffff";
						};

						const textColor = getContrastColor(user.color);

						// Create the cursor container
						const cursor = document.createElement("span");
						cursor.classList.add("collaboration-caret");
						cursor.style.borderLeftColor = user.color;
						cursor.style.borderLeftWidth = "2px";
						cursor.style.borderLeftStyle = "solid";
						cursor.style.position = "relative";
						cursor.style.marginLeft = "-1px";
						cursor.style.marginRight = "-1px";
						cursor.style.pointerEvents = "none";

						// Create the label element
						const label = document.createElement("div");
						label.classList.add("collaboration-caret-label");
						label.style.position = "absolute";
						label.style.top = "-1.5em";
						label.style.left = "-2px";
						label.style.backgroundColor = user.color;
						label.style.color = textColor;
						label.style.fontSize = "11px";
						label.style.fontWeight = "600";
						label.style.padding = "2px 6px";
						label.style.borderRadius = "4px 4px 4px 0";
						label.style.whiteSpace = "nowrap";
						label.style.userSelect = "none";
						label.style.zIndex = "100";
						label.style.boxShadow = "0 2px 4px rgba(0,0,0,0.15)";
						label.style.lineHeight = "1.2";
						label.style.border = "1px solid rgba(0,0,0,0.1)";
						label.textContent = user.name;

						cursor.appendChild(label);
						return cursor;
					},
				}),
			);
		} else if (provider) {
			console.warn(
				"[createCollaborativeExtensions] Provider exists but awareness is not ready, skipping CollaborationCaret",
			);
		}

		return collaborativeExtensions;
	} catch (err) {
		console.error(
			"[createCollaborativeExtensions] Error creating extensions:",
			err,
		);
		return null;
	}
}
