/**
 * The line under "Meeting Transcripts" in the Context tab: how these transcripts
 * got here. #2170 and #1877 both add a way in that is not a sync, and calling
 * either one "synced" hides the only fact that matters about it.
 */
export function transcriptProvenanceLabel(counts: {
	total: number;
	imported: number;
	uploaded: number;
}): string {
	const { total, imported, uploaded } = counts;
	if (uploaded === total && total > 0) {
		return "Uploaded as files";
	}
	if (imported === total && total > 0) {
		return "Added from a personal calendar";
	}

	const synced = total - imported - uploaded;
	return [
		...(synced > 0 || imported + uploaded === 0
			? ["Synced from Microsoft Teams"]
			: []),
		...(imported > 0 ? [`${imported} added from a personal calendar`] : []),
		...(uploaded > 0 ? [`${uploaded} uploaded as files`] : []),
	].join(" · ");
}
