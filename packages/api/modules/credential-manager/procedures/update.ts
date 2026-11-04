import { ORPCError } from "@orpc/server";
import {
	canManageCredential,
	db,
	getCredentialMetadata,
	recordAuditTx,
	updateCredential,
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
	toClientCredential,
} from "../lib/context";
import {
	checkGitHubTokenForSave,
	type GitHubTokenAccountRead,
	isGitHubDotComOrigin,
} from "../lib/github-token-check";
import { clientCredentialSchema } from "../lib/schemas";

const REPLACEABLE_KINDS = new Set(["PAT", "API_KEY", "BASIC"]);

/**
 * Rename, re-share or replace the secret of a credential the caller manages.
 *
 * Sharing changes are audited as `org.credential.shared` / `unshared` because
 * they change what other members can reach; everything else is `updated` on
 * the owner's side. Replacing the secret bumps the generation, so a refresh
 * started before it cannot overwrite it.
 */
export const updateCredentialProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_INTEGRATIONS_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "PATCH",
		path: "/organizations/{organizationId}/credentials/{id}",
		tags: ["Credentials"],
		summary: "Update a credential",
	})
	.input(
		z.object({
			organizationId: z.string(),
			id: z.string(),
			label: z.string().trim().min(1).max(120).optional(),
			shareWithOrganization: z.boolean().optional(),
			secret: z.string().trim().min(1).max(8192).optional(),
			username: z.string().trim().min(1).max(320).optional(),
			scopes: z
				.array(z.string().trim().min(1).max(200))
				.max(100)
				.optional(),
			expiresAt: z.coerce.date().nullable().optional(),
			/** The person confirmed a fine-grained GitHub token's permissions. */
			confirmFineGrainedPermissions: z.boolean().default(false),
		}),
	)
	.output(z.object({ credential: clientCredentialSchema }))
	.handler(async ({ context, input }) => {
		const actor = await resolveCredentialActor(
			input.organizationId,
			context.user.id,
		);
		const existing = await getCredentialMetadata({
			id: input.id,
			organizationId: input.organizationId,
		});
		// Not-found and not-yours look the same: a member must not learn that a
		// private credential with this id exists.
		if (!existing || !canManageCredential(existing, actor)) {
			throw new ORPCError("NOT_FOUND", {
				message: "Credential not found",
			});
		}
		if (
			input.secret !== undefined &&
			!REPLACEABLE_KINDS.has(existing.kind)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Reconnect this credential from its provider instead",
			});
		}
		if (
			existing.kind === "BASIC" &&
			input.secret !== undefined &&
			!input.username
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "A user name is required for this kind",
			});
		}
		if (existing.userId === null && input.shareWithOrganization === false) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Organization credentials are always shared",
			});
		}

		// A replacement GitHub token passes the same check as a new one, and
		// the account it acts as replaces the stored one.
		const checksGitHubToken =
			input.secret !== undefined &&
			existing.provider === "GITHUB" &&
			existing.kind === "PAT" &&
			isGitHubDotComOrigin(existing.origin);
		let account: GitHubTokenAccountRead | null = null;
		if (checksGitHubToken && input.secret !== undefined) {
			account = await checkGitHubTokenForSave({
				token: input.secret,
				confirmFineGrainedPermissions:
					input.confirmFineGrainedPermissions,
			});
		}

		const nextSharing =
			input.shareWithOrganization === undefined
				? undefined
				: input.shareWithOrganization
					? ("ORGANIZATION" as const)
					: ("PRIVATE" as const);
		const sharingChanged =
			nextSharing !== undefined && nextSharing !== existing.sharing;

		const updated = await db.$transaction(async (tx) => {
			const row = await updateCredential(
				{
					id: existing.id,
					organizationId: input.organizationId,
					label: input.label,
					sharing: nextSharing,
					scopes: account ? account.scopes : input.scopes,
					expiresAt: input.expiresAt,
					account: checksGitHubToken
						? account
							? {
									externalAccountId: account.id,
									externalAccountLogin: account.login,
								}
							: null
						: undefined,
					secret:
						input.secret === undefined
							? undefined
							: existing.kind === "BASIC"
								? {
										username: input.username,
										token: input.secret,
									}
								: { token: input.secret },
				},
				tx,
			);
			if (!row) {
				throw new ORPCError("NOT_FOUND", {
					message: "Credential not found",
				});
			}
			const auditActor = {
				type: "user" as const,
				userId: context.user.id,
				emailSnapshot: context.user.email,
				nameSnapshot: context.user.name,
			};
			const resource = {
				type: "credential",
				id: row.id,
				name: row.label,
			};
			if (sharingChanged) {
				await recordAuditTx(tx, {
					action:
						nextSharing === "ORGANIZATION"
							? "org.credential.shared"
							: "org.credential.unshared",
					actor: auditActor,
					organizationId: input.organizationId,
					resource,
					metadata: credentialAuditMetadata(row),
				});
			}
			const otherChanges = {
				labelChanged:
					input.label !== undefined && input.label !== existing.label,
				secretReplaced: input.secret !== undefined,
				scopesChanged: input.scopes !== undefined || account !== null,
				expiryChanged: input.expiresAt !== undefined,
			};
			if (Object.values(otherChanges).some(Boolean)) {
				await recordAuditTx(tx, {
					action:
						row.userId === null
							? "org.credential.updated"
							: "account.credential.updated",
					actor: auditActor,
					organizationId: input.organizationId,
					resource,
					metadata: credentialAuditMetadata(row, otherChanges),
				});
			}
			return row;
		});

		return { credential: toClientCredential(updated, actor) };
	});
