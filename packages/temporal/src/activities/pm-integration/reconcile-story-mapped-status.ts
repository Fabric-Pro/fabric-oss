/**
 * Apply a PM ticket's mapped status to one Fabric story (Fizzy #2304).
 *
 * Spec §4.4. While a project's "Keep status in sync with the PM tool" switch
 * is on, the hourly poll (`reconcileAdoStates`) calls, AFTER terminal handling
 * and with the story read through `STATUS_SYNC_STORY_SELECT`:
 * - `recordTerminalObservation` for every terminal verdict (row 1);
 * - `reconcileStoryMappedStatus` for every `auto-unhid` or
 *   `non-terminal-passthrough` verdict (rows 3–10).
 *
 * LEAF discipline, as in `reconcile-story-terminal-status.ts`: this module
 * imports only `@repo/database`, `@repo/integrations/pm`, `@repo/logs`, the
 * sync-log helper and the pure provenance / tool-match helpers — NEVER
 * `./story-sync` or `./pm-state-poll`, which would close an import cycle. A
 * test in `__tests__/reconcile-story-mapped-status.test.ts` pins this.
 *
 * Every story write is a compare-and-set on exactly what the caller read —
 * `{ id, projectId, statusId, pmStatusSyncBaseId, pmStatusSyncBaseAt,
 * pmStatusSyncBaseLink, pmStatusSyncBaseFabricId }`, where a null matches
 * `IS NULL`. A Fabric move or a push stamp landing between the poll's read and
 * this write makes the count 0: the outcome is `raced`, nothing else is
 * written, and the next poll decides again from fresh state. Every base write
 * records F (`pmStatusSyncBaseFabricId`), the Fabric status the observation
 * was made against, which the push gate compares with (spec §4.5). Nothing here
 * goes through `move-story`, so no push, column automation or notification
 * fires.
 */
import {
	db,
	hasPmSyncConflictWithDedupeKey,
	recordAudit,
} from "@repo/database";
import {
	decidePmStatusSync,
	type LabelStatusMap,
	PM_STATUS_SYNC_SENTINEL,
	resolveMappedStatus,
	type StatusSyncOutcome,
	toResolvedTicketStatus,
} from "@repo/integrations/pm";
import { logger } from "@repo/logs";
import {
	decideCandidate,
	extractEntityOrgKey,
	mapKeyToPatternType,
	type TrustedKey,
} from "./pm-server-provenance-match";
import { belongsToDifferentKnownTool, safeHost } from "./pm-tool-mismatch";
import { recordPmSyncLog } from "./record-pm-sync-log";

/** The story as the poll reads it for status sync (spec D2.5). */
export interface StatusSyncStoryRow {
	id: string;
	title: string;
	statusId: string;
	order: number;
	pmStatusSyncBaseId: string | null;
	pmStatusSyncBaseAt: Date | null;
	pmStatusSyncBaseLink: string | null;
	/** F — the Fabric status the observation P was made against. */
	pmStatusSyncBaseFabricId: string | null;
	lastPmSyncStatus: string | null;
	externalId: string | null;
	externalUrl: string | null;
	externalMcpServerId: string | null;
}

/** The poll's story read. Typed so a missing or extra field fails to compile. */
export const STATUS_SYNC_STORY_SELECT: {
	[K in keyof StatusSyncStoryRow]: true;
} = {
	id: true,
	title: true,
	statusId: true,
	order: true,
	pmStatusSyncBaseId: true,
	pmStatusSyncBaseAt: true,
	pmStatusSyncBaseLink: true,
	pmStatusSyncBaseFabricId: true,
	lastPmSyncStatus: true,
	externalId: true,
	externalUrl: true,
	externalMcpServerId: true,
};

interface StatusSyncLeafInput {
	projectId: string;
	/** `ownerUserId` is the project owner — the personal half of the log's XOR tenant. */
	tenant: { organizationId: string | null; ownerUserId: string | null };
	item: {
		externalId: string;
		/** Normalized status string; "" for tools without one (GitLab). */
		state: string;
		labels: string[];
		/** d — the verdict's `stateChangedDate`. */
		stateChangedDate: Date | null;
		/**
		 * The fetched issue's own URL (REST GitLab, switch on; spec D2.3),
		 * passed through from the verdict unchanged. REST: `undefined` = the
		 * verdict was fetched with the switch off (not observed); `null` = the
		 * issue had no URL (row 3, unverified).
		 */
		itemUrl?: string | null;
	};
	story: StatusSyncStoryRow;
	config: {
		labelStatusMap: LabelStatusMap;
		statusColumnMap: Record<string, string>;
		projectStatuses: ReadonlyArray<{ id: string; name: string }>;
	};
	source: {
		/** `projectManagementMcpConfigId === null` on the project row. */
		isRest: boolean;
		activeServerId: string;
		/** PM server key, e.g. "gitlab-official", "azure-devops". */
		pmToolKey: string | null;
		/** Human label, e.g. "GitLab" — used in audit metadata and log copy. */
		pmToolLabel: string;
		/**
		 * The project's trusted org for never-stamped MCP stories
		 * (`resolveTrusted(...).trusted`), or null when not resolved / not
		 * resolvable. Unused for REST and for stamped stories.
		 */
		activeOrg: TrustedKey | null;
	};
}

/** Trim, drop trailing slashes, lower-case the scheme and host. The path keeps its case. */
export function normalizeIssueUrl(url: string): string {
	const trimmed = url.trim().replace(/\/+$/, "");
	const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(trimmed);
	if (!match) {
		return trimmed;
	}
	const [, scheme, host, rest] = match;
	return `${scheme.toLowerCase()}${host.toLowerCase()}${rest}`;
}

/**
 * K — the story's current link key (spec §4.4): the NORMALISED issue URL
 * (`normalizeIssueUrl`) for REST GitLab, the raw external id for MCP tools.
 * Null when the story carries none.
 *
 * The REST key is normalised because AC8's linked-issue check (`isLinkedIssue`
 * below) already compares URLs after normalization: a cosmetic rewrite of
 * `story.externalUrl` (a trailing slash, a different host case) still passes
 * that check. If K stayed raw, that same rewrite would change K without
 * changing which issue it means, so a base stamped against the pre-rewrite
 * URL would stop matching K — the base would read as absent (a "first
 * observation"), and the ticket's status would silently overwrite a
 * Fabric-only move it never actually contradicted (Codex C5).
 */
export function statusSyncLinkKey(
	story: Pick<StatusSyncStoryRow, "externalUrl" | "externalId">,
	isRest: boolean,
): string | null {
	if (isRest) {
		const url = story.externalUrl;
		return url && url.length > 0 ? normalizeIssueUrl(url) : null;
	}
	const key = story.externalId;
	return key && key.length > 0 ? key : null;
}

/**
 * AC8 — is the fetched item this story's own linked issue? Pure.
 *
 * - REST GitLab: the fetched issue's URL equals the story's `externalUrl`
 *   after `normalizeIssueUrl`. A missing URL on either side proves nothing,
 *   so it fails.
 * - MCP, story stamped with a server: that server must be the active one.
 * - MCP, story never stamped (import never stamps; only a manual push does):
 *   the story's URL must belong to the active tool (not another known tool's
 *   host) AND carry the project's trusted org. "Trusted org" is
 *   `resolveTrusted`'s answer — the same fail-closed rule the provenance
 *   backfill applies before it stamps a row — so an unknown or ambiguous org,
 *   a host no pattern knows, or a URL without an org segment all fail.
 */
export function isLinkedIssue(input: {
	isRest: boolean;
	storyExternalUrl: string | null;
	storyExternalMcpServerId: string | null;
	itemUrl: string | null | undefined;
	activeServerId: string;
	pmToolKey: string | null;
	activeOrg: TrustedKey | null;
}): boolean {
	if (input.isRest) {
		if (!input.storyExternalUrl || !input.itemUrl) {
			return false;
		}
		return (
			normalizeIssueUrl(input.storyExternalUrl) ===
			normalizeIssueUrl(input.itemUrl)
		);
	}
	if (input.storyExternalMcpServerId !== null) {
		return input.storyExternalMcpServerId === input.activeServerId;
	}
	const toolType = mapKeyToPatternType(input.pmToolKey);
	const host = input.storyExternalUrl
		? safeHost(input.storyExternalUrl)
		: null;
	if (
		toolType === null ||
		host === null ||
		belongsToDifferentKnownTool(host, toolType)
	) {
		return false;
	}
	return (
		decideCandidate({
			toolType,
			externalUrl: input.storyExternalUrl,
			entityOrgKey: extractEntityOrgKey(toolType, input.storyExternalUrl),
			trusted: input.activeOrg ?? { kind: "none" },
		}).action === "stamp"
	);
}

/**
 * Spec §4.4 rows 3–10 for one `auto-unhid` / `non-terminal-passthrough`
 * verdict. Returns the outcome the poll tallies into the last-run summary, or
 * `null` when nothing was observed (the poll tallies nothing).
 */
export async function reconcileStoryMappedStatus(
	input: StatusSyncLeafInput,
): Promise<{ outcome: StatusSyncOutcome | null }> {
	const { projectId, item, story, config, source } = input;

	// Spec D2.3 — a REST verdict with no `itemUrl` key was fetched while the
	// switch was off (it came on before reconcile). Nothing was observed for
	// the linked-issue check: no write, no CONFLICT row, and no outcome — not
	// even `unverified`. The next cycle's fetch carries the URL.
	if (source.isRest && item.itemUrl === undefined) {
		return { outcome: null };
	}

	const linkKey = statusSyncLinkKey(story, source.isRest);

	// Row 3 (AC8) — never apply an issue we cannot show is this story's own.
	if (
		linkKey === null ||
		!isLinkedIssue({
			isRest: source.isRest,
			storyExternalUrl: story.externalUrl,
			storyExternalMcpServerId: story.externalMcpServerId,
			itemUrl: item.itemUrl,
			activeServerId: source.activeServerId,
			pmToolKey: source.pmToolKey,
			activeOrg: source.activeOrg,
		})
	) {
		await recordStatusSyncConflict(input, unverifiedConflict(input));
		return { outcome: "unverified" };
	}

	const resolved = toResolvedTicketStatus(
		resolveMappedStatus({
			labels: item.labels,
			statusString: item.state.length > 0 ? item.state : null,
			labelStatusMap: config.labelStatusMap,
			statusColumnMap: config.statusColumnMap,
			projectStatuses: config.projectStatuses,
		}),
	);
	const { outcome, write } = decidePmStatusSync({
		resolved,
		fabricStatusId: story.statusId,
		base: {
			baseId: story.pmStatusSyncBaseId,
			baseAt: story.pmStatusSyncBaseAt,
			baseLink: story.pmStatusSyncBaseLink,
			baseFabricId: story.pmStatusSyncBaseFabricId,
		},
		linkKey,
		stateChangedDate: item.stateChangedDate,
		pushConflictPending: story.lastPmSyncStatus === "CONFLICT",
	});

	// Rows 4, 5, 9 and the no-op halves of rows 6–8: no story write.
	if (write === null) {
		if (outcome === "ambiguous" && resolved.kind === "ambiguous") {
			await recordStatusSyncConflict(
				input,
				ambiguousConflict(input, resolved),
			);
		}
		return { outcome };
	}

	// Rows 6–8 — record the observation only (F = L).
	if (write.statusId === undefined) {
		const count = await compareAndSetStory(projectId, story, {
			pmStatusSyncBaseId: write.baseId,
			pmStatusSyncBaseAt: write.baseAt,
			pmStatusSyncBaseLink: write.baseLink,
			pmStatusSyncBaseFabricId: write.baseFabricId,
		});
		if (count === 0) {
			return raced(projectId, story, outcome);
		}
		if (outcome === "ambiguous" && resolved.kind === "ambiguous") {
			await recordStatusSyncConflict(
				input,
				ambiguousConflict(input, resolved),
			);
		}
		return { outcome };
	}

	// Row 10 — moved. Appended to the end of the target column, computed the
	// way `moveStory` computes it (packages/database/prisma/queries/projects/stories.ts).
	const toStatusId = write.statusId;
	const last = await db.userStory.findFirst({
		where: { projectId, statusId: toStatusId },
		orderBy: { order: "desc" },
		select: { order: true },
	});
	const count = await compareAndSetStory(projectId, story, {
		statusId: toStatusId,
		order: (last?.order ?? 0) + 1,
		pmStatusSyncBaseId: write.baseId,
		pmStatusSyncBaseAt: write.baseAt,
		pmStatusSyncBaseLink: write.baseLink,
		pmStatusSyncBaseFabricId: write.baseFabricId,
		lastEditedAt: new Date(),
		lastEditedSource: "PM_PULL",
		lastEditedByName: null,
	});
	if (count === 0) {
		return raced(projectId, story, outcome);
	}

	recordAudit({
		action: "story.pm_status_synced",
		category: "story",
		actor: { type: "system" },
		organizationId: input.tenant.organizationId,
		projectId,
		resource: { type: "story", id: story.id, name: story.title },
		metadata: {
			fromStatus: story.statusId,
			toStatus: toStatusId,
			statusName:
				config.projectStatuses.find((s) => s.id === toStatusId)?.name ??
				toStatusId,
			source: "PM_STATUS_SYNC",
			pmTool: source.pmToolLabel,
		},
	});
	await recordPmSyncLog({
		...syncLogTenant(input),
		projectId,
		direction: "pull",
		entityType: "STORY",
		entityId: story.id,
		title: story.title,
		pmTool: pmSyncLogToolSlug(source.pmToolKey),
		status: "SUCCESS",
		actorUserId: null,
		externalId: item.externalId,
		externalUrl: story.externalUrl,
	});
	return { outcome: "moved" };
}

/**
 * Spec §4.4 row 1 — a terminal verdict records `__terminal__` in the base
 * (against the story's current status, F = L), so the reopen that follows
 * counts as a change (AC6). Skipped when the base already says terminal for
 * this link. Compare-and-set like every other write; a lost race is left for
 * the next terminal verdict.
 */
export async function recordTerminalObservation(input: {
	projectId: string;
	story: StatusSyncStoryRow;
	linkKey: string;
	stateChangedDate: Date | null;
}): Promise<void> {
	const { projectId, story, linkKey, stateChangedDate } = input;
	const observed =
		story.pmStatusSyncBaseLink === linkKey
			? story.pmStatusSyncBaseId
			: null;
	if (observed === PM_STATUS_SYNC_SENTINEL.TERMINAL) {
		return;
	}
	const count = await compareAndSetStory(projectId, story, {
		pmStatusSyncBaseId: PM_STATUS_SYNC_SENTINEL.TERMINAL,
		pmStatusSyncBaseAt: stateChangedDate,
		pmStatusSyncBaseLink: linkKey,
		pmStatusSyncBaseFabricId: story.statusId,
	});
	if (count === 0) {
		logger.debug(
			"[PM Poll] Terminal status-sync observation lost a race; the next terminal verdict records it",
			{ projectId, storyId: story.id },
		);
	}
}

/**
 * Every status-sync story write: conditioned on the state the caller read
 * (a null matches IS NULL). Returns the row count — 0 means someone else
 * wrote the story first.
 */
async function compareAndSetStory(
	projectId: string,
	story: StatusSyncStoryRow,
	data: {
		statusId?: string;
		order?: number;
		pmStatusSyncBaseId: string;
		pmStatusSyncBaseAt: Date | null;
		pmStatusSyncBaseLink: string;
		pmStatusSyncBaseFabricId: string;
		lastEditedAt?: Date;
		lastEditedSource?: "PM_PULL";
		lastEditedByName?: null;
	},
): Promise<number> {
	const { count } = await db.userStory.updateMany({
		where: {
			id: story.id,
			projectId,
			statusId: story.statusId,
			pmStatusSyncBaseId: story.pmStatusSyncBaseId,
			pmStatusSyncBaseAt: story.pmStatusSyncBaseAt,
			pmStatusSyncBaseLink: story.pmStatusSyncBaseLink,
			pmStatusSyncBaseFabricId: story.pmStatusSyncBaseFabricId,
		},
		data,
	});
	return count;
}

function raced(
	projectId: string,
	story: StatusSyncStoryRow,
	wanted: StatusSyncOutcome,
): { outcome: StatusSyncOutcome } {
	logger.debug(
		"[PM Poll] Status sync lost a race with a concurrent story write; the next poll decides again",
		{ projectId, storyId: story.id, wanted },
	);
	return { outcome: "raced" };
}

/** `PmSyncLog` XOR tenant: org rows carry no user; personal rows carry the owner. */
function syncLogTenant(input: StatusSyncLeafInput): {
	organizationId: string | null;
	userId: string | null;
} {
	return {
		organizationId: input.tenant.organizationId,
		userId: input.tenant.organizationId ? null : input.tenant.ownerUserId,
	};
}

/** `PmSyncLog.pmTool` slug — the same mapping as `pm-state-poll.ts`'s `pmToolSlug`, which this leaf may not import. */
function pmSyncLogToolSlug(pmToolKey: string | null): string {
	return pmToolKey === "gitlab-official"
		? "gitlab"
		: (pmToolKey ?? "unknown");
}

interface StatusSyncConflict {
	/** Stable per distinct observation; see `hasPmSyncConflictWithDedupeKey`. */
	dedupeKey: string;
	/** `reason`, the remediation text in `errorMessage` (what Sync History shows), and context. */
	payload: Record<string, string | string[] | null>;
}

/** Row 3 — one row per (story, observed link). */
function unverifiedConflict(input: StatusSyncLeafInput): StatusSyncConflict {
	const { item, story, source } = input;
	const observed = source.isRest
		? `url=${item.itemUrl ?? ""}`
		: `server=${story.externalMcpServerId ?? ""};url=${story.externalUrl ?? ""}`;
	const tool = source.pmToolLabel;
	return {
		dedupeKey: `status-sync:unverified:${story.id}:${observed}`,
		payload: {
			reason: "status-sync-unverified-link",
			errorMessage: source.isRest
				? `Status sync did not use ${tool} issue ${item.externalId} for this story: the issue's URL does not match the story's link. Pull the story to refresh its link, or relink it.`
				: `Status sync did not use ${tool} item ${item.externalId} for this story: Fabric cannot confirm the story is linked to the connected ${tool} workspace. Push the story to ${tool} once to record its link, or relink it.`,
			observedItemUrl: item.itemUrl ?? null,
			storyExternalUrl: story.externalUrl,
			storyExternalMcpServerId: story.externalMcpServerId,
			activeServerId: source.activeServerId,
		},
	};
}

/** Row 7 — one row per (story, conflicting label set, ticket changed-date). */
function ambiguousConflict(
	input: StatusSyncLeafInput,
	resolved: { statusIds: string[]; labels: string[] },
): StatusSyncConflict {
	const labels = [...new Set(resolved.labels)].sort();
	const changed = input.item.stateChangedDate?.toISOString() ?? "unknown";
	const tool = input.source.pmToolLabel;
	return {
		dedupeKey: `status-sync:ambiguous:${input.story.id}:${labels.join("|")}:${changed}`,
		payload: {
			reason: "ambiguous-status-labels",
			errorMessage: `Status sync left this story unchanged: its ${tool} labels ${labels.join(", ")} map to different Fabric statuses. Keep one of them in ${tool}, or edit the label map.`,
			labels,
			statusIds: [...resolved.statusIds],
		},
	};
}

/**
 * Write one CONFLICT pull row unless this exact observation already has one.
 * Non-fatal: a failed dedupe lookup skips the row (a duplicate would feed the
 * owners' alert digest) and `recordPmSyncLog` never throws.
 */
async function recordStatusSyncConflict(
	input: StatusSyncLeafInput,
	conflict: StatusSyncConflict,
): Promise<void> {
	const { projectId, item, story, source } = input;
	try {
		const seen = await hasPmSyncConflictWithDedupeKey({
			projectId,
			entityId: story.id,
			dedupeKey: conflict.dedupeKey,
		});
		if (seen) {
			return;
		}
	} catch (error) {
		logger.warn(
			"[PM Poll] Status-sync CONFLICT dedupe lookup failed; row not written",
			{
				projectId,
				storyId: story.id,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return;
	}
	await recordPmSyncLog({
		...syncLogTenant(input),
		projectId,
		direction: "pull",
		entityType: "STORY",
		entityId: story.id,
		title: story.title,
		pmTool: pmSyncLogToolSlug(source.pmToolKey),
		status: "CONFLICT",
		actorUserId: null,
		externalId: item.externalId,
		externalUrl: item.itemUrl ?? story.externalUrl,
		errorPayload: {
			source: "pm-status-sync",
			dedupeKey: conflict.dedupeKey,
			...conflict.payload,
		},
	});
}
