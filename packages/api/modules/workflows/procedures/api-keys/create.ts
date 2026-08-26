/**
 * Create Workflow API Key
 *
 * The webhook trigger route has verified bearer tokens against
 * `WorkflowApiKey` since it shipped, but nothing ever created a row — so that
 * authentication path was unreachable and the only way to trigger a published
 * workflow externally was the HMAC signature.
 *
 * The raw key is returned exactly once. Only its sha256 and an identifying
 * prefix are stored, so a leaked database cannot be used to call the webhook.
 */

import { createHash, randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { db, getWorkflowById, hasWorkflowAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

/** What a key is allowed to do. `trigger` is what the webhook route checks. */
const WORKFLOW_API_KEY_PERMISSIONS = ["trigger", "read"] as const;

/**
 * Least-privilege default. Defined here rather than relying solely on the zod
 * default so the handler is correct even if it is ever called with a
 * pre-parsed input — a permission set is not something to leave to schema
 * defaulting alone.
 */
const DEFAULT_PERMISSIONS: string[] = ["trigger"];

/**
 * Format: `wfk_<prefix>_<secret>`.
 *
 * MUST stay in step with the parser in
 * `apps/web/app/api/workflows/trigger/[workflowId]/route.ts`, which splits on
 * "_" and rebuilds the prefix as `wfk_${parts[1]}` to look the row up.
 */
function generateWorkflowApiKey(): {
	rawKey: string;
	keyHash: string;
	keyPrefix: string;
} {
	const secret = randomBytes(24).toString("base64url");
	const prefix = randomBytes(4).toString("hex");

	const rawKey = `wfk_${prefix}_${secret}`;
	const keyPrefix = `wfk_${prefix}`;
	const keyHash = createHash("sha256").update(rawKey).digest("hex");

	return { rawKey, keyHash, keyPrefix };
}

export const createWorkflowApiKeyProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/workflows/{workflowId}/api-keys",
		tags: ["Workflows", "API Keys"],
		summary: "Create a workflow API key",
		description:
			"Generate a key for triggering this workflow's webhook. The raw key is returned once and cannot be retrieved later.",
	})
	.input(
		z.object({
			workflowId: z.string(),
			organizationId: z.string().nullable().optional(),
			name: z
				.string()
				.min(1, "Name is required")
				.max(100, "Name too long"),
			permissions: z
				.array(z.enum(WORKFLOW_API_KEY_PERMISSIONS))
				.default(["trigger"]),
			expiresInDays: z.number().int().min(1).max(365).optional(),
		}),
	)
	.output(
		z.object({
			id: z.string(),
			name: z.string(),
			keyPrefix: z.string(),
			/** Returned once, never again. */
			rawKey: z.string(),
			permissions: z.array(z.string()),
			expiresAt: z.date().nullable(),
			createdAt: z.date(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		const hasAccess = await hasWorkflowAccess(
			input.workflowId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("NOT_FOUND", { message: "Workflow not found" });
		}

		const workflow = await getWorkflowById(
			input.workflowId,
			user.id,
			organizationId,
		);
		if (!workflow) {
			throw new ORPCError("NOT_FOUND", { message: "Workflow not found" });
		}

		const { rawKey, keyHash, keyPrefix } = generateWorkflowApiKey();

		const expiresAt = input.expiresInDays
			? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
			: null;

		const apiKey = await db.workflowApiKey.create({
			data: {
				workflowId: input.workflowId,
				name: input.name,
				keyHash,
				keyPrefix,
				permissions: [...(input.permissions ?? DEFAULT_PERMISSIONS)],
				expiresAt,
				createdBy: user.id,
				// The verifier compares these against the parent workflow, so
				// they must be copied from it rather than from the caller.
				userId: workflow.userId,
				organizationId: workflow.organizationId,
			},
		});

		return {
			id: apiKey.id,
			name: apiKey.name,
			keyPrefix: apiKey.keyPrefix,
			rawKey,
			permissions: apiKey.permissions,
			expiresAt: apiKey.expiresAt,
			createdAt: apiKey.createdAt,
		};
	});
