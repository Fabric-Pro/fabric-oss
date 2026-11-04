"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * How the proposal review shows a Markdown file's change: rendered (the
 * document editor's paragraph diff) or as raw lines. Persisted per browser,
 * the way `use-diff-view-mode` keeps the document review mode, under its own
 * key because the two choices are about different surfaces.
 */
export type ProposalDiffMode = "rendered" | "raw";

export const PROPOSAL_DIFF_MODE_STORAGE_KEY =
	"fabric.instructions.proposalDiffMode";

function loadMode(): ProposalDiffMode {
	try {
		const stored = window.localStorage.getItem(
			PROPOSAL_DIFF_MODE_STORAGE_KEY,
		);
		return stored === "raw" ? "raw" : "rendered";
	} catch {
		return "rendered";
	}
}

/**
 * SSR-safe like `useDiffViewMode`: the first render uses the default, then
 * the stored choice is read after mount. Only an explicit change is saved.
 */
export function useProposalDiffMode(): {
	mode: ProposalDiffMode;
	setMode: (mode: ProposalDiffMode) => void;
} {
	const [mode, setModeState] = useState<ProposalDiffMode>("rendered");
	useEffect(() => {
		setModeState(loadMode());
	}, []);
	const setMode = useCallback((next: ProposalDiffMode) => {
		setModeState(next);
		try {
			window.localStorage.setItem(PROPOSAL_DIFF_MODE_STORAGE_KEY, next);
		} catch {
			// Storage unavailable: the choice holds for this page only.
		}
	}, []);
	return { mode, setMode };
}
