"use client";

import { CopilotSidebar } from "@copilotkit/react-ui";
import type { ComponentProps } from "react";
import { CopilotReplyRatingContext } from "./CopilotReplyRatingContext";
import { useCopilotReplyRating } from "./useCopilotReplyRating";

/** Opt-in wrapper for project chats whose persisted replies retain their ids. */
export function CopilotReplyRatingSidebar({
	featureKey,
	projectId,
	enabled,
	...props
}: Omit<
	ComponentProps<typeof CopilotSidebar>,
	"onThumbsUp" | "onThumbsDown"
> & {
	featureKey: string;
	projectId: string;
	enabled: boolean;
}) {
	const rating = useCopilotReplyRating({ featureKey, projectId, enabled });
	return (
		<CopilotReplyRatingContext.Provider value={rating}>
			<CopilotSidebar
				{...props}
				onThumbsUp={rating.onThumbsUp}
				onThumbsDown={rating.onThumbsDown}
			/>
		</CopilotReplyRatingContext.Provider>
	);
}
