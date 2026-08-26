"use client";

/**
 * ActiveTemplateIndicator - Shows selected templates as removable chips
 *
 * Appears in the topSlot of ChatInput when templates are selected.
 */

import { X } from "lucide-react";
import type { MentionableTemplate } from "../../../hooks/useTemplateMention";

export interface ActiveTemplateIndicatorProps {
	/** Selected templates to display */
	templates: MentionableTemplate[];
	/** Callback when removing a template */
	onRemove: (templateId: string) => void;
}

export function ActiveTemplateIndicator({
	templates,
	onRemove,
}: ActiveTemplateIndicatorProps) {
	if (templates.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-wrap gap-1.5 px-1 pb-2">
			{templates.map((template) => (
				<span
					key={template.id}
					className="inline-flex items-center gap-1 px-2 py-1 bg-primary/10 text-primary rounded-full text-xs font-medium"
				>
					<span>{template.heroEmojis?.[0] || "🤖"}</span>
					<span className="max-w-[120px] truncate">
						{template.displayName}
					</span>
					<button
						type="button"
						onClick={() => onRemove(template.id)}
						className="hover:bg-primary/20 rounded-full p-0.5 transition-colors"
						aria-label={`Remove ${template.displayName}`}
					>
						<X className="h-3 w-3" />
					</button>
				</span>
			))}
		</div>
	);
}
