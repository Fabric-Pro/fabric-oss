import { ORPCError } from "@orpc/client";
import {
	applyAdoContentToFabricItem,
	createPmSyncLog,
	db,
	getPmSyncItemTitle,
	hasProjectAccess,
	stampPmSyncBaseline,
	writePmSyncItemContent,
} from "@repo/database";
import { logger } from "@repo/logs";
import { computePmHash, getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { enqueuePmSync } from "../lib/enqueue-pm-sync";

/** Chunk C is ADO-only; the resolution log mirrors the poll's first-detection row. */
const PM_TOOL = "azure-devops";

/** Maps the row's `EPIC | FEATURE | STORY` to the helper item-type lowercase form. */
type ResolveContentDriftItemType = "epic" | "feature" | "story";

function resolveItemType(entityType: string): ResolveContentDriftItemType {
	switch (entityType) {
		case "EPIC":
			return "epic";
		case "FEATURE":
			return "feature";
		case "STORY":
			return "story";
		default:
			throw new ORPCError("BAD_REQUEST", {
				message: `Unsupported entity type for content drift: ${entityType}`,
			});
	}
}

/** Spec §6.4 — `errorPayload.outcome` lowercase-hyphen values (audit), distinct from the input enum. */
const OUTCOME_LOG_VALUE = {
	APPLY_ADO: "apply",
	KEEP_FABRIC: "keep-fabric",
	AI_MERGE: "ai-merge",
	DISMISS: "dismiss",
} as const;

const ResolveContentDriftInput = z
	.object({
		projectId: z.string(),
		id: z.string(),
		organizationId: z.string().nullable().optional(),
		outcome: z.enum(["APPLY_ADO", "KEEP_FABRIC", "AI_MERGE", "DISMISS"]),
		overrideTitle: z.string().max(2_000).optional(),
		overrideDescription: z.string().max(50_000).optional(),
	})
	.refine(
		(v) =>
			v.outcome !== "AI_MERGE" ||
			(typeof v.overrideDescription === "string" &&
				v.overrideDescription.trim().length > 0),
		{
			message: "overrideDescription is required for AI_MERGE",
			path: ["overrideDescription"],
		},
	);

interface AdoLiveContent {
	title: string;
	description: string;
	externalUrl: string | null;
}

/**
 * Re-fetch the CURRENT ADO title/description for a single linked item — the
 * authoritative content at resolve time (Q4: the row stores only the hash, no
 * text). Reuses the same `pmSyncPreviewConflictsWorkflow` path the conflict
 * preview procedure (`checkPmSyncConflictsProcedure`) uses, called at the
 * activity level inline — never by invoking the sibling oRPC procedure.
 *
 * Returns `null` when the ADO side is unreachable / the item is unlinked /
 * the preview reports no live content, so the caller can raise a typed error
 * rather than ingest a stale snapshot.
 */
async function fetchLiveAdoContent(args: {
	projectId: string;
	itemId: string;
	itemType: ResolveContentDriftItemType;
	userId: string;
	organizationId: string | null;
}): Promise<AdoLiveContent | null> {
	const project = await db.project.findUnique({
		where: { id: args.projectId },
		select: {
			id: true,
			organizationId: true,
			projectManagementMcpConfigId: true,
			projectManagementContainerId: true,
			projectManagementContainerName: true,
			projectManagementAdditionalContext: true,
		},
	});

	if (
		!project ||
		!project.projectManagementMcpConfigId ||
		!project.projectManagementContainerId
	) {
		return null;
	}

	const additionalContext =
		(project.projectManagementAdditionalContext as Record<
			string,
			string
		> | null) ?? undefined;

	const client = await getTemporalClient();
	const workflowId = `pm-sync-preview-${args.projectId}-${Date.now()}`;

	const handle = await client.workflow.start(
		"pmSyncPreviewConflictsWorkflow",
		withCorrelationMemo({
			taskQueue: "ai-chat",
			workflowId,
			args: [
				{
					items: [{ id: args.itemId, itemType: args.itemType }],
					projectId: args.projectId,
					mcpConfigId: project.projectManagementMcpConfigId,
					containerId: project.projectManagementContainerId,
					containerName:
						project.projectManagementContainerName ?? undefined,
					additionalContext,
					userId: args.userId,
					organizationId:
						args.organizationId ??
						project.organizationId ??
						undefined,
				},
			],
		}),
	);

	const output = (await handle.result()) as {
		results: Array<{
			id: string;
			itemType: string;
			hasConflict: boolean;
			pmCurrent?: {
				title: string;
				description: string;
				lastChangedBy: string | null;
				lastChangedAt: string | null;
			};
			pmUrl?: string;
		}>;
	};

	const found = output.results.find(
		(r) => r.id === args.itemId && r.itemType === args.itemType,
	);
	if (!found?.pmCurrent) {
		return null;
	}

	return {
		title: found.pmCurrent.title,
		description: found.pmCurrent.description,
		externalUrl: found.pmUrl ?? null,
	};
}

/**
 * Resolve a pull-side content-drift review item (`PendingPmStateChange` with
 * `proposedAction = CONTENT_DRIFT`) — the net-new ADO→Fabric ingest path
 * for it. Distinct from `resolveConflict`, which rejects non-CONFLICT
 * items and never ingests ADO content.
 *
 * Four outcomes, each re-stamping the baseline so the next poll stops flagging
 * the same drift (the §10 invariant):
 *  - APPLY_ADO  — re-fetch live ADO content, overwrite Fabric title+description,
 *                 re-stamp baseline to the live ADO hash. No PM push. → APPROVED.
 *  - KEEP_FABRIC — force-push Fabric → ADO (`forceHashOverride`), which re-stamps
 *                 the baseline via the push pipeline. Fabric unchanged. → APPROVED.
 *  - AI_MERGE   — write the accepted merged title/description to Fabric, then
 *                 force-push (carries the merge); baseline re-stamped by the push. → APPROVED.
 *  - DISMISS    — no Fabric change, no push; re-stamp baseline to the row's
 *                 detected ADO hash so the divergence stops re-flagging. → DISMISSED.
 *
 * Never touches `lastPmSyncStatus` (Q7 — push-time CONFLICT and pull-drift stay
 * in distinct surfaces). Records one resolution `PmSyncLog` row carrying the
 * chosen outcome (§3 option c — the outcome lives on the audit log, not a new
 * status value).
 */
export const resolveContentDriftProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/pending-state-changes/{id}/resolve-content-drift",
		tags: ["Projects", "PM Sync"],
		summary: "Resolve a pull-side content-drift review item",
		description:
			"Resolve a CONTENT_DRIFT PendingPmStateChange (Apply ADO→Fabric / Keep Fabric / AI-merge / Dismiss). Net-new ADO→Fabric ingest; never reuses the push-time conflict lifecycle.",
	})
	.input(ResolveContentDriftInput)
	.handler(async ({ input, context }) => {
		const user = context.user;
		// Normalize to `string | null` so the tenant-XOR shape and the
		// `@repo/database` helpers (which take `string | null`) line up; the
		// resolver returns `string | undefined`.
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId ?? undefined,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const change = await db.pendingPmStateChange.findUnique({
			where: { id: input.id },
		});

		if (!change) {
			throw new ORPCError("NOT_FOUND", {
				message: "Pending state change not found",
			});
		}

		if (change.projectId !== input.projectId) {
			throw new ORPCError("FORBIDDEN", {
				message: "State change does not belong to this project",
			});
		}

		if (change.proposedAction !== "CONTENT_DRIFT") {
			throw new ORPCError("BAD_REQUEST", {
				message: "This review item is not a content-drift change",
			});
		}

		if (change.status !== "PENDING") {
			throw new ORPCError("CONFLICT", {
				message: "Content drift has already been resolved",
			});
		}

		// Belt-and-suspenders to the Zod refine — the FE dispatch must carry the
		// accepted merged text; reject a misbehaving client loudly.
		if (
			input.outcome === "AI_MERGE" &&
			(!input.overrideDescription ||
				input.overrideDescription.trim().length === 0)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"A merged description is required to accept an AI merge",
			});
		}

		const itemType = resolveItemType(change.entityType);

		// The hash the baseline ends up at — used both to re-stamp and to verify
		// the §10 invariant. Set per branch below.
		let resolvedContentHash = change.detectedPmHash ?? "";
		let externalUrl: string | null = null;
		// Entity title snapshot for the resolution log. APPLY_ADO overrides this
		// with the freshly-applied ADO title; the other branches keep the current
		// Fabric title (the row itself stores no title — Q4).
		let logTitle: string | null = null;

		if (input.outcome === "APPLY_ADO") {
			// Net-new ingest — authoritative content comes from a SERVER-SIDE
			// re-fetch of the live ADO item, never a client-passed value (Q4).
			const live = await fetchLiveAdoContent({
				projectId: input.projectId,
				itemId: change.entityId,
				itemType,
				userId: user.id,
				organizationId,
			});

			if (!live) {
				throw new ORPCError("CONFLICT", {
					message:
						"Could not read the current PM tool content — refresh and re-review.",
				});
			}

			resolvedContentHash = computePmHash(live.title, live.description);
			externalUrl = live.externalUrl;
			logTitle = live.title;

			await applyAdoContentToFabricItem({
				itemType,
				itemId: change.entityId,
				projectId: input.projectId,
				title: live.title,
				description: live.description,
				newContentHash: resolvedContentHash,
				userId: user.id,
				organizationId,
				lastEditedByName: user.name ?? null,
			});
		} else if (input.outcome === "KEEP_FABRIC") {
			// Force-push Fabric → ADO; the push pipeline re-stamps the baseline
			// (`stampPmSyncSuccess`). Do NOT clear a conflict flag — the item is
			// not in CONFLICT (Q7). Fire-and-forget; do not await push completion.
			await enqueuePmSync({
				itemId: change.entityId,
				itemType,
				projectId: input.projectId,
				userId: user.id,
				forceHashOverride: true,
				triggerSource: "retry",
			});
		} else if (input.outcome === "AI_MERGE") {
			// Write the accepted merged title/description to Fabric, then
			// force-push so the merge flows to ADO.
			await writePmSyncItemContent({
				itemType,
				itemId: change.entityId,
				projectId: input.projectId,
				title: input.overrideTitle,
				description: input.overrideDescription as string,
				lastEditedSource: "CONFLICT_RESOLUTION",
				lastEditedByName: user.name ?? null,
			});
			await enqueuePmSync({
				itemId: change.entityId,
				itemType,
				projectId: input.projectId,
				userId: user.id,
				forceHashOverride: true,
				triggerSource: "retry",
			});
		} else {
			// DISMISS — accept the divergence without mutating either side; re-stamp
			// the baseline to the detected ADO hash so the next poll stops flagging.
			if (!change.detectedPmHash) {
				throw new ORPCError("CONFLICT", {
					message:
						"Content-drift row is missing its detected hash — refresh and re-review.",
				});
			}
			await stampPmSyncBaseline({
				itemType,
				itemId: change.entityId,
				projectId: input.projectId,
				newContentHash: change.detectedPmHash,
			});
		}

		const updated = await db.pendingPmStateChange.update({
			where: { id: input.id },
			data: {
				status: input.outcome === "DISMISS" ? "DISMISSED" : "APPROVED",
				reviewedAt: new Date(),
				reviewedBy: user.id,
			},
		});

		// Resolution half of the audit pair (§3 / §6.4). Non-fatal: a log-write
		// failure must NOT roll back the resolution the user just performed.
		if (logTitle == null) {
			logTitle = await getPmSyncItemTitle({
				itemType,
				itemId: change.entityId,
				projectId: input.projectId,
			});
		}
		try {
			await createPmSyncLog({
				direction: "pull",
				entityType: change.entityType as "EPIC" | "FEATURE" | "STORY",
				entityId: change.entityId,
				title: logTitle ?? "",
				pmTool: PM_TOOL,
				status: "SUCCESS",
				errorPayload: {
					reason: "ado-content-drift",
					outcome: OUTCOME_LOG_VALUE[input.outcome],
				},
				actorUserId: user.id,
				externalId: change.externalId,
				externalUrl,
				...(organizationId
					? { organizationId, userId: null }
					: { organizationId: null, userId: user.id }),
				projectId: input.projectId,
			});
		} catch (error) {
			logger.warn("pm.sync.content_drift.resolution_log_failed", {
				entityType: change.entityType,
				entityId: change.entityId,
				outcome: input.outcome,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		return { change: updated, resolvedContentHash };
	});
