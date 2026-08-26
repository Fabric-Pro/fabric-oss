"use client";

import type { Editor } from "@tiptap/react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDocumentToc } from "../hooks/use-document-toc";
import type { DocumentTocItem } from "../lib/document-toc";
import {
	type DocumentTocBreakpoint,
	DocumentTocPanel,
} from "./DocumentTocPanel";

const ANNOUNCEMENT_CLEAR_MS = 3000;

interface DocumentTocRailProps {
	editor: Editor | null;
	/**
	 * Writes to a host-owned polite live region (the document editor routes
	 * jumps through the same region its mention deep-link uses). When omitted,
	 * the rail renders its own visually-hidden `<output>` (implicit
	 * `role="status"`, so announcements are polite), and a host surface needs
	 * nothing beyond `<DocumentTocRail editor={editor} />`.
	 */
	onAnnounce?: (message: string) => void;
	/** Narrowest viewport that still has room for the rail. */
	breakpoint?: DocumentTocBreakpoint;
}

/**
 * Owns the table of contents for a TipTap editor surface.
 *
 * Deliberately a separate component from the editor itself: the heading list
 * changes on every debounced recompute, and keeping that state here confines
 * the re-render to the rail instead of re-rendering the whole editor tree
 * (TipTap already avoids re-rendering it per transaction).
 */
export function DocumentTocRail({
	editor,
	onAnnounce,
	breakpoint,
}: DocumentTocRailProps) {
	const t = useTranslations("projects.documentToc");
	const { items, navigateToHeading } = useDocumentToc(editor);
	const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [ownAnnouncement, setOwnAnnouncement] = useState("");

	const announce = useCallback(
		(message: string) => {
			const write = onAnnounce ?? setOwnAnnouncement;
			write(message);
			if (clearTimerRef.current !== null) {
				clearTimeout(clearTimerRef.current);
			}
			clearTimerRef.current = setTimeout(() => {
				clearTimerRef.current = null;
				write("");
			}, ANNOUNCEMENT_CLEAR_MS);
		},
		[onAnnounce],
	);

	useEffect(() => {
		return () => {
			if (clearTimerRef.current !== null) {
				clearTimeout(clearTimerRef.current);
			}
		};
	}, []);

	const handleNavigate = useCallback(
		(item: DocumentTocItem) => {
			// Naming the section keeps consecutive jumps distinguishable — an
			// identical string would leave the live region silent the second
			// time, since React sees no state change.
			announce(
				navigateToHeading(item)
					? t("announcementJumped", {
							section: item.text || t("untitled"),
						})
					: t("announcementMissing"),
			);
		},
		[navigateToHeading, announce, t],
	);

	// The panel itself renders nothing without headings, so a heading-less
	// document still shows no spine, no list and no empty state. The hidden
	// live region deliberately stays mounted: deleting the last heading is
	// exactly when the "section is gone" announcement fires, and unmounting
	// the region in the same breath would swallow it.
	return (
		<>
			<DocumentTocPanel
				items={items}
				onNavigate={handleNavigate}
				breakpoint={breakpoint}
			/>
			{!onAnnounce && (
				<output aria-live="polite" className="sr-only">
					{ownAnnouncement}
				</output>
			)}
		</>
	);
}
