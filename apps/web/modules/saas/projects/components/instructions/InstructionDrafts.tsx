"use client";

import type { NativeInstructionBase } from "@saas/projects/lib/instruction-change-source";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useState,
} from "react";

/**
 * An edit in progress in the file view: the text typed, and the version of
 * the file it was taken from (see `InstructionFileView`).
 */
export type InstructionDraft = {
	sourceKey: string;
	nativeBase?: NativeInstructionBase;
	path: string;
	text: string;
	/** The commit message once the person has typed one; the default until then. */
	message?: string;
};

type DraftStore = Map<string, InstructionDraft>;

const InstructionDraftsContext = createContext<DraftStore | null>(null);

/**
 * Keeps the edit in progress of each project while its page is open. The
 * Coding Instructions tab is unmounted when another tab is picked, and without
 * a holder above the tabs the text typed went with it. Outside a provider
 * (a page that has no tabs) a draft lives only as long as the file view.
 */
export function InstructionDraftsProvider({
	children,
}: {
	children: ReactNode;
}) {
	const [store] = useState<DraftStore>(() => new Map());
	return (
		<InstructionDraftsContext.Provider value={store}>
			{children}
		</InstructionDraftsContext.Provider>
	);
}

export function useInstructionDraftStore(projectId: string) {
	const store = useContext(InstructionDraftsContext);
	const read = useCallback(
		() => store?.get(projectId) ?? null,
		[store, projectId],
	);
	const write = useCallback(
		(draft: InstructionDraft | null) => {
			if (draft === null) {
				store?.delete(projectId);
			} else {
				store?.set(projectId, draft);
			}
		},
		[store, projectId],
	);
	return { read, write };
}
