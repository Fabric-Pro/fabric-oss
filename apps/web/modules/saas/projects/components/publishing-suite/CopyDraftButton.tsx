"use client";

import { Button } from "@ui/components/button";
import { CopyIcon } from "lucide-react";
import { toast } from "sonner";

/**
 * Copy a working draft's Markdown to the clipboard (Fizzy #1854, Phase 2C-1).
 *
 * Takes the text rather than an id: a publishing working draft is already in
 * the page — the panel is rendering it in a textarea — so re-fetching it would
 * copy something other than what the reader is looking at, which is precisely
 * the failure a copy button must not have.
 *
 * That contract is also why this button does NOT get the caveat block its
 * neighbour `DraftDownloadDropdown` carries on the Case Study panel, even
 * though both egress the same draft to the same kind of reader. The asymmetry
 * is decided rather than incidental, and `composeExportMarkdown` in
 * `CaseStudyPanel.tsx` states the reasoning: a download becomes a file that
 * travels on its own, where a copy lands in a buffer whose owner is looking at
 * the safety blocks on this page as they press the button.
 *
 * The clipboard API is GUARDED rather than assumed. `navigator.clipboard` is
 * undefined in jsdom, on an insecure origin, and in a browser that has denied
 * the permission — and `writeText` rejects rather than throwing synchronously
 * when the document is not focused. An unguarded call is a silent no-op there:
 * the reader believes they have the draft on the clipboard, pastes whatever was
 * on it before, and never learns the copy failed. So every failing path ends in
 * a toast that says what happened and what to do instead; none of them throws,
 * because an exception out of an onClick takes the panel down with it.
 */
export function CopyDraftButton({
	markdown,
	label = "Copy draft",
	disabled = false,
}: {
	/** The exact text the reader is looking at. */
	markdown: string;
	/** Visible text. The accessible name extends it, never replaces it. */
	label?: string;
	disabled?: boolean;
}) {
	const handleCopy = async () => {
		const clipboard =
			typeof navigator === "undefined" ? undefined : navigator.clipboard;
		if (typeof clipboard?.writeText !== "function") {
			toast.error(
				"This browser wouldn't let the page reach the clipboard. Select the draft text and copy it instead.",
			);
			return;
		}
		try {
			await clipboard.writeText(markdown);
			toast.success("Draft copied to the clipboard.");
		} catch {
			toast.error(
				"Could not copy the draft. Select the draft text and copy it instead.",
			);
		}
	};

	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			// The visible label is contained in the accessible name (WCAG 2.5.3),
			// so a speech-input user can say what they can see.
			aria-label={`${label} to the clipboard`}
			onClick={() => {
				void handleCopy();
			}}
			disabled={disabled}
		>
			<CopyIcon className="mr-2 size-4" aria-hidden="true" />
			{label}
		</Button>
	);
}
