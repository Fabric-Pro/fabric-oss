import { ORPCError } from "@orpc/server";
import { Permissions } from "@repo/permissions";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { recordAuditFromRequest } from "../../lib/audit";
import { readBrandBody } from "../branding/lib/brand-body";
import {
	artifactBrandReadSchema,
	type BrandActor,
	clientBrandSaveSchema,
	companyBrandSaveSchema,
	getArtifactBrandCommand,
	saveClientBrandCommand,
	saveCompanyBrandCommand,
} from "../branding/lib/brand-commands";
import {
	proposalStyleReadSchema,
	proposalStyleSaveBodySchema,
	proposalStyleSaveSchema,
} from "../branding/lib/brand-contracts";
import {
	getProposalStyleCommand,
	saveProposalStyleCommand,
} from "../branding/lib/proposal-style-commands";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { resolveContextProject } from "./contexts";
import { ok, resolveV1Context } from "./helpers";

type Env = { Variables: ExternalApiVariables };
export function registerBrandRoutes(app: Hono<Env>) {
	async function invoke(
		c: Context<Env>,
		projectId: string | undefined,
		run: (actor: BrandActor) => Promise<unknown>,
	) {
		c.header("Cache-Control", "private, no-store");
		const resolved = projectId
			? await resolveContextProject(
					projectId,
					c.get("externalApiContext"),
					{
						org: c.req.query("org"),
						personal: c.req.query("personal") === "1",
					},
					{
						permission:
							c.req.method === "GET"
								? Permissions.DOCUMENT_READ
								: Permissions.DOCUMENT_UPDATE,
						refusal:
							"No permission to access this project's client brand",
						organizationRefusal:
							"Client branding requires an organization project",
					},
				)
			: await resolveV1Context(
					c.get("externalApiContext"),
					c.req.query("org"),
				);
		if ("error" in resolved) {
			return c.json(
				{
					error:
						typeof resolved.error === "string"
							? { message: resolved.error }
							: resolved.error,
				},
				resolved.status,
			);
		}
		if (!resolved.organizationId) {
			return c.json(
				{
					error: {
						code: "FORBIDDEN",
						message: "An organization is required",
					},
				},
				403,
			);
		}
		try {
			return c.json(
				ok(
					await run({
						userId: resolved.userId,
						organizationId: resolved.organizationId,
					}),
				),
			);
		} catch (error) {
			if (error instanceof z.ZodError || error instanceof SyntaxError) {
				return c.json(
					{
						error: {
							code: "BAD_REQUEST",
							message: "Use the declared branding schema",
						},
					},
					400,
				);
			}
			if (error instanceof ORPCError) {
				return c.json(
					{ error: { code: error.code, message: error.message } },
					error.code === "FORBIDDEN"
						? 403
						: error.code === "NOT_FOUND"
							? 404
							: error.code === "CONFLICT"
								? 409
								: error.code === "SERVICE_UNAVAILABLE"
									? 503
									: error.code === "PAYLOAD_TOO_LARGE"
										? 413
										: 400,
				);
			}
			throw error;
		}
	}
	const audit =
		(c: Context<Env>) =>
		(event: Parameters<typeof recordAuditFromRequest>[1]) => {
			const actor = c.get("externalApiContext");
			return recordAuditFromRequest(
				{ headers: c.req.raw.headers },
				{
					...event,
					actor: {
						type: actor.keyType === "oauth" ? "agent" : "api_key",
						userId: actor.userId,
					},
				},
			);
		};
	app.get("/branding", requireScope("orgs:read"), (c) =>
		invoke(c, undefined, (actor) => getArtifactBrandCommand(actor, {})),
	);
	app.get("/projects/:id/branding", requireScope("projects:read"), (c) =>
		invoke(c, c.req.param("id"), (actor) =>
			getArtifactBrandCommand(
				actor,
				artifactBrandReadSchema.parse({ projectId: c.req.param("id") }),
			),
		),
	);
	app.put("/branding/company", requireScope("orgs:write"), (c) =>
		invoke(c, undefined, async (actor) =>
			saveCompanyBrandCommand(
				actor,
				companyBrandSaveSchema.parse(await readBrandBody(c.req.raw)),
				audit(c),
			),
		),
	);
	app.put(
		"/projects/:id/branding/client",
		requireScope("projects:write"),
		(c) =>
			invoke(c, c.req.param("id"), async (actor) =>
				saveClientBrandCommand(
					actor,
					clientBrandSaveSchema.parse({
						...clientBrandSaveSchema
							.omit({ projectId: true })
							.parse(await readBrandBody(c.req.raw)),
						projectId: c.req.param("id"),
					}),
					audit(c),
				),
			),
	);
	app.get(
		"/projects/:id/documents/:documentId/proposal-style",
		requireScope("projects:read"),
		(c) =>
			invoke(c, c.req.param("id"), (actor) =>
				getProposalStyleCommand(
					actor,
					proposalStyleReadSchema.parse({
						projectId: c.req.param("id"),
						documentId: c.req.param("documentId"),
					}),
				),
			),
	);
	app.put(
		"/projects/:id/documents/:documentId/proposal-style",
		requireScope("projects:write"),
		(c) =>
			invoke(c, c.req.param("id"), async (actor) =>
				saveProposalStyleCommand(
					actor,
					proposalStyleSaveSchema.parse({
						...proposalStyleSaveBodySchema.parse(
							await readBrandBody(c.req.raw),
						),
						projectId: c.req.param("id"),
						documentId: c.req.param("documentId"),
					}),
					audit(c),
				),
			),
	);
}
