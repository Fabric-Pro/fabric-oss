"use client";

import { useCallback, useState } from "react";

/**
 * A visually-hidden polite live region, plus the hook that feeds it.
 *
 * Why this exists rather than relying on the rendered result: assistive
 * technology announces *updates* to a live region that was already in the
 * accessibility tree, and generally stays silent for a node inserted into the
 * DOM already carrying its final content. An upload row that is inserted in
 * the `failed` state — the shape every queue-time refusal takes — is exactly
 * that case, so the refusal is visible but unspoken. Mounting this region with
 * the surface and writing the refusal into it afterwards is what makes the
 * refusal reach a screen-reader user. WCAG 2.1 AA, 4.1.3 Status Messages.
 *
 * Shared because three upload surfaces refuse files the same way. Import the
 * pair; do not re-implement the region locally.
 */

export type LiveAnnouncer = {
	/** Current live-region text. Pass straight to `<LiveAnnouncerRegion>`. */
	announcement: string;
	/** Write a message into the region. Repeating a message still announces. */
	announce: (message: string) => void;
	/** Clear the region (e.g. when the surface resets). */
	clearAnnouncement: () => void;
};

export function useLiveAnnouncer(): LiveAnnouncer {
	const [announcement, setAnnouncement] = useState("");

	// Announcing the identical string twice leaves the text node untouched, so
	// no mutation reaches the accessibility tree and the second refusal is
	// silent. Alternating a trailing space keeps the spoken text identical
	// while guaranteeing the DOM actually changes.
	const announce = useCallback((message: string) => {
		setAnnouncement((previous) =>
			previous === message ? `${message} ` : message,
		);
	}, []);

	const clearAnnouncement = useCallback(() => setAnnouncement(""), []);

	return { announcement, announce, clearAnnouncement };
}

type LiveAnnouncerRegionProps = {
	/** Text to announce. Empty renders an empty — but still mounted — region. */
	announcement: string;
	/** Test hook for asserting what was announced. */
	"data-testid"?: string;
};

/**
 * Render this once, unconditionally, wherever the announcing surface mounts.
 * `sr-only` is the repo's visually-hidden utility (Tailwind), so the region
 * stays in the accessibility tree while taking no visual space.
 */
export function LiveAnnouncerRegion({
	announcement,
	"data-testid": testId,
}: LiveAnnouncerRegionProps) {
	return (
		<span
			className="sr-only"
			aria-live="polite"
			aria-atomic="true"
			data-testid={testId}
		>
			{announcement}
		</span>
	);
}
