"use client";

import type { NodeViewProps } from "@tiptap/react";
import { NodeViewWrapper } from "@tiptap/react";
import { useMentionStatus } from "../lib/mention-status-context";

export function MentionNodeView({ node }: NodeViewProps) {
	const activeIds = useMentionStatus();
	const { id, label, mentionId, anchorId, groupTag } = node.attrs as {
		id: string | null;
		label: string;
		mentionId: string | null;
		anchorId: string | null;
		groupTag: string | null;
	};
	// The live node attribute is `mentionId` (set by the extension command and
	// parsed from data-mention-id). `anchorId` is only a fallback for legacy
	// tests that inject it directly. Rendering `data-mention-id` is what lets
	// the notification deep-link (DocumentEditor querySelector
	// `span[data-mention-id]`) scroll to the chip — for BOTH user and group
	// mentions (Codex plan review #1: the prior code read a non-existent
	// `anchorId`, so a group link could not target its chip).
	const anchor = mentionId ?? anchorId ?? undefined;

	if (groupTag) {
		return (
			<NodeViewWrapper
				as="span"
				className="mention mention-group"
				data-group-tag={groupTag}
				data-label={label}
				data-mention-id={anchor}
				aria-label={`group mention: ${label}`}
			>
				@{label}
			</NodeViewWrapper>
		);
	}

	const isInactive = activeIds !== null && id !== null && !activeIds.has(id);
	const className = isInactive ? "mention mention--inactive" : "mention";
	const ariaLabel = isInactive
		? `mention: ${label} (no longer active)`
		: `mention: ${label}`;

	return (
		<NodeViewWrapper
			as="span"
			className={className}
			data-id={id}
			data-label={label}
			data-mention-id={anchor}
			aria-label={ariaLabel}
		>
			@{label}
		</NodeViewWrapper>
	);
}
