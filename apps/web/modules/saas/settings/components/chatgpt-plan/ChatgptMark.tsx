"use client";

import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { SiteFavicon } from "@saas/shared/components/SiteFavicon";
import { OpenAIIcon } from "@saas/workflows/lib/plugins/ai-gateway/icon";
import { ArrowLeftRightIcon } from "lucide-react";

const CHATGPT_SITE_URL = "https://chatgpt.com";

/**
 * ChatGPT's mark, framed like every provider on the AI providers page, so the
 * plan reads as one more provider rather than a block of text.
 */
export function ChatgptMark({ size = 36 }: { size?: number }) {
	return (
		<SiteFavicon
			fallback={<OpenAIIcon className="size-1/2" />}
			name="ChatGPT"
			size={size}
			url={CHATGPT_SITE_URL}
		/>
	);
}

/** ChatGPT ↔ Fabric, heading the page that approves a connection. */
export function ChatgptFabricMarks() {
	return (
		<div
			className="flex items-center justify-center gap-3"
			data-testid="chatgpt-fabric-marks"
		>
			<ChatgptMark size={48} />
			<ArrowLeftRightIcon
				aria-hidden="true"
				className="size-5 text-muted-foreground"
			/>
			<span className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-card">
				<FabricLogo size={28} />
			</span>
		</div>
	);
}
