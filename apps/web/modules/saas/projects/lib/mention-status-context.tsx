"use client";

import { createContext, useContext } from "react";

export type MentionActiveIds = ReadonlySet<string> | null;

export const MentionStatusContext = createContext<MentionActiveIds>(null);

export function useMentionStatus(): MentionActiveIds {
	return useContext(MentionStatusContext);
}
