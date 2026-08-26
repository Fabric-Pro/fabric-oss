import { ORPCError } from "@orpc/client";
import {
	db,
	listEnvironmentAuthSummaries,
	setEnvironmentAuth,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Sign-in credentials for a deployment target — the write path behind the
 * credential form in Settings ▸ Environments.
 *
 * The storage layer (`setEnvironmentAuth` / `listEnvironmentAuthSummaries`)
 * shipped earlier with deliberately ZERO callers, because a form that collects a
 * customer's production password while nothing consumes it takes on the entire
 * trust liability for none of the benefit. These procedures exist now because the
 * agentic runner consumes them.
 *
 * **Auditing lives here, not in the queries.** The queries have no actor; the
 * comment on them says so and names this as the obligation. Fabric storing a
 * credential that signs in to a customer's live system is a materially larger
 * ask than a repo read token, so every write is recorded — including the ones
 * that fail.
 *
 * **The secret never comes back out.** Reads return a redacted summary: which
 * kind of auth, which username, whether a secret exists, when it was last
 * written. There is no procedure anywhere that returns a decrypted value to a
 * client; the only decrypting caller is the runner activity, server-side.
 */

const authKindSchema = z.enum(["NONE", "FORM", "TOKEN", "HEADER"]);

/**
 * A header name, restricted to what HTTP actually permits as a token. Without
 * this, a name containing a newline would be a header-injection vector the
 * moment the runner puts it on a request.
 */
const headerNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, {
		message: "Header name may only contain valid HTTP token characters",
	});

async function requireEnvironment(input: {
	projectId: string;
	environmentId: string;
}): Promise<{ type: string; name: string } | null> {
	return db.projectEnvironment.findFirst({
		where: { id: input.environmentId, projectId: input.projectId },
		select: { type: true, name: true },
	});
}

/**
 * The redacted credential summary per environment. Read-gated by
 * PROJECT_SETTINGS_READ, matching the environments list it renders beside.
 */
export const listEnvironmentCredentialsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/environments/credentials",
		tags: ["Projects"],
		summary:
			"List each deployment target's stored sign-in credential (redacted)",
		description:
			"Returns whether a credential exists, its kind, the username and when it was last written. Never returns the secret.",
	})
	.input(z.object({ projectId: z.string() }))
	.handler(async ({ input }) =>
		listEnvironmentAuthSummaries({ projectId: input.projectId }),
	);

/**
 * Write or clear one environment's credential.
 *
 * Gated by PROJECT_SETTINGS_EDIT — the same bar as connecting a repository
 * integration, and deliberately higher than the TEST_CASE_UPDATE bar used for
 * *starting* runs. The line is configure vs. use: deciding which credentials
 * Fabric holds is an admin decision; spending an already-trusted one is not.
 */
export const setEnvironmentCredentialProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "PUT",
		path: "/projects/{projectId}/environments/{environmentId}/credential",
		tags: ["Projects"],
		summary: "Store or clear a deployment target's sign-in credential",
		description:
			"Encrypted at rest (AES-256-GCM). Omit `secret` to keep the stored one while editing the username; pass null to clear it. Setting kind NONE wipes the secret. Requires PROJECT_SETTINGS_EDIT.",
	})
	.input(
		z.object({
			projectId: z.string(),
			environmentId: z.string(),
			authKind: authKindSchema,
			/** Not secret on its own; needed to show WHICH account is configured. */
			authUsername: z.string().trim().max(320).nullish(),
			authHeaderName: headerNameSchema.nullish(),
			/**
			 * Omit to KEEP the stored secret (editing a username should not
			 * require re-typing a password); null or "" clears it.
			 */
			secret: z.string().max(4096).nullish(),
		}),
	)
	.handler(async ({ input, context }) => {
		const auditRefusal = (failure: string): void => {
			recordAuditFromRequest(context, {
				action: "project.environment_credential.updated",
				category: "project",
				severity: "warning",
				outcome: "failure",
				projectId: input.projectId,
				resource: {
					type: "project_environment",
					id: input.environmentId,
				},
				metadata: {
					failure,
					authKind: input.authKind,
					secretSupplied:
						input.secret !== undefined &&
						input.secret !== null &&
						input.secret !== "",
				},
			});
		};

		const env = await requireEnvironment({
			projectId: input.projectId,
			environmentId: input.environmentId,
		});
		if (!env) {
			auditRefusal("ENVIRONMENT_NOT_FOUND");
			throw new ORPCError("NOT_FOUND", {
				message: "Environment not found",
			});
		}

		if (input.authKind === "FORM" && input.authUsername != null) {
			// A FORM credential with no username cannot sign in. Rejected at the
			// boundary rather than stored and discovered at run time as a
			// mysterious stuck login form.
			if (input.authUsername.trim().length === 0) {
				auditRefusal("FORM_USERNAME_REQUIRED");
				throw new ORPCError("BAD_REQUEST", {
					message: "Form sign-in needs a username or email address.",
				});
			}
		}
		if (input.authKind === "HEADER" && !input.authHeaderName) {
			auditRefusal("HEADER_NAME_REQUIRED");
			throw new ORPCError("BAD_REQUEST", {
				message: "Header auth needs a header name, e.g. X-API-Key.",
			});
		}

		let updated: boolean;
		try {
			({ updated } = await setEnvironmentAuth({
				projectId: input.projectId,
				environmentId: input.environmentId,
				authKind: input.authKind,
				authUsername: input.authUsername ?? null,
				authHeaderName: input.authHeaderName ?? null,
				secret: input.secret,
			}));
		} catch (error) {
			auditRefusal("WRITE_FAILED");
			throw error;
		}
		if (!updated) {
			auditRefusal("ENVIRONMENT_NOT_FOUND");
			throw new ORPCError("NOT_FOUND", {
				message: "Environment not found",
			});
		}

		// SOC 2 CC6: a credential that signs in to the customer's own system
		// changed hands. `isProduction` is recorded explicitly because "someone
		// stored a live-system password" is the entry an investigation looks for.
		//
		// Metadata carries the SHAPE of the change and never the value: which
		// kind, whether a secret was written or cleared, and the username (which
		// is not secret and is what identifies the account).
		recordAuditFromRequest(context, {
			action: "project.environment_credential.updated",
			category: "project",
			severity: env.type === "PRODUCTION" ? "warning" : "info",
			outcome: "success",
			projectId: input.projectId,
			resource: { type: "project_environment", id: input.environmentId },
			metadata: {
				environmentName: env.name,
				environmentType: env.type,
				isProduction: env.type === "PRODUCTION",
				authKind: input.authKind,
				secretWritten:
					input.secret !== undefined &&
					input.secret !== null &&
					input.secret !== "",
				secretCleared:
					input.authKind === "NONE" ||
					input.secret === null ||
					input.secret === "",
				username: input.authUsername ?? null,
			},
		});

		// The redacted summary, so the form can re-render from the write's own
		// answer rather than issuing a second request that might race it.
		const summaries = await listEnvironmentAuthSummaries({
			projectId: input.projectId,
		});
		return (
			summaries.find((s) => s.environmentId === input.environmentId) ??
			null
		);
	});
