/**
 * `<SystemMessage>` — Fizzy #1412 PR1.
 *
 * Renderer for `role: "system"` operation-result messages in the chat
 * stream. Intercepted by `CustomMessages.tsx` before reaching
 * CopilotKit's `RenderMessage` because CopilotKit has no first-class
 * concept of a system-role thread message (it treats them as no-ops).
 *
 * # Visual design
 *
 *   - Outcome-tinted card surface and vertical bar: success=secondary,
 *     failure=destructive, partial=highlight, cancelled=muted. The bar
 *     and surface use design-token utility classes only (no hex/gradients).
 *   - Uppercase "SYSTEM" eyebrow label (`text-[11px] tracking-[0.2em]`)
 *     — the editorial-label pattern from the marketing redesign.
 *   - Centered narrow column (`max-w-prose mx-auto`) so completion
 *     messages read as "between turns" punctuation, not full assistant
 *     bubbles.
 *   - Outcome indicator (✓ / ✕ / ⏸ / ⊘) on the eyebrow line, with a
 *     `data-outcome-indicator` attribute so tests + analytics can
 *     target it without depending on glyph identity.
 *
 * # Accessibility
 *
 *   - NO `aria-live` on this component. Re-rendering historical
 *     completion messages on SSR/hydration would otherwise blast them
 *     into the AT buffer. The "fresh arrival" announcement is owned by
 *     a dedicated `aria-live="polite"` region that
 *     `useConversationRealtime` mounts higher in the tree.
 *   - Artifact link uses `rel="noopener noreferrer"` (codebase
 *     convention; matches `chat-markdown.tsx`). Prevents
 *     `window.opener` hijacks AND avoids leaking the originating
 *     thread URL via the Referer header. `target="_blank"` because
 *     chat sidebars are narrow and inline navigation would lose
 *     context.
 *
 *   - Body is intentionally **plain text** (`whitespace-pre-wrap`),
 *     NOT markdown. The formatter (`buildOperationResultMessage`)
 *     ships only `HEADER\n\n{summary}{?suffix}` — no `**bold**` or
 *     inline links to interpret. Artifact links travel separately
 *     via `metadata.artifact` and render as a dedicated element
 *     below the body. If a future caller needs rich formatting in
 *     the summary, swap to a markdown renderer at that point rather
 *     than relying on `whitespace-pre-wrap` to "just work".
 *
 * # Anti-patterns deliberately avoided
 *
 *   - No glassmorphism (`backdrop-blur`) — flagged in CLAUDE.md design
 *     section.
 *   - No animated gradient background — same.
 *   - No gradient text on outcome label — same.
 *   - Specific transition properties, never `transition-all`.
 */

"use client";

import { cn } from "@ui/lib";
import type { ReactNode } from "react";

export type SystemMessageOutcome =
	| "success"
	| "failure"
	| "partial"
	| "cancelled";

interface SystemMessageArtifact {
	readonly label: string;
	readonly url: string;
}

interface SystemMessageProps {
	readonly outcome: SystemMessageOutcome;
	readonly content: string;
	readonly artifact?: SystemMessageArtifact;
	readonly className?: string;
}

function outcomeSurface(outcome: SystemMessageOutcome): string {
	switch (outcome) {
		case "success":
			return "border-secondary bg-secondary/5";
		case "failure":
			return "border-destructive bg-destructive/5";
		case "partial":
			return "border-highlight bg-highlight/5";
		case "cancelled":
			return "border-muted-foreground/40 bg-muted/50";
	}
}

function OutcomeIndicator({
	outcome,
}: {
	outcome: SystemMessageOutcome;
}): ReactNode {
	const glyph = ((): string => {
		switch (outcome) {
			case "success":
				return "✓";
			case "failure":
				return "✕";
			case "partial":
				return "◐";
			case "cancelled":
				return "⊘";
		}
	})();
	const colour = ((): string => {
		switch (outcome) {
			case "success":
				return "text-secondary";
			case "failure":
				return "text-destructive";
			case "partial":
				return "text-highlight";
			case "cancelled":
				return "text-muted-foreground";
		}
	})();
	return (
		<span
			aria-hidden="true"
			className={cn("inline-block leading-none align-middle", colour)}
			data-outcome-indicator={outcome}
		>
			{glyph}
		</span>
	);
}

/**
 * Strip the leading `SYSTEM\n\n` header that `buildOperationResultMessage`
 * prepends to the persisted content. The header is part of the
 * persisted text so non-rendered consumers (search, audit, RAG) see the
 * label; the visual component renders it as the editorial eyebrow
 * instead.
 *
 * I3 fix: the formatter no longer inlines the artifact link into
 * `content` — the link travels via `metadata.artifact` and the
 * artifact JSX block below renders it as a separate element. That lets
 * us drop the prior trailing-link regex strip, which over-matched any
 * caller-supplied summary that legitimately ended with a markdown
 * link (e.g. `"See [related](https://x.com)"`).
 */
function extractBody(content: string): string {
	if (content.startsWith("SYSTEM\n\n")) {
		return content.slice("SYSTEM\n\n".length);
	}
	return content;
}

export function SystemMessage({
	outcome,
	content,
	artifact,
	className,
}: SystemMessageProps): ReactNode {
	const body = extractBody(content);

	return (
		<div
			className={cn(
				"max-w-prose mx-auto my-3",
				"border-l-2",
				outcomeSurface(outcome),
				"rounded-r-sm pl-3 pr-3 py-2",
				className,
			)}
			data-message-kind="operation_result"
			data-outcome={outcome}
		>
			<div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground font-medium">
				<OutcomeIndicator outcome={outcome} />
				<span>System</span>
			</div>
			{body.length > 0 && (
				<div className="mt-1 text-[15px] font-medium text-foreground whitespace-pre-wrap leading-relaxed">
					{body}
				</div>
			)}
			{artifact ? (
				<div className="mt-2">
					<a
						href={artifact.url}
						rel="noopener noreferrer"
						target="_blank"
						className="text-sm text-primary underline-offset-4 hover:underline transition-colors"
					>
						{artifact.label}
					</a>
				</div>
			) : null}
		</div>
	);
}
