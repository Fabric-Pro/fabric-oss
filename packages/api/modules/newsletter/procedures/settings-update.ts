import { ORPCError } from "@orpc/server";
import {
	DEFAULT_NEWSLETTER_DELIVERY_DESTINATION,
	DEFAULT_NEWSLETTER_DETAIL_LEVEL,
	db,
	enrollProjectMembersAsSubscribers,
	getLinkedSlackChannels,
	getLinkedTeamsChannels,
	getNewsletterSettings,
	getProjectEnvironment,
	lockOrganizationSubscribers,
	NEWSLETTER_CHAT_PLATFORMS,
	NEWSLETTER_DELIVERY_DESTINATIONS,
	NEWSLETTER_DETAIL_LEVELS,
	purgeOrganizationSubscribers,
	recordAuditTx,
	recordOrganizationSyncFailure,
	setPublicWidgetState,
	syncOrganizationSubscribers,
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
	// Whether a reviewer can attach images to a held send's highlights. Audited
	// on a real transition, like requireApproval: approved images are published
	// under public URLs.
	screenshotsEnabled: z.boolean().optional(),
	// The project environment screenshots are captured from; null turns
	// automatic capture off. Choosing one requires
	// `screenshotSampleDataConfirmed: true` in the same request: Fabric signs
	// in there and cannot tell sample data from real data. Audited.
	screenshotEnvironmentId: z.string().min(1).nullable().optional(),
	screenshotSampleDataConfirmed: z.boolean().optional(),
	// Reconcile organization members into the subscriber list before each send.
	// Organization projects only. Audited on a real transition.
	sendToOrganization: z.boolean().optional(),
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

/**
 * A capture environment must be one of this project's environments, must not
 * be production, and must come with the admin's confirmation that it shows
 * sample data only. Clearing it (`null`) needs none of these.
 */
async function assertScreenshotEnvironmentChoice(
	projectId: string,
	input: {
		screenshotEnvironmentId?: string | null;
		screenshotSampleDataConfirmed?: boolean;
	},
): Promise<void> {
	const environmentId = input.screenshotEnvironmentId;
	if (environmentId === undefined || environmentId === null) {
		return;
	}
	if (input.screenshotSampleDataConfirmed !== true) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Confirm that this environment shows sample data only before screenshots are captured from it.",
			data: { code: "sample_data_unconfirmed" },
		});
	}
	const environment = await getProjectEnvironment({
		projectId,
		environmentId,
	});
	if (!environment) {
		throw new ORPCError("BAD_REQUEST", {
			message: "That environment does not belong to this project.",
		});
	}
	if (environment.type === "PRODUCTION") {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Screenshots cannot be captured from a production environment. Choose one that shows sample data only.",
			data: { code: "production_environment" },
		});
	}
}

// Turning the distribution off waits for a running sync, which can take longer
// than Prisma's default five seconds for a large organization.
const ORG_DISTRIBUTION_TRANSACTION_OPTIONS = { timeout: 60_000 };

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
		if (input.sendToOrganization && !project.organizationId) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Only an organization project can send to its organization",
			});
		}
		await assertScreenshotEnvironmentChoice(project.id, {
			screenshotEnvironmentId: input.screenshotEnvironmentId,
			screenshotSampleDataConfirmed: input.screenshotSampleDataConfirmed,
		});

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
		let organizationDistributionTurnedOn = false;
		const settings = await db.$transaction(async (tx) => {
			// A real transition only. Turning it off purges in this transaction, so
			// a failed purge cannot leave the setting off with those people still
			// on the list and receiving mail.
			if (input.sendToOrganization !== undefined) {
				await lockOrganizationSubscribers(tx, input.projectId);
				const current = await tx.newsletterSettings.findUnique({
					where: { projectId: input.projectId },
					select: { sendToOrganization: true },
				});
				const before = current?.sendToOrganization ?? false;
				if (before !== input.sendToOrganization) {
					await recordAuditTx(tx, {
						action: "newsletter.organization_distribution.changed",
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
						metadata: {
							sendToOrganization: input.sendToOrganization,
						},
					});
					if (input.sendToOrganization) {
						organizationDistributionTurnedOn = true;
					} else {
						await purgeOrganizationSubscribers(input.projectId, tx);
					}
				}
			}

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

			if (input.screenshotsEnabled !== undefined) {
				const current = await tx.newsletterSettings.findUnique({
					where: { projectId: input.projectId },
					select: { screenshotsEnabled: true },
				});
				const before = current?.screenshotsEnabled ?? false; // default-row = false
				if (before !== input.screenshotsEnabled) {
					await recordAuditTx(tx, {
						action: "newsletter.screenshots.changed",
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
						metadata: {
							screenshotsEnabled: input.screenshotsEnabled,
						},
					});
				}
			}

			if (input.screenshotEnvironmentId !== undefined) {
				const current = await tx.newsletterSettings.findUnique({
					where: { projectId: input.projectId },
					select: { screenshotEnvironmentId: true },
				});
				const before = current?.screenshotEnvironmentId ?? null;
				if (before !== input.screenshotEnvironmentId) {
					await recordAuditTx(tx, {
						action: "newsletter.screenshots.environment_changed",
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
						metadata: {
							screenshotEnvironmentId:
								input.screenshotEnvironmentId,
							sampleDataConfirmed:
								input.screenshotEnvironmentId !== null,
						},
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
					screenshotsEnabled: input.screenshotsEnabled,
					screenshotEnvironmentId: input.screenshotEnvironmentId,
					screenshotSampleDataConfirmedAt:
						input.screenshotEnvironmentId === undefined
							? undefined
							: input.screenshotEnvironmentId === null
								? null
								: new Date(),
					sendToOrganization: input.sendToOrganization,
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
		}, ORG_DISTRIBUTION_TRANSACTION_OPTIONS);

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

		// Outside the transaction, because this reads a whole organization. Best
		// effort like the backfill above: the next send's sync self-heals, and a
		// failure stays visible on the settings row.
		if (organizationDistributionTurnedOn) {
			try {
				await syncOrganizationSubscribers(input.projectId);
			} catch (err) {
				logger.error("newsletter: organization sync on enable failed", {
					projectId: input.projectId,
					error: err,
				});
				await recordOrganizationSyncFailure(
					input.projectId,
					err instanceof Error ? err.message : String(err),
				).catch(() => undefined);
			}
		}

		return { settings };
	});
