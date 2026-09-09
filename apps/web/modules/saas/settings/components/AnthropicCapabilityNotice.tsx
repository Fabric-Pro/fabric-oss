"use client";

import {
	ANTHROPIC_CAPABILITY_BODY,
	ANTHROPIC_CAPABILITY_TITLE,
} from "@saas/shared/lib/anthropic-capability";
import { InfoIcon } from "lucide-react";
import { ANTHROPIC_PROVIDER_ID } from "../lib/ai-providers";

/**
 * The capability limitation, stated on the Anthropic card in Direct Providers.
 *
 * It sits with the provider description so the limitation is read before any
 * configure action, and renders whether or not Anthropic is configured — the
 * vendor gap does not close when a key is saved.
 *
 * Amber `--highlight`, matching the AI Models page's capability hints, rather
 * than the emerald tone the embedding prompt on the same page uses to invite a
 * setup action. The two are different speech acts: that one asks you to
 * configure something, this one reports that something is absent.
 *
 * An info glyph, not a warning triangle. This is a permanent vendor fact shown
 * to someone still choosing, and nothing is broken. The app-wide banner takes
 * the triangle instead, because it fires only once document search has actually
 * stopped working.
 *
 * A component rather than the same block pasted into both provider forms. Those
 * two files are otherwise fully forked by long-standing convention, and this
 * notice is the rare piece with no reason to diverge between them: no props
 * beyond the provider it is deciding about, no state, no hooks. The copy
 * already lives in one module, so only the markup could have drifted — this
 * removes that last seam. The two app-chrome banners are deliberately NOT
 * consolidated the same way; they have real reasons to move apart, recorded in
 * their own comments.
 */
export function AnthropicCapabilityNotice({
	providerId,
}: {
	providerId: string;
}) {
	if (providerId !== ANTHROPIC_PROVIDER_ID) {
		return null;
	}

	return (
		<div className="rounded-md border border-highlight/20 bg-highlight/5 p-3">
			<div className="flex gap-2">
				<InfoIcon
					aria-hidden="true"
					className="mt-0.5 size-3.5 shrink-0 text-highlight"
				/>
				<div className="space-y-1">
					<p className="font-medium text-foreground text-xs">
						{ANTHROPIC_CAPABILITY_TITLE}
					</p>
					<p className="text-highlight/80 text-xs">
						{ANTHROPIC_CAPABILITY_BODY}
					</p>
				</div>
			</div>
		</div>
	);
}
