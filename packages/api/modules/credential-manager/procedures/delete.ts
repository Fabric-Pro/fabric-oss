import { ORPCError } from "@orpc/server";
import {
	canManageCredential,
	db,
	deleteCredential,
	getCredentialMetadata,
	recordAuditTx,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	credentialAuditMetadata,
	resolveCredentialActor,
} from "../lib/context";

/**
 * Delete a credential the caller manages. No consumer references credentials
 * yet (phase 1); when they do, their foreign keys restrict the delete and
 * this procedure will list the dependents instead.
 */
export const deleteCredentialProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_INTEGRATIONS_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "DELETE",
		path: "/organizations/{organizationId}/credentials/{id}",
		tags: ["Credentials"],
		summary: "Delete a credential",
	})
	.input(z.object({ organizationId: z.string(), id: z.string() }))
	.output(z.object({ success: z.literal(true) }))
	.handler(async ({ context, input }) => {
		const actor = await resolveCredentialActor(
			input.organizationId,
			context.user.id,
		);
		const existing = await getCredentialMetadata({
			id: input.id,
			organizationId: input.organizationId,
		});
		if (!existing || !canManageCredential(existing, actor)) {
			throw new ORPCError("NOT_FOUND", {
				message: "Credential not found",
			});
		}

		await db.$transaction(async (tx) => {
			const deleted = await deleteCredential(
				{ id: existing.id, organizationId: input.organizationId },
				tx,
			);
			if (!deleted) {
				throw new ORPCError("NOT_FOUND", {
					message: "Credential not found",
				});
			}
			await recordAuditTx(tx, {
				action:
					existing.userId === null
						? "org.credential.deleted"
						: "account.credential.deleted",
				actor: {
					type: "user",
					userId: context.user.id,
					emailSnapshot: context.user.email,
					nameSnapshot: context.user.name,
				},
				organizationId: input.organizationId,
				resource: {
					type: "credential",
					id: existing.id,
					name: existing.label,
				},
				metadata: credentialAuditMetadata(existing),
			});
		});

		return { success: true as const };
	});
