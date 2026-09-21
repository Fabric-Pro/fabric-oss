import {
	TODO_BINDING_VERSION,
	computeActionItemKey,
	db,
	isFeatureEnabled,
	upsertPersonLink,
} from "@repo/database";
import { logger } from "@repo/logs";
import { resolveMeetingTranscriptForProposal } from "./meeting-provenance";

/**
 * #1902 FR7 / AC9: when a work item is created from a meeting action item, link
 * the two at creation time.
 *
 * `origin: CREATED` rather than MANUAL: the user asked for a ticket, not for a
 * link, so the link is a consequence of their action rather than the action
 * itself. It matters at read time — the digest presents CREATED links as fact
 * ("this ticket came from here") and AUTO links as suggestions.
 *
 * #2340: a proposal identifies its action item in two ways, and this module
 * resolves them in a fixed order — stable key, then row id, then the coarse
 * transcript-level back-link. The order exists because the row id is the weaker
 * of the two: `extractMeetingInsightsActivity` replaces a transcript's action
 * items with `deleteMany` + `createMany` inside one transaction on every run, so
 * `ProjectMeetingActionItem.id` does not survive a re-extraction. A proposal
 * filed before a re-extraction and approved after it therefore addressed a row
 * that no longer existed, and the link was simply never written. The stable key
 * is `computeTodoItemKey` over the item's normalized text, which a re-extraction
 * preserves as long as the wording does.
 */
export function readActionItemIdFromMetadata(
	sourceMetadata: unknown,
): string | null {
	const meta = (sourceMetadata ?? {}) as Record<string, unknown>;
	return typeof meta.actionItemId === "string" ? meta.actionItemId : null;
}

/**
 * #2340: the stable key a proposal carries, or null when it carries none this
 * code is allowed to trust.
 *
 * The version is checked, not ignored. `TODO_BINDING_VERSION` is documented as
 * an explicit, reviewed lever for re-deriving every to-do binding, and the key
 * stored here is a digest under one particular value of it. Trusting a key
 * written under a different version would resolve it against rows keyed under
 * the current one, which cannot match — or, worse after some future change to
 * the digest, could match the wrong item. A version we do not recognise means
 * "this key addresses nothing I can reason about", so resolution falls through
 * to the row id and, failing that, is reported. That mirrors the binding
 * module's own rule: a stale binding is surfaced as unresolved rather than
 * silently rebound to something that merely looks similar.
 *
 * Proposals filed before #2340 carry no key at all and land here as null, which
 * is exactly the fall-through the row-id lookup exists to serve.
 */
export function readActionItemKeyFromMetadata(
	sourceMetadata: unknown,
): string | null {
	const meta = (sourceMetadata ?? {}) as Record<string, unknown>;
	if (typeof meta.actionItemKey !== "string" || meta.actionItemKey === "") {
		return null;
	}
	return meta.actionItemKeyVersion === TODO_BINDING_VERSION
		? meta.actionItemKey
		: null;
}

/** The transcript row id a per-item proposal records at filing time (#1823). */
function readTranscriptRecordIdFromMetadata(
	sourceMetadata: unknown,
): string | null {
	const meta = (sourceMetadata ?? {}) as Record<string, unknown>;
	return typeof meta.transcriptRecordId === "string"
		? meta.transcriptRecordId
		: null;
}

const LINK_TARGET_SELECT = {
	text: true,
	transcriptId: true,
	// Tenancy copied from the parent transcript — same rule as the manual
	// link procedure, so a link always shares its meeting's RLS scope.
	transcript: { select: { userId: true, organizationId: true } },
} as const;

export async function linkStoryToSourceActionItem(params: {
	projectId: string;
	sourceMetadata: unknown;
	storyId: string;
	createdById: string;
	/**
	 * #2340: the proposal being approved. Optional only so that callers which
	 * predate this parameter keep compiling; supplying it is what lets an
	 * unresolved item name its meeting in the log below.
	 */
	proposalId?: string | null;
	/**
	 * The proposal's `source`. Defaults to MONITORED_MEETING because every
	 * proposal that can carry an action item is filed under that source; a
	 * caller passing anything else correctly gets no transcript back.
	 */
	proposalSource?: string;
}): Promise<{ linkId: string } | null> {
	const itemKey = readActionItemKeyFromMetadata(params.sourceMetadata);
	const actionItemId = readActionItemIdFromMetadata(params.sourceMetadata);
	// Meeting-level auto-analyze proposals reference no single item, so they are
	// not unresolved — there was never anything to resolve. They get
	// transcript-level provenance (`sourceMeetingTranscriptId`) instead, which
	// is a different, coarser link, and they must not query or log here.
	if (!itemKey && !actionItemId) {
		return null;
	}
	if (!(await isFeatureEnabled("MEETING_ACTION_ITEM_LINKING"))) {
		return null;
	}

	const transcriptRecordId = readTranscriptRecordIdFromMetadata(
		params.sourceMetadata,
	);

	let item: {
		text: string;
		transcriptId: string;
		transcript: { userId: string | null; organizationId: string | null };
	} | null = null;
	let resolvedVia: "itemKey" | "actionItemId" | null = null;

	// 1. The stable key, scoped to the meeting the proposal names.
	//
	// The scoping is not incidental. A key is a digest of normalized TEXT, and
	// "Update the roadmap" is said in a great many meetings — a project-wide
	// match would cheerfully link a story to an identically worded item from a
	// different meeting, which is a wrong link rather than a missing one, and
	// far harder to notice. `transcriptRecordId` has been on every per-item
	// proposal since #1823, so the narrow lookup is the normal path; the widened
	// one below covers only proposals older than that.
	//
	// `findFirst` by ascending `orderIndex` because several live items can
	// normalize to one key. That picks occurrence 0, the same tie-break
	// `bindActionItemsToTodos` applies, so the link and the to-do layer agree on
	// which duplicate a key means.
	if (itemKey) {
		item = await db.projectMeetingActionItem.findFirst({
			where: {
				itemKey,
				transcript: { projectId: params.projectId },
				...(transcriptRecordId
					? { transcriptId: transcriptRecordId }
					: {}),
			},
			orderBy: { orderIndex: "asc" },
			select: LINK_TARGET_SELECT,
		});
		if (item) {
			resolvedVia = "itemKey";
		}
	}

	// 2. The row id, unchanged. Still the only thing a pre-#2340 proposal
	// carries, and still correct whenever no re-extraction has intervened. Rows
	// written before `itemKey` was added to the model have a NULL column and
	// miss step 1 entirely, which is precisely what this step is for.
	if (!item && actionItemId) {
		item = await db.projectMeetingActionItem.findFirst({
			where: {
				id: actionItemId,
				transcript: { projectId: params.projectId },
			},
			select: LINK_TARGET_SELECT,
		});
		if (item) {
			resolvedVia = "actionItemId";
		}
	}

	if (!item) {
		// 3. The transcript-level back-link. It cannot produce an item link —
		// with no live row there is no text to key on and no tenancy to copy —
		// but it is what the proposal still resolves to, and it is deliberately
		// consulted here rather than assumed: the caller stamps the same
		// transcript on the story as coarse provenance, so an unresolved item
		// degrades to a meeting-level answer instead of to nothing.
		//
		// #2340: and it is LOGGED. Before this, an item the extraction activity
		// had reworded or dropped produced a silent null: no link, no error, no
		// trace, and the loss was invisible to everyone including the person who
		// had just asked for the ticket. That silence is what let the defect
		// live. `warn` rather than `error` because approval must still succeed —
		// a missing link is a degraded result, not a failed one.
		const transcript = params.proposalId
			? await resolveMeetingTranscriptForProposal({
					projectId: params.projectId,
					proposalId: params.proposalId,
					proposalSource:
						params.proposalSource ?? "MONITORED_MEETING",
					sourceMetadata: params.sourceMetadata,
				})
			: null;
		logger.warn("[meeting-provenance] link_source_action_item", {
			span: "meeting-provenance",
			step: "link_source_action_item",
			outcome: "unresolved",
			projectId: params.projectId,
			proposalId: params.proposalId ?? null,
			transcriptId: transcript?.id ?? transcriptRecordId,
			storyId: params.storyId,
			// Which addresses the proposal offered, so a reader can tell a
			// reworded item (had a key, matched nothing) from a legacy proposal
			// that never had one. The item's text is deliberately absent —
			// meeting content does not belong in logs.
			hasItemKey: itemKey !== null,
			hasActionItemId: actionItemId !== null,
		});
		return null;
	}

	const link = await upsertPersonLink({
		transcriptId: item.transcriptId,
		projectId: params.projectId,
		// The LINK's own key, from `computeActionItemKey` — not the to-do
		// binding key that addressed the row above. The two digests are
		// versioned independently on purpose, and the link table has always
		// been keyed with this one.
		itemKey: computeActionItemKey(item.text),
		itemTextSnapshot: item.text,
		storyId: params.storyId,
		origin: "CREATED",
		createdById: params.createdById,
		userId: item.transcript.userId,
		organizationId: item.transcript.organizationId,
	});
	logger.debug("[meeting-provenance] link_source_action_item", {
		span: "meeting-provenance",
		step: "link_source_action_item",
		outcome: "linked",
		projectId: params.projectId,
		proposalId: params.proposalId ?? null,
		transcriptId: item.transcriptId,
		storyId: params.storyId,
		resolvedVia,
	});
	return { linkId: link.id };
}
