import { fetchPmTicket } from "./fetch-pm-ticket";
import { getPmSyncBaseline, stampPmSyncConflict } from "./hierarchy-sync";
import { computePmHash } from "./pm-sync-hash";
import {
	type PreviewPmSyncConflictInput,
	type PreviewPmSyncItemType,
	previewPmSyncConflict,
} from "./preview-pm-sync-conflict";
import type { PMToolCapabilities } from "./tool-analyzer";

export interface DetectAndStampPmPushConflictInput
	extends Omit<PreviewPmSyncConflictInput, "itemType"> {
	/**
	 * Widened to include `testCase` (QA feature). Test-case drift is
	 * detected via the fast path only — there is no GitLab-REST / preview
	 * fallback for test cases in v1.
	 */
	itemType: PreviewPmSyncItemType | "testCase";
	/**
	 * The item's external PM id. Lets the fast path skip a DB round-trip to
	 * resolve it.
	 */
	externalId?: string | null;
	/**
	 * Capabilities the caller already discovered for this sync. When present
	 * (with an MCP config), the fast path skips a per-item capability discovery
	 * — the single biggest cost when checking many items in a bulk loop.
	 */
	capabilities?: PMToolCapabilities;
}

/**
 * Bulk-sync conflict guard: detect PM-side drift for an item and, when found,
 * stamp `lastPmSyncStatus = CONFLICT` so it surfaces in the Review Center
 * instead of being silently overwritten by a batch push.
 *
 * Fast path (the common case): when the caller passes its already-discovered
 * `capabilities` and an MCP `mcpConfigId`, this checks drift directly
 * (`getPmSyncBaseline` → `fetchPmTicket` → hash compare), mirroring
 * `syncWorkItemToPM`'s inline check. This avoids re-running a (slow) capability
 * discovery for every item in a bulk loop — which previously made large batch
 * syncs take tens of seconds per item.
 *
 * Fallback (GitLab REST, or when capabilities aren't supplied): delegate to the
 * standalone {@link previewPmSyncConflict}, which resolves config + discovers
 * capabilities itself and handles the REST path.
 *
 * The only write is the CONFLICT stamp; it is otherwise read-only.
 */
export async function detectAndStampPmPushConflict(
	input: DetectAndStampPmPushConflictInput,
): Promise<{ hasConflict: boolean }> {
	const { itemType } = input;
	const isStampable =
		itemType === "story" || itemType === "bug" || itemType === "testCase";

	// Fast path — reuse the caller's resolved MCP config + discovered capabilities.
	if (
		isStampable &&
		input.mcpConfigId &&
		input.externalId &&
		input.capabilities?.taskGet
	) {
		const baseline = await getPmSyncBaseline(
			itemType,
			input.itemId,
			input.projectId,
		);
		if (!baseline) {
			return { hasConflict: false };
		}
		let snapshot: Awaited<ReturnType<typeof fetchPmTicket>>;
		try {
			snapshot = await fetchPmTicket({
				mcpConfigId: input.mcpConfigId,
				userId: input.userId,
				organizationId: input.organizationId,
				capabilities: input.capabilities,
				externalId: input.externalId,
				containerId: input.containerId,
				containerName: input.containerName,
				additionalContext: input.additionalContext,
			});
		} catch {
			// PM read failed — can't determine drift, so let the push proceed
			// rather than block it (matches previewPmSyncConflict's posture).
			return { hasConflict: false };
		}
		if (!snapshot) {
			return { hasConflict: false };
		}
		if (computePmHash(snapshot.title, snapshot.description) === baseline) {
			return { hasConflict: false };
		}
		await stampPmSyncConflict(itemType, input.itemId);
		return { hasConflict: true };
	}

	// Test cases have no GitLab-REST / preview fallback in v1 — only the fast
	// path applies. Without it we cannot determine drift, so let the push
	// proceed (matching the read-failure posture above).
	if (itemType === "testCase") {
		return { hasConflict: false };
	}

	// Fallback (story/bug): robust standalone detector (resolves config +
	// discovers caps, and handles the GitLab-REST path). `itemType` is narrowed
	// to the preview union here, so the input is assignable.
	const result = await previewPmSyncConflict({ ...input, itemType });
	// Guard the stamp with `isStampable` exactly as the fast path does — only
	// story/bug drift is surfaced through this fallback (test cases already
	// returned above via the fast-path-only branch). This preserves the
	// original `isStoryLike` behavior: epic/feature conflicts are detected but
	// not stamped here.
	if (result.hasConflict && isStampable) {
		await stampPmSyncConflict(itemType, input.itemId);
	}
	return { hasConflict: result.hasConflict };
}
