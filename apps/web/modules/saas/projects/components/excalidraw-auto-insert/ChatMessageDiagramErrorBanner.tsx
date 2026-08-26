"use client";

/**
 * Inline error banner rendered under a chat-message canvas when the
 * `editor.commands.insertContentAt` call FAILED but the `Diagram` row
 * was successfully created. The user's diagram is preserved (visible
 * under the Diagrams tab) and the banner offers a Retry path.
 *
 * Spec sections:
 *   - § 8.4   Inline error banner contract
 *   - § 11    Error matrix row 4 (editor-insert failure)
 *   - § 14.5  Accessibility -- WCAG AA color contrast
 *   - § FR-10 Universal fallback (banner + retry)
 *
 * Design tokens only -- no hardcoded hex, no glassmorphism. The
 * `border-destructive/40` / `bg-destructive/5` + `text-destructive`
 * pairing clears WCAG AA contrast per spec § 14.5.
 *
 * The wrapping `<div>` uses `role="status"` + `aria-live="polite"` so
 * screen readers announce the failure without interrupting the user's
 * current task (per spec § 14.5 / `fabric/standards/frontend/accessibility.md`).
 *
 * Retry is a real ghost `<Button>` (shadcn variant), keyboard-reachable,
 * keeps its focus-visible ring (Radix). It does not own state -- the
 * caller (`ChatMessageInsertDiagramButton` / `useInsertDiagramAction`)
 * owns the retry flow.
 */

import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";

/**
 * Props for the inline error banner. Both names are required because
 * the rendered string interpolates both per spec § 14.7
 * (`bannerEditorFailure`).
 */
export interface ChatMessageDiagramErrorBannerProps {
	/** Doc / feature title -- substituted into `{docName}`. */
	docName: string;
	/** Chat-scoped project name -- substituted into `{projectName}`. */
	projectName: string;
	/** Click handler for the Retry button. Caller owns the retry flow. */
	onRetry: () => void;
	/**
	 * Optional className passthrough. Useful when the parent layout
	 * needs to control margins (e.g. inside a chat-message bubble
	 * container with its own spacing rules).
	 */
	className?: string;
}

export function ChatMessageDiagramErrorBanner({
	docName,
	projectName,
	onRetry,
	className,
}: ChatMessageDiagramErrorBannerProps): JSX.Element {
	const t = useTranslations("diagrams.autoInsert");

	// biome-ignore-start lint/a11y/useSemanticElements: spec § 14.5 explicitly mandates `role="status"` + `aria-live="polite"` on the inline error banner (not <output>) so screen readers announce the editor-insert failure without interrupting the user. Banner is a polite live region, not a form output.
	return (
		<div
			role="status"
			aria-live="polite"
			data-slot="excalidraw-auto-insert-error-banner"
			className={cn(
				// Token-driven destructive surface per spec § 14.5.
				"rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2",
				// Inline content layout: message text, Retry button to the right.
				"flex items-center justify-between gap-3",
				// Smaller body text to sit unobtrusively under the canvas.
				"text-sm text-destructive",
				className,
			)}
		>
			<span className="leading-snug">
				{t("bannerEditorFailure", { docName, projectName })}
			</span>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				onClick={onRetry}
				// Keep the ghost-variant hover token but ensure the foreground
				// stays in the destructive family so the button reads as part
				// of the banner, not a generic muted action.
				className="text-destructive hover:bg-destructive/10 hover:text-destructive"
			>
				{t("bannerEditorFailureRetry")}
			</Button>
		</div>
	);
	// biome-ignore-end lint/a11y/useSemanticElements: see start marker above.
}
