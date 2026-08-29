import { ORPCError } from "@orpc/server";
import type { NewsletterChatChannel } from "@repo/database";
import {
	coerceDeliveryDestination,
	coerceDetailLevel,
	createOrGetNewsletterSend,
	DEFAULT_NEWSLETTER_DETAIL_LEVEL,
	db,
	finalizeNewsletterSend,
	findRecentNonFailedSend,
	getNewsletterSettings,
	manualDedupeKey,
	NEWSLETTER_DETAIL_LEVELS,
	resolveWindow,
	setNewsletterSendWorkflowId,
} from "@repo/database";
import {
	type GenerateAndSendNewsletterInput,
	getTemporalClient,
	isTemporalAvailable,
} from "@repo/temporal";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const RATE_LIMIT_MS = 5 * 60 * 1000;
// First-send fallback when lookbackDays is unset. Manual "Send now" is a flat
// 7 days regardless of cadence (matches the historical behavior), distinct from
// the scheduled path which falls back to cadenceDefaultLookbackDays (7/30).
const MANUAL_FALLBACK_LOOKBACK_DAYS = 7;

export const sendNowInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
	// Per-send override of the persisted settings.detailLevel. Invalid values
	// COERCE to default (never a validation error) per AC-6: .catch fires on an
	// out-of-range value; .optional keeps "omitted = use the settings value".
	detailLevel: z
		.enum(NEWSLETTER_DETAIL_LEVELS)
		.catch(DEFAULT_NEWSLETTER_DETAIL_LEVEL)
		.optional(),
});

export const sendNowProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(sendNowInput)
	.handler(async ({ input, context }) => {
		// `requireProjectPermission` above has already authorized this caller for
		// THIS project — as owner, active ProjectMember, or via an org role. Load
		// the project by id and take the tenant from the loaded row;
		// `input.organizationId` is a guard, never a scoping key.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				id: true,
				name: true,
				organizationId: true,
				userId: true,
			},
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		assertInputOrgMatchesProject(input.organizationId, project);

		const recent = await findRecentNonFailedSend(
			input.projectId,
			RATE_LIMIT_MS,
		);
		if (recent) {
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message:
					"A newsletter for this project was sent within the last 5 minutes. Try again shortly.",
			});
		}
		if (!(await isTemporalAvailable())) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Temporal is not available",
			});
		}

		const settings = await getNewsletterSettings(input.projectId);
		const effectiveDetailLevel = coerceDetailLevel(
			input.detailLevel ?? settings.detailLevel,
		);
		// No per-send override for destination in v1 — always the persisted setting.
		const effectiveDeliveryDestination = coerceDeliveryDestination(
			settings.deliveryDestination,
		);
		const now = new Date();
		const { start, end } = resolveWindow(
			{
				lookbackDays: settings.lookbackDays,
				lastSentAt: settings.lastSentAt,
			},
			now,
			MANUAL_FALLBACK_LOOKBACK_DAYS,
		);
		const dedupeKey = manualDedupeKey(input.projectId, end);

		const { send, created } = await createOrGetNewsletterSend({
			projectId: input.projectId,
			organizationId: project.organizationId ?? null,
			userId: project.organizationId ? null : project.userId,
			dedupeKey,
			trigger: "MANUAL",
			timeWindowStart: start,
			timeWindowEnd: end,
			triggeredByUserId: context.user.id,
			detailLevel: effectiveDetailLevel,
			deliveryDestination: effectiveDeliveryDestination,
			requireApproval: settings.requireApproval,
			chatChannels: (settings.chatChannels ??
				[]) as NewsletterChatChannel[],
		});
		if (!created) {
			return {
				sendId: send.id,
				workflowId: send.temporalWorkflowId ?? null,
				inFlight: true,
			};
		}

		const args: GenerateAndSendNewsletterInput = {
			sendId: send.id,
			projectId: input.projectId,
			organizationId: project.organizationId ?? null,
			userId: project.organizationId ? null : project.userId,
			triggeredByUserId: context.user.id,
			projectName: project.name,
			trigger: "MANUAL",
			detailLevel: coerceDetailLevel(send.detailLevel),
			deliveryDestination: coerceDeliveryDestination(
				send.deliveryDestination,
			),
			chatChannels: (send.chatChannels ?? []) as NewsletterChatChannel[],
			requireApproval: send.requireApproval,
			timeWindowStart: start.toISOString(),
			timeWindowEnd: end.toISOString(),
		};
		// Start and persist are SEPARATE concerns. FAILED is marked ONLY when
		// `workflow.start` itself throws (no workflow exists, so the PENDING row
		// must be released — mirrors regenerate.ts:229-241). A persist failure
		// AFTER a successful start must NOT mark FAILED: the workflow is alive and
		// will finalize the row itself; rolling it back would race the live run.
		let handle: Awaited<
			ReturnType<
				Awaited<
					ReturnType<typeof getTemporalClient>
				>["workflow"]["start"]
			>
		>;
		try {
			const client = await getTemporalClient();
			handle = await client.workflow.start(
				"generateAndSendNewsletterWorkflow",
				withCorrelationMemo({
					taskQueue: "fabric-worker",
					workflowId: `newsletter-send-${send.id}`,
					args: [args],
					workflowExecutionTimeout: "15m",
				}),
			);
		} catch (error) {
			await finalizeNewsletterSend({
				sendId: send.id,
				status: "FAILED",
				errorMessage:
					error instanceof Error ? error.message : String(error),
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to start newsletter workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}

		try {
			await setNewsletterSendWorkflowId(send.id, handle.workflowId);
		} catch {
			// Workflow is running; the row will finalize itself — do NOT mark FAILED.
		}

		return {
			sendId: send.id,
			workflowId: handle.workflowId,
			inFlight: false,
		};
	});
