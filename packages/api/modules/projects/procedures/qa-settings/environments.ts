import { ORPCError } from "@orpc/client";
import {
	createProjectEnvironment,
	deleteProjectEnvironment,
	getProjectEnvironment,
	listProjectEnvironments,
	updateProjectEnvironment,
} from "@repo/database";
import { assertSafeOutboundUrlResolved } from "@repo/utils/url-security";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const environmentTypeSchema = z.enum(["STAGING", "QA", "PRODUCTION"]);

/**
 * Base URLs are fetched by automation, so only http(s) is accepted — a
 * `file:`/`javascript:` target would be a request-forgery footgun, not a
 * deployment target.
 */
const baseUrlSchema = z
	.string()
	.url()
	.max(2048)
	.refine(
		(value) => {
			try {
				const { protocol } = new URL(value);
				return protocol === "https:" || protocol === "http:";
			} catch {
				return false;
			}
		},
		{ message: "Base URL must be an http(s) URL" },
	);

/**
 * Where the sign-in form lives, when it is not at the base URL. Same protocol
 * rule as the base URL — it is fetched by the same automation.
 *
 * Empty string clears it, which is how the form says "the login page IS the base
 * URL" without needing a separate control. `null` is what reaches the database.
 */
const signInUrlSchema = z.union([z.literal(""), baseUrlSchema]);

function assertSameOriginSignInUrl(
	baseUrl: string,
	signInUrl: string | null | undefined,
): void {
	if (!signInUrl?.trim()) {
		return;
	}
	if (new URL(baseUrl).origin !== new URL(signInUrl).origin) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Sign-in URL must use the same origin as the base URL",
		});
	}
}

async function assertSafeEnvironmentUrls(
	baseUrl: string,
	signInUrl: string | null | undefined,
): Promise<void> {
	const urls = [
		...new Set(
			[baseUrl, signInUrl?.trim()].filter((url): url is string =>
				Boolean(url),
			),
		),
	];
	try {
		await Promise.all(
			urls.map((url) => assertSafeOutboundUrlResolved(url)),
		);
	} catch {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Environment URLs must resolve to public HTTP or HTTPS addresses",
		});
	}
}

/** The project's deployment targets — the single source of truth for run URLs. */
export const listProjectEnvironmentsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/environments",
		tags: ["Projects"],
		summary: "List the project's deployment targets",
	})
	.input(z.object({ projectId: z.string() }))
	.handler(async ({ input }) => listProjectEnvironments(input.projectId));

export const createProjectEnvironmentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/{projectId}/environments",
		tags: ["Projects"],
		summary: "Add a deployment target to the project",
	})
	.input(
		z.object({
			projectId: z.string(),
			type: environmentTypeSchema,
			name: z.string().trim().min(1).max(120),
			baseUrl: baseUrlSchema,
			signInUrl: signInUrlSchema.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		// Tenant columns come from the PARENT PROJECT (see settings.ts) — never
		// from caller input.
		assertSameOriginSignInUrl(input.baseUrl, input.signInUrl);
		await assertSafeEnvironmentUrls(input.baseUrl, input.signInUrl);
		const environment = await createProjectEnvironment(input);
		recordAuditFromRequest(context, {
			action: "project.environment.created",
			category: "project",
			severity: environment.type === "PRODUCTION" ? "warning" : "info",
			outcome: "success",
			projectId: input.projectId,
			resource: {
				type: "project_environment",
				id: environment.id,
				name: environment.name,
			},
			metadata: {
				environmentType: environment.type,
				baseUrlOrigin: new URL(environment.baseUrl).origin,
				signInUrlOrigin: environment.signInUrl
					? new URL(environment.signInUrl).origin
					: null,
				isProduction: environment.type === "PRODUCTION",
			},
		});
		return environment;
	});

export const updateProjectEnvironmentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "PUT",
		path: "/projects/{projectId}/environments/{environmentId}",
		tags: ["Projects"],
		summary: "Update a deployment target",
	})
	.input(
		z.object({
			projectId: z.string(),
			environmentId: z.string(),
			type: environmentTypeSchema.optional(),
			name: z.string().trim().min(1).max(120).optional(),
			baseUrl: baseUrlSchema.optional(),
			signInUrl: signInUrlSchema.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const current = await getProjectEnvironment(input);
		if (!current) {
			throw new ORPCError("NOT_FOUND", {
				message: "Environment not found",
			});
		}
		assertSameOriginSignInUrl(
			input.baseUrl ?? current.baseUrl,
			input.signInUrl === undefined ? current.signInUrl : input.signInUrl,
		);
		await assertSafeEnvironmentUrls(
			input.baseUrl ?? current.baseUrl,
			input.signInUrl === undefined ? current.signInUrl : input.signInUrl,
		);

		const updated = await updateProjectEnvironment(input);
		if (!updated) {
			// updateMany matched nothing: the id is unknown, or belongs to another
			// project. Same answer either way — never confirm it exists elsewhere.
			throw new ORPCError("NOT_FOUND", {
				message: "Environment not found",
			});
		}
		recordAuditFromRequest(context, {
			action: "project.environment.updated",
			category: "project",
			severity: updated.type === "PRODUCTION" ? "warning" : "info",
			outcome: "success",
			projectId: input.projectId,
			resource: {
				type: "project_environment",
				id: updated.id,
				name: updated.name,
			},
			metadata: {
				environmentType: updated.type,
				baseUrlOrigin: new URL(updated.baseUrl).origin,
				signInUrlOrigin: updated.signInUrl
					? new URL(updated.signInUrl).origin
					: null,
				isProduction: updated.type === "PRODUCTION",
				changedFields: Object.keys(input).filter(
					(key) => key !== "projectId" && key !== "environmentId",
				),
			},
		});
		return updated;
	});

export const deleteProjectEnvironmentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/environments/{environmentId}",
		tags: ["Projects"],
		summary: "Remove a deployment target",
	})
	.input(
		z.object({
			projectId: z.string(),
			environmentId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const deleted = await deleteProjectEnvironment(input);
		if (!deleted) {
			throw new ORPCError("NOT_FOUND", {
				message: "Environment not found",
			});
		}
		recordAuditFromRequest(context, {
			action: "project.environment.deleted",
			category: "project",
			severity: deleted.type === "PRODUCTION" ? "warning" : "info",
			outcome: "success",
			projectId: input.projectId,
			resource: {
				type: "project_environment",
				id: deleted.id,
				name: deleted.name,
			},
			metadata: {
				environmentType: deleted.type,
				baseUrlOrigin: new URL(deleted.baseUrl).origin,
				signInUrlOrigin: deleted.signInUrl
					? new URL(deleted.signInUrl).origin
					: null,
				isProduction: deleted.type === "PRODUCTION",
			},
		});
		return { success: true };
	});
