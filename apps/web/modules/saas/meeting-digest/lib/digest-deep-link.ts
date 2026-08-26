/**
 * Deep link from a work item's back-reference into the meeting digest (#1902
 * FR6/AC5).
 *
 * The project page already resolves `?tab=`; this adds `meeting` and
 * `actionItem` so the digest can open the right meeting's detail sheet and
 * highlight the right row.
 *
 * `meeting` is the GRAPH transcript id (`transcriptRef`), never the transcript
 * row cuid — it is what `meetingDigest.getMeeting` accepts and what the sheet's
 * `selected` state holds. `actionItem` is the durable item key, not an action
 * item row id, because those ids are recreated on every extraction and a shared
 * URL has to survive that.
 */

const DIGEST_TAB_ID = "meeting-digest";

export function buildDigestDeepLink(params: {
	basePath: string;
	projectId: string;
	transcriptRef: string;
	itemKey: string;
}): string {
	const query = new URLSearchParams({
		tab: DIGEST_TAB_ID,
		meeting: params.transcriptRef,
		actionItem: params.itemKey,
	});
	return `${params.basePath}/projects/${encodeURIComponent(params.projectId)}?${query.toString()}`;
}

export function parseDigestDeepLink(
	searchParams: Pick<URLSearchParams, "get">,
): { transcriptRef: string | null; itemKey: string | null } {
	return {
		transcriptRef: searchParams.get("meeting"),
		itemKey: searchParams.get("actionItem"),
	};
}
