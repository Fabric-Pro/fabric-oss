import { randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/client";
import {
	createProjectQaWebhookConfiguration,
	getProjectQaWebhookConfiguration,
	revokeProjectQaWebhook,
	rotateProjectQaWebhookSecret,
	updateProjectQaWebhookExpiry,
} from "@repo/database";
import { encryptApiKey } from "@repo/utils";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

function generateWebhookSecret(): string {
	return randomBytes(32).toString("base64url");
}

function parseExpiry(value: string | null | undefined): Date | null {
	if (!value) {
		return null;
	}
	const expiresAt = new Date(value);
	if (expiresAt.getTime() <= Date.now()) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Webhook expiry must be in the future.",
		});
	}
	return expiresAt;
}

function toSummary(
	row: NonNullable<
		Awaited<ReturnType<typeof getProjectQaWebhookConfiguration>>
	>,
) {
	const now = Date.now();
	return {
		configured: true as const,
		endpointPath: `/api/webhooks/qa/${row.projectId}`,
		secretHint: row.secretHint,
		expiresAt: row.expiresAt,
		expired: row.expiresAt !== null && row.expiresAt.getTime() <= now,
		previousSecretRetiresAt:
			row.previousSecretRetiresAt &&
			row.previousSecretRetiresAt.getTime() > now
				? row.previousSecretRetiresAt
				: null,
		lastDeliveryAt: row.lastDeliveryAt,
		deliveryCount: row.deliveryCount,
		lastError: row.lastError,
		lastErrorAt: row.lastErrorAt,
		updatedAt: row.updatedAt,
	};
}

const projectInput = z.object({ projectId: z.string() });
const expirySchema = z.string().datetime().nullable().optional();

export const getProjectQaWebhookProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/qa-webhook",
		tags: ["Projects"],
		summary: "Get inbound QA webhook configuration",
	})
	.input(projectInput)
	.handler(async ({ input }) => {
		const row = await getProjectQaWebhookConfiguration(input.projectId);
		return row
			? toSummary(row)
			: {
					configured: false as const,
					endpointPath: `/api/webhooks/qa/${input.projectId}`,
				};
	});

export const createProjectQaWebhookProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/{projectId}/qa-webhook",
		tags: ["Projects"],
		summary: "Create an inbound QA webhook secret",
	})
	.input(projectInput.extend({ expiresAt: expirySchema }))
	.handler(async ({ input, context }) => {
		if (await getProjectQaWebhookConfiguration(input.projectId)) {
			throw new ORPCError("CONFLICT", {
				message: "This project already has a QA webhook.",
			});
		}
		const secret = generateWebhookSecret();
		const row = await createProjectQaWebhookConfiguration({
			projectId: input.projectId,
			encryptedSecret: encryptApiKey(secret),
			secretHint: secret.slice(-4),
			expiresAt: parseExpiry(input.expiresAt),
		});
		recordAuditFromRequest(context, {
			action: "project.qa_webhook.created",
			category: "project",
			severity: "info",
			outcome: "success",
			projectId: input.projectId,
			resource: { type: "project_qa_webhook", id: row.id },
			metadata: { expiresAt: row.expiresAt?.toISOString() ?? null },
		});
		return { ...toSummary(row), secret };
	});

export const rotateProjectQaWebhookProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/{projectId}/qa-webhook/rotate",
		tags: ["Projects"],
		summary: "Rotate an inbound QA webhook secret",
	})
	.input(
		projectInput.extend({
			overlapMinutes: z.number().int().min(5).max(1440).default(60),
		}),
	)
	.handler(async ({ input, context }) => {
		const secret = generateWebhookSecret();
		const retiresAt = new Date(
			Date.now() + input.overlapMinutes * 60 * 1000,
		);
		const rotation = await rotateProjectQaWebhookSecret({
			projectId: input.projectId,
			encryptedSecret: encryptApiKey(secret),
			secretHint: secret.slice(-4),
			previousSecretRetiresAt: retiresAt,
		});
		if (rotation.status === "missing") {
			throw new ORPCError("NOT_FOUND", {
				message: "Create the QA webhook before rotating it.",
			});
		}
		if (rotation.status === "overlap_active_or_conflict") {
			throw new ORPCError("CONFLICT", {
				message:
					"Wait for the current secret-overlap window to end before rotating again.",
			});
		}
		const row = rotation.row;
		recordAuditFromRequest(context, {
			action: "project.qa_webhook.rotated",
			category: "project",
			severity: "info",
			outcome: "success",
			projectId: input.projectId,
			resource: { type: "project_qa_webhook", id: row.id },
			metadata: { previousSecretRetiresAt: retiresAt.toISOString() },
		});
		return { ...toSummary(row), secret };
	});

export const updateProjectQaWebhookExpiryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "PUT",
		path: "/projects/{projectId}/qa-webhook/expiry",
		tags: ["Projects"],
		summary: "Update an inbound QA webhook expiry",
	})
	.input(projectInput.extend({ expiresAt: expirySchema }))
	.handler(async ({ input, context }) => {
		const expiresAt = parseExpiry(input.expiresAt);
		if (
			!(await updateProjectQaWebhookExpiry({
				projectId: input.projectId,
				expiresAt,
			}))
		) {
			throw new ORPCError("NOT_FOUND", {
				message: "QA webhook not found.",
			});
		}
		recordAuditFromRequest(context, {
			action: "project.qa_webhook.expiry_updated",
			category: "project",
			severity: "info",
			outcome: "success",
			projectId: input.projectId,
			resource: {
				type: "project_qa_webhook",
				id: input.projectId,
			},
			metadata: { expiresAt: expiresAt?.toISOString() ?? null },
		});
		const row = await getProjectQaWebhookConfiguration(input.projectId);
		if (!row) {
			throw new ORPCError("NOT_FOUND");
		}
		return toSummary(row);
	});

export const revokeProjectQaWebhookProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/qa-webhook",
		tags: ["Projects"],
		summary: "Revoke an inbound QA webhook",
	})
	.input(projectInput)
	.handler(async ({ input, context }) => {
		const revoked = await revokeProjectQaWebhook(input.projectId);
		if (revoked) {
			recordAuditFromRequest(context, {
				action: "project.qa_webhook.revoked",
				category: "project",
				severity: "warning",
				outcome: "success",
				projectId: input.projectId,
				resource: {
					type: "project_qa_webhook",
					id: input.projectId,
				},
			});
		}
		return { revoked };
	});
