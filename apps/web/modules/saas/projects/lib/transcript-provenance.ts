/**
 * The line under "Meeting Transcripts" in the Context tab: how these transcripts
 * got here. #2170, #1877 and #3507 each add a way in that is not a sync, and
 * calling one "synced" hides the only fact that matters about it.
 */
export function transcriptProvenanceLabel(counts: {
	total: number;
	imported: number;
	uploaded: number;
	/** Imported from a connected OneDrive folder (#3507). */
	fromOneDrive?: number;
}): string {
	const { total, imported, uploaded } = counts;
	const fromOneDrive = counts.fromOneDrive ?? 0;
	if (uploaded === total && total > 0) {
		return "Uploaded as files";
	}
	if (fromOneDrive === total && total > 0) {
		return "Imported from OneDrive folders";
	}
	if (imported === total && total > 0) {
		return "Added from a personal calendar";
	}

	const synced = total - imported - uploaded - fromOneDrive;
	return [
		...(synced > 0 || imported + uploaded + fromOneDrive === 0
			? ["Synced from Microsoft Teams"]
			: []),
		...(imported > 0 ? [`${imported} added from a personal calendar`] : []),
		...(uploaded > 0 ? [`${uploaded} uploaded as files`] : []),
		...(fromOneDrive > 0
			? [`${fromOneDrive} imported from OneDrive folders`]
			: []),
	].join(" · ");
}
