import { ORPCError } from "@orpc/server";
import { createCredential, db, recordAuditTx } from "@repo/database";
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
import {
	clientCredentialSchema,
	credentialOriginSchema,
	credentialProviderSchema,
	DEFAULT_PROVIDER_ORIGIN,
	manualCredentialKindSchema,
} from "../lib/schemas";

/**
 * Save a token or key a person pastes (PAT, API key, user + token). OAuth
 * grants and app installations come from their provider's connect flow.
 *
 * `owner: "organization"` needs the role that manages integrations; a
 * member's own credential needs only membership. The secret is encrypted
 * before it reaches the database and never returned.
 */
export const createCredentialProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_INTEGRATIONS_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/credentials",
		tags: ["Credentials"],
		summary: "Save a credential",
	})
	.input(
		z
			.object({
				organizationId: z.string(),
				owner: z.enum(["me", "organization"]),
				shareWithOrganization: z.boolean().default(false),
				provider: credentialProviderSchema,
				kind: manualCredentialKindSchema,
				label: z.string().trim().min(1).max(120),
				origin: credentialOriginSchema.optional(),
				username: z.string().trim().min(1).max(320).optional(),
				secret: z.string().trim().min(1).max(8192),
				scopes: z
					.array(z.string().trim().min(1).max(200))
					.max(100)
					.optional(),
				expiresAt: z.coerce.date().optional(),
				/** The person confirmed a fine-grained GitHub token's permissions. */
				confirmFineGrainedPermissions: z.boolean().default(false),
			})
			.refine((v) => v.kind !== "BASIC" || Boolean(v.username), {
				message: "A user name is required for this kind",
				path: ["username"],
			}),
	)
	.output(z.object({ credential: clientCredentialSchema }))
	.handler(async ({ context, input }) => {
		const actor = await resolveCredentialActor(
			input.organizationId,
			context.user.id,
		);
		if (
			input.owner === "organization" &&
			!actor.canManageOrganizationIntegrations
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only members who manage integrations can add organization credentials",
			});
		}
		const origin = input.origin ?? DEFAULT_PROVIDER_ORIGIN[input.provider];
		if (!origin) {
			throw new ORPCError("BAD_REQUEST", {
				message: "This provider needs an origin (the instance URL)",
			});
		}

		// A GitHub token is checked and its account read before it is saved
		// (lib/github-token-check.ts); unreachable GitHub saves it without one.
		let account: GitHubTokenAccountRead | null = null;
		if (
			input.provider === "GITHUB" &&
			input.kind === "PAT" &&
			isGitHubDotComOrigin(origin)
		) {
			account = await checkGitHubTokenForSave({
				token: input.secret,
				confirmFineGrainedPermissions:
					input.confirmFineGrainedPermissions,
			});
		}

		const ownerUserId =
			input.owner === "organization" ? null : context.user.id;
		const credential = await db.$transaction(async (tx) => {
			const created = await createCredential(
				{
					organizationId: input.organizationId,
					userId: ownerUserId,
					sharing:
						ownerUserId === null || input.shareWithOrganization
							? "ORGANIZATION"
							: "PRIVATE",
					provider: input.provider,
					kind: input.kind,
					principal: "USER",
					label: input.label,
					origin,
					externalAccountId: account?.id ?? null,
					externalAccountLogin: account?.login ?? null,
					scopes: account ? account.scopes : input.scopes,
					secret:
						input.kind === "BASIC"
							? { username: input.username, token: input.secret }
							: { token: input.secret },
					expiresAt: input.expiresAt ?? null,
					createdByUserId: context.user.id,
				},
				tx,
			);
			await recordAuditTx(tx, {
				action:
					ownerUserId === null
						? "org.credential.created"
						: "account.credential.created",
				actor: {
					type: "user",
					userId: context.user.id,
					emailSnapshot: context.user.email,
					nameSnapshot: context.user.name,
				},
				organizationId: input.organizationId,
				resource: {
					type: "credential",
					id: created.id,
					name: created.label,
				},
				metadata: credentialAuditMetadata(created),
			});
			return created;
		});

		return { credential: toClientCredential(credential, actor) };
	});
