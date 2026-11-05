import { Permissions } from "@repo/permissions";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import {
	addWorkspaceLinkSchema,
	readWorkspaceLinkSchema,
	WorkspaceLinkError,
	workspaceDocumentLinkCommands,
	workspaceLinkPageSchema,
} from "../projects/lib/workspace-document-links";
import { resolveContextProject } from "./contexts";
import { ok } from "./helpers";

type Env = { Variables: ExternalApiVariables };
const integer = (v: string | undefined) =>
	v === undefined ? undefined : /^[0-9]+$/.test(v) ? Number(v) : Number.NaN;
export function registerWorkspaceDocumentLinkRoutes(app: Hono<Env>) {
	const root = "/projects/:projectId/contexts/workspace-documents";
	app.use(`${root}*`, async (c, next) => {
		c.header("Cache-Control", "private, no-store");
		await next();
	});
	async function run(
		c: Context<Env>,
		operation: "read" | "link" | "unlink",
		command: (actor: {
			projectId: string;
			organizationId: string;
			userId: string;
		}) => Promise<unknown>,
	) {
		try {
			const projectId = c.req.param("projectId") ?? "";
			const principal = await resolveContextProject(
				projectId,
				c.get("externalApiContext"),
				{ org: c.req.query("org"), personal: false },
				{
					permission:
						operation === "read"
							? Permissions.CONTEXT_READ
							: operation === "link"
								? Permissions.CONTEXT_CREATE
								: Permissions.CONTEXT_DELETE,
					refusal: "Current project context permission is required.",
				},
			);
			if ("error" in principal) {
				return c.json({ error: principal.error }, principal.status);
			}
			if (!principal.organizationId) {
				throw new WorkspaceLinkError("FORBIDDEN");
			}
			return c.json(
				ok(
					await command({
						...principal,
						organizationId: principal.organizationId,
						projectId,
					}),
				),
			);
		} catch (error) {
			const safe =
				error instanceof WorkspaceLinkError
					? error
					: new WorkspaceLinkError("UNAVAILABLE");
			return c.json(
				{ error: { code: safe.code, message: safe.message } },
				safe.status,
			);
		}
	}
	app.get(
		root,
		requireScope("projects:read"),
		requireScope("workspaces:read"),
		(c) =>
			run(c, "read", async (actor) => {
				const parsed = workspaceLinkPageSchema.safeParse({
					limit: integer(c.req.query("limit")),
					offset: integer(c.req.query("offset")),
				});
				if (!parsed.success) {
					throw new WorkspaceLinkError("INVALID_INPUT");
				}
				return (await workspaceDocumentLinkCommands()).list(
					actor,
					parsed.data,
				);
			}),
	);
	app.post(
		root,
		requireScope("projects:write"),
		requireScope("workspaces:read"),
		bodyLimit({ maxSize: 4096 }),
		(c) =>
			run(c, "link", async (actor) => {
				let raw: unknown;
				try {
					raw = await c.req.json();
				} catch {
					throw new WorkspaceLinkError("INVALID_INPUT");
				}
				const parsed = addWorkspaceLinkSchema.safeParse(raw);
				if (!parsed.success) {
					throw new WorkspaceLinkError("INVALID_INPUT");
				}
				return (await workspaceDocumentLinkCommands()).add(
					actor,
					parsed.data,
					c.get("externalApiContext").keyType === "oauth"
						? "agent"
						: "api_key",
				);
			}),
	);
	app.delete(`${root}/:linkId`, requireScope("projects:write"), (c) =>
		run(c, "unlink", async (actor) =>
			(await workspaceDocumentLinkCommands()).remove(
				actor,
				{ linkId: c.req.param("linkId") },
				c.get("externalApiContext").keyType === "oauth"
					? "agent"
					: "api_key",
			),
		),
	);
	app.get(
		`${root}/:linkId/content`,
		requireScope("projects:read"),
		requireScope("workspaces:read"),
		(c) =>
			run(c, "read", async (actor) => {
				const parsed = readWorkspaceLinkSchema.safeParse({
					linkId: c.req.param("linkId"),
					offset: integer(c.req.query("offset")),
					limit: integer(c.req.query("limit")),
					expectedRevision: c.req.query("expectedRevision"),
				});
				if (!parsed.success) {
					throw new WorkspaceLinkError("INVALID_INPUT");
				}
				return (await workspaceDocumentLinkCommands()).read(
					actor,
					parsed.data,
				);
			}),
	);
}
