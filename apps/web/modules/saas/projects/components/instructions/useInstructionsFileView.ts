import { useCallback, useEffect, useRef, useState } from "react";
import type { InstructionsSnapshot } from "../../lib/instructions-snapshot";

type ResolvedFile = {
	projectId: string;
	path: string;
	snapshot: InstructionsSnapshot;
};

export function useInstructionsFileView({
	projectId,
	published,
	selectedFile,
	fileListLoaded,
}: {
	projectId: string;
	published: InstructionsSnapshot | null;
	selectedFile: string | null;
	fileListLoaded: boolean;
}) {
	const [lastResolvedFile, setLastResolvedFile] =
		useState<ResolvedFile | null>(null);
	const displayedFileRef = useRef<ResolvedFile | null>(null);
	const [draftOwner, setDraftOwner] = useState<ResolvedFile | null>(null);
	const onDraftStateChange = useCallback(
		(draft: { snapshotId: string; path: string } | null) => {
			setDraftOwner((previous) => {
				if (draft === null) {
					return previous?.projectId === projectId ? null : previous;
				}
				const displayed = displayedFileRef.current;
				if (
					displayed === null ||
					displayed.projectId !== projectId ||
					displayed.snapshot.id !== draft.snapshotId ||
					displayed.path !== draft.path
				) {
					return previous;
				}
				return displayed;
			});
		},
		[projectId],
	);
	const heldDraftFile =
		draftOwner?.projectId === projectId ? draftOwner : null;
	const holdingDraft =
		heldDraftFile !== null &&
		(heldDraftFile.snapshot.id !== published?.id ||
			heldDraftFile.path !== selectedFile);

	useEffect(() => {
		if (!holdingDraft && published !== null && selectedFile !== null) {
			setLastResolvedFile({
				projectId,
				path: selectedFile,
				snapshot: published,
			});
		}
	}, [holdingDraft, projectId, published, selectedFile]);

	const heldFile =
		lastResolvedFile?.projectId === projectId ? lastResolvedFile : null;
	const fileView =
		holdingDraft && heldDraftFile !== null && published !== null
			? { ...heldDraftFile, current: false }
			: selectedFile !== null && published !== null
				? { path: selectedFile, snapshot: published, current: true }
				: heldFile !== null && published !== null && !fileListLoaded
					? { ...heldFile, current: false }
					: null;
	displayedFileRef.current =
		fileView === null
			? null
			: {
					projectId,
					path: fileView.path,
					snapshot: fileView.snapshot,
				};

	return { fileView, onDraftStateChange };
}
