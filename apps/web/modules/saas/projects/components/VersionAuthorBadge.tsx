"use client";

import type { DocumentVersionAuthor } from "@repo/utils/document-version-author";
import { BotIcon, UserIcon } from "lucide-react";

/**
 * Who wrote a version — a person, or the auto-refresh agent.
 *
 * The agent is deliberately unmistakable for a person: its own icon, the brand
 * accent, and a named identity. Icon AND name both carry the distinction, so it
 * never rests on colour alone. That rule lives here, once, rather than in every
 * surface that shows a version — the version-history sheet and the diff viewer
 * both render this, and two copies of the rule is two copies that can drift.
 *
 * Renders nothing when the author is absent: legacy rows predate authorship, and
 * omitting is honest where inventing one would not be.
 */
export function VersionAuthorBadge({
	author,
	size = "sm",
}: {
	author: DocumentVersionAuthor | null | undefined;
	size?: "sm" | "md";
}) {
	if (!author) {
		return null;
	}

	const iconClass = size === "md" ? "h-3.5 w-3.5" : "h-3 w-3";
	const gapClass = size === "md" ? "gap-1.5" : "gap-1";
	const isAgent = author.kind === "AI_AGENT";
	const Icon = isAgent ? BotIcon : UserIcon;

	return (
		<span
			className={`flex items-center ${gapClass} ${
				isAgent ? "font-medium text-primary" : ""
			}`}
		>
			<Icon className={iconClass} aria-hidden="true" />
			{author.name}
		</span>
	);
}
