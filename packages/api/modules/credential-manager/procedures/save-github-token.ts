import { ORPCError } from "@orpc/server";
import { validateGitHubPat } from "@repo/connectors";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { gitHubPatValidationMessage } from "../../projects/procedures/repository-integrations/lib/pat-validation-errors";
import { resolveCredentialActor } from "../lib/context";
import {
	pastedTokenCredentialSchema,
	saveCredentialInputSchema,
	savePastedGitHubToken,
	toPastedTokenCredential,
} from "../lib/pasted-token";

/**
 * Save a GitHub token pasted into the repository import form (spec
 * 2026-11-04 §4.3). There is no repository integration yet: the import
 * passes the returned credential to `projects.previewRepositoryImport` and
 * `projects.existingSetup.start`, which bind it to the repositories they
 * connect.
 *
 * The token is validated against the repository first, as every pasted
 * token is. When the caller already saved a token for the same GitHub
 * account, nothing is written and the answer is `{ existingCredential }`;
 * the form asks, and either uses that credential (no further request: it
 * reads the repository with it) or sends this request once more with
 * `saveAsNew: true`. Otherwise `{ credential }` is the new private `PAT`.
 * Refused (NOT_FOUND) while the credential manager is off.
 */
export const saveGitHubTokenProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_INTEGRATIONS_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/credentials/github-token",
		tags: ["Credentials"],
		summary: "Save a pasted GitHub token, or name the one already saved",
	})
	.input(
		saveCredentialInputSchema.extend({
			organizationId: z.string(),
			token: z.string().trim().min(1).max(8192),
			owner: z.string().trim().min(1).max(100),
			repo: z.string().trim().min(1).max(100),
		}),
	)
	.output(
		z.object({
			existingCredential: pastedTokenCredentialSchema.optional(),
			credential: pastedTokenCredentialSchema.optional(),
		}),
	)
	.handler(async ({ context, input }) => {
		const actor = await resolveCredentialActor(
			input.organizationId,
			context.user.id,
		);
		const validation = await validateGitHubPat({
			pat: input.token,
			owner: input.owner,
			repo: input.repo,
		});
		if (!validation.ok) {
			throw new ORPCError("BAD_REQUEST", {
				message: gitHubPatValidationMessage(validation.status),
			});
		}
		const saved = await savePastedGitHubToken({
			actor,
			user: context.user,
			token: input.token,
			label: input.label,
			saveAsNew: input.saveAsNew,
			confirmFineGrainedPermissions: input.confirmFineGrainedPermissions,
		});
		return saved.outcome === "existing"
			? { existingCredential: toPastedTokenCredential(saved.credential) }
			: { credential: toPastedTokenCredential(saved.credential) };
	});
