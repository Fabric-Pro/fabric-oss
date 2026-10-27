"use client";

import { createContext, useContext } from "react";

export type CopilotReplyVote = "RATED_UP" | "RATED_DOWN";
export interface CopilotReplyRatingState {
	getVote: (messageId: string) => CopilotReplyVote | undefined;
	isPending: (messageId: string) => boolean;
	canRate: (messageId: string) => boolean;
	setMessageIds: (ids: string[]) => void;
}

export const CopilotReplyRatingContext =
	createContext<CopilotReplyRatingState | null>(null);
export function useCopilotReplyRatingState() {
	return useContext(CopilotReplyRatingContext);
}
