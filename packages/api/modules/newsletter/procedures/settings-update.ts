import { ORPCError } from "@orpc/server";
import {
	DEFAULT_NEWSLETTER_DELIVERY_DESTINATION,
	DEFAULT_NEWSLETTER_DETAIL_LEVEL,
	db,
	enrollProjectMembersAsSubscribers,
	getLinkedSlackChannels,
	getLinkedTeamsChannels,
	getNewsletterSettings,
	NEWSLETTER_CHAT_PLATFORMS,
	NEWSLETTER_DELIVERY_DESTINATIONS,
	NEWSLETTER_DETAIL_LEVELS,
	recordAuditTx,
	setPublicWidgetState,
	upsertNewsletterSettings,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { buildWidgetAuditInput } from "../audit";

/**
 * Procedure-side mirror of `newsletterChatChannelSchema` from
 * `@repo/database/src/newsletter-schema`. Defined locally with the api
 * package's own zod version — the cross-package re-export trips Zod's
 * TS-internal `version.minor` mismatch when packages pin different Zod 4.x
 * patches (same pattern as `chat-agent-selection/schema.ts`).
 *
 * MUST stay in lockstep with the database export. Any shape change here MUST
 * be mirrored there (and vice versa). This schema only governs the wire
 * boundary — F3 below re-validates the submitted channels against the
 * project's live linked-channel set before anything is persisted.
 */
const apiNewsletterChatChannelSchema = z.object({
	platform: z.enum(NEWSLETTER_CHAT_PLATFORMS),
	teamId: z.string().min(1),
	channelId: z.string().min(1),
	channelName: z.string().optional(),
});

export const updateNewsletterSettingsInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
	enabled: z.boolean().optional(),
	cadence: z.enum(["WEEKLY", "MONTHLY"]).optional(),
	dayOfWeek: z.number().int().min(0).max(6).optional(),
	dayOfMonth: z.number().int().min(1).max(28).optional(),
	sendHourUtc: z.number().int().min(0).max(23).optional(),
	// Minimum days of history each send covers. null clears it (back to caller
	// default). 1..365 bounds the window.
	lookbackDays: z.number().int().min(1).max(365).nullable().optional(),
	// Invalid values COERCE to default (never a validation error) per AC-6:
	// .catch fires on an out-of-range value; .optional keeps "omitted = unchanged".
	detailLevel: z
		.enum(NEWSLETTER_DETAIL_LEVELS)
		.catch(DEFAULT_NEWSLETTER_DETAIL_LEVEL)
		.optional(),
	// Where release-notes are delivered (email / chat / both). Same
	// coerce-never-throw contract as detailLevel above (F-series delivery
	// destination spec, AC-6 sibling): an invalid value COERCES to EMAIL.
	deliveryDestination: z
		.enum(NEWSLETTER_DELIVERY_DESTINATIONS)
		.catch(DEFAULT_NEWSLETTER_DELIVERY_DESTINATION)
		.optional(),
	// Selected chat delivery targets. Re-validated against the project's LIVE
	// linked-channel set server-side (F3, see handler below) — a channel
	// unlinked since the client last fetched the list is silently dropped
	// rather than persisted or rejected.
	chatChannels: z.array(apiNewsletterChatChannelSchema).max(50).optional(),
	// Review-alert routing targets (Fizzy #2203) — a SEPARATE list from
	// `chatChannels` above, which is the audience for the published notes.
	// Same wire schema, same F3 re-validation, same empty-array-means-off
	// contract.
	approvalChatChannels: z
		.array(apiNewsletterChatChannelSchema)
		.max(50)
		.optional(),
	// Whether a send requires admin approval before delivery. Audited on a real
	// transition (see the handler's `newsletter.approval.required_changed` emit).
	requireApproval: z.boolean().optional(),
	// Per-project embeddable-widget owner controls. The on/off flag drives the
	// embed-token lifecycle (mint on first enable, version bump on disable) and
	// is applied transactionally; the theme fields are pure presentation.
	// `null` on a theme field clears it back to the default; omitted leaves it.
	publicWidgetEnabled: z.boolean().optional(),
	publicWidgetTheme: z.enum(["light", "dark"]).nullable().optional(),
	publicWidgetAccent: z
		.string()
		.regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
		.nullable()
		.optional(),
	publicWidgetConfig: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const updateSettingsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(updateNewsletterSettingsInput)
	.handler(async ({ input, context }) => {
		// `requireProjectPermission` above has already authorized this caller for
		// THIS project — as owner, active ProjectMember, or via an org role. Load
		// the project by id and take the tenant from the loaded row;
		// `input.organizationId` is a guard, never a scoping key.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true, organizationId: true, userId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		assertInputOrgMatchesProject(input.organizationId, project);

		// F3: re-validate BOTH submitted lists — the audience list (chatChannels)
		// and the review-alert list (approvalChatChannels, Fizzy #2203) — against
		// the project's LIVE linked-channel set. The client's list may be stale (a
		// channel was unlinked after the settings form loaded); silently drop
		// anything not currently linked rather than persisting or rejecting the
		// request. Guarded on length so [] still means "off" for either list, and
		// the two lists share ONE fetch of the linked sets rather than querying
		// twice.
		let chatChannels = input.chatChannels;
		let approvalChatChannels = input.approvalChatChannels;
		if (
			(chatChannels && chatChannels.length > 0) ||
			(approvalChatChannels && approvalChatChannels.length > 0)
		) {
			const [teamsLinked, slackLinked] = await Promise.all([
				getLinkedTeamsChannels(project.id),
				getLinkedSlackChannels(project.id),
			]);
			const teamsKeys = new Set(
				teamsLinked.map((c) => `TEAMS:${c.teamId}:${c.channelId}`),
			);
			const slackKeys = new Set(
				slackLinked.map((c) => `SLACK:${c.slackTeamId}:${c.channelId}`),
			);
			const keepLinked = <
				T extends {
					platform: string;
					teamId: string;
					channelId: string;
				},
			>(
				list: T[] | undefined,
			) =>
				list?.filter((c) =>
					(c.platform === "TEAMS" ? teamsKeys : slackKeys).has(
						`${c.platform}:${c.teamId}:${c.channelId}`,
					),
				);
			chatChannels = keepLinked(chatChannels);
			approvalChatChannels = keepLinked(approvalChatChannels);
		}

		// Read prior state to detect a false->true enable transition. In prod
		// getNewsletterSettings always returns an object (real row or synthetic
		// defaults); the optional chain is a backstop so an unstubbed test mock
		// (or any future null path) can't throw.
		const priorEnabled =
			(await getNewsletterSettings(input.projectId))?.enabled ?? false;

		// Compose the settings upsert + widget enable/disable transition + its
		// audit row in ONE transaction. A public-exposure change (the widget
		// flag) and its audit trail must commit or roll back together:
		//   - `setPublicWidgetState` REQUIRES a tx client (it takes the row's
		//     FOR UPDATE lock; it throws if handed the base db).
		//   - the audit is written via `recordAuditTx` (awaited IN the tx, errors
		//     propagate) — not a fire-and-forget post-commit call — so the
		//     exposure change cannot land without its trail.
		//   - the audit + version bump happen ONLY on a REAL transition
		//     (`changed` from setPublicWidgetState); a no-op same-value update
		//     emits neither.
		const settings = await db.$transaction(async (tx) => {
			// Audit a real requireApproval transition. Read the pre-write value under
			// the SAME tx that persists the change (below), so the compare-and-audit
			// is atomic with the save — mirrors the widget enable/disable audit.
			if (input.requireApproval !== undefined) {
				const current = await tx.newsletterSettings.findUnique({
					where: { projectId: input.projectId },
					select: { requireApproval: true },
				});
				const before = current?.requireApproval ?? false; // default-row = false
				if (before !== input.requireApproval) {
					await recordAuditTx(tx, {
						action: "newsletter.approval.required_changed",
						actor: {
							type: "user",
							userId: context.user.id,
							emailSnapshot: context.user.email ?? null,
							nameSnapshot: context.user.name ?? null,
						},
						organizationId: project.organizationId ?? null,
						projectId: input.projectId,
						resource: {
							type: "newsletter_settings",
							id: input.projectId,
						},
						metadata: { requireApproval: input.requireApproval },
					});
				}
			}

			const s = await upsertNewsletterSettings(
				input.projectId,
				{
					enabled: input.enabled,
					cadence: input.cadence,
					dayOfWeek: input.dayOfWeek,
					dayOfMonth: input.dayOfMonth,
					sendHourUtc: input.sendHourUtc,
					lookbackDays: input.lookbackDays,
					detailLevel: input.detailLevel,
					deliveryDestination: input.deliveryDestination,
					chatChannels,
					approvalChatChannels,
					requireApproval: input.requireApproval,
					publicWidgetTheme: input.publicWidgetTheme,
					publicWidgetAccent: input.publicWidgetAccent,
					publicWidgetConfig: input.publicWidgetConfig,
					userId: project.organizationId ? null : project.userId,
					organizationId: project.organizationId ?? null,
					// Audit attribution: the acting admin, NOT the tenant `userId`
					// (which is null in org context). Stored as createdByUserId on
					// first create and reused as triggeredByUserId for scheduled sends.
					createdByUserId: context.user.id,
				},
				tx,
			);

			if (input.publicWidgetEnabled !== undefined) {
				const { changed } = await setPublicWidgetState(
					input.projectId,
					input.publicWidgetEnabled,
					tx,
				);
				if (changed) {
					await recordAuditTx(
						tx,
						buildWidgetAuditInput(
							context,
							project,
							input.publicWidgetEnabled ? "ENABLED" : "DISABLED",
						),
					);
				}
			}

			return s;
		});

		// Auto-enrol current members on a false->true enable transition. Best-effort:
		// a failure here must never fail the settings save (the next send's reconcile
		// self-heals). Email-level, idempotent (create-if-absent).
		if (input.enabled === true && !priorEnabled) {
			try {
				await enrollProjectMembersAsSubscribers({
					projectId: input.projectId,
					createdByUserId: context.user.id,
				});
			} catch (err) {
				logger.error("newsletter: member backfill on enable failed", {
					projectId: input.projectId,
					error: err,
				});
			}
		}

		return { settings };
	});
