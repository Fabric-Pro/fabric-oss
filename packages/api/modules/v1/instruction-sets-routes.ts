/**
 * Public v1 API: a project's Coding Instructions sets (spec 2026-11-11 §4.5).
 *
 *   GET    /projects/:projectId/instructions/sets          the live sets, default first
 *   POST   /projects/:projectId/instructions/sets          create a set
 *   PATCH  /projects/:projectId/instructions/sets/:setId   rename / replace repositories
 *   DELETE /projects/:projectId/instructions/sets/:setId   delete from Fabric (files stay in git)
 *
 * What the CLI and SDK use to choose and manage a set. Every route runs the
 * same object-level gate as every instruction route
 * (`resolveInstructionProject`: the creator's live permission, the
 * organization binding of an organization key, a project-bound credential's
 * own project).
 *
 * Listing needs `instructions:read` and INSTRUCTION_READ. Changing a set is
 * project configuration: `projects:write` and the LIVE INSTRUCTION_UPDATE —
 * never `instructions:write`, a scope a viewer may mint on the promise that
 * it only proposes changes for review. The oRPC procedures and the MCP tools
 * use the same query code.
 */
import {
	createInstructionSet,
	deleteInstructionSet,
	InstructionSetError,
	type InstructionSetView,
	listInstructionSets,
	updateInstructionSet,
} from "@repo/database";
import { Permissions } from "@repo/permissions";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { recordAuditFromRequest } from "../../lib/audit";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { badRequest, ok } from "./helpers";
import { resolveInstructionProject } from "./instruction-project-gate";

type Ctx = Context<{ Variables: ExternalApiVariables }>;

const repositoryIds = z.array(z.string().min(1).max(200)).max(200);

const createBody = z.object({
	name: z.string().min(1).max(80),
	slug: z.string().min(1).max(40).optional(),
	repositoryIntegrationIds: repositoryIds.default([]),
});

const updateBody = z
	.object({
		name: z.string().min(1).max(80).optional(),
		repositoryIntegrationIds: repositoryIds.optional(),
	})
	.refine(
		(b) => b.name !== undefined || b.repositoryIntegrationIds !== undefined,
		{ message: "Give a name or repositoryIntegrationIds" },
	);

function setView(set: InstructionSetView) {
	return {
		id: set.id,
		name: set.name,
		slug: set.slug,
		isDefault: set.isDefault,
		repositoryIntegrationIds: set.repositoryIntegrationIds,
		folder: set.folder,
		excludedFolders: set.excludedFolders,
	};
}

const REFUSAL_STATUS = {
	SET_NOT_FOUND: 404,
	INVALID_SET_NAME: 400,
	SLUG_TAKEN: 409,
	DEFAULT_SET_UNDELETABLE: 409,
	REPOSITORY_NOT_FOUND: 400,
	REPOSITORY_IS_INSTRUCTIONS_SOURCE: 400,
} as const;

function refusal(c: Ctx, error: unknown) {
	if (error instanceof InstructionSetError) {
		return c.json(
			{
				error: {
					message: error.message,
					code: error.code,
					...error.details,
				},
			},
			REFUSAL_STATUS[error.code],
		);
	}
	throw error;
}

async function gate(c: Ctx, write: boolean) {
	return resolveInstructionProject(
		c.req.param("projectId") ?? "",
		c.get("externalApiContext"),
		{
			org: c.req.query("org"),
			personal: c.req.query("personal") === "1",
			...(write
				? { requiredPermission: Permissions.INSTRUCTION_UPDATE }
				: {}),
		},
	);
}

async function body<T extends z.ZodType>(
	c: Ctx,
	schema: T,
): Promise<{ data: z.infer<T> } | { error: string }> {
	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		return { error: "Invalid JSON body" };
	}
	const parsed = schema.safeParse(raw);
	return parsed.success
		? { data: parsed.data }
		: { error: parsed.error.issues[0]?.message ?? "Invalid body" };
}

function audit(
	c: Ctx,
	event: {
		action:
			| "project.instructions.set_created"
			| "project.instructions.set_updated"
			| "project.instructions.set_deleted";
		organizationId: string;
		projectId: string;
		set: { id: string; name: string };
		metadata: Record<string, unknown>;
	},
) {
	const apiCtx = c.get("externalApiContext");
	return recordAuditFromRequest(
		{ headers: c.req.raw.headers },
		{
			action: event.action,
			category: "project",
			organizationId: event.organizationId,
			projectId: event.projectId,
			resource: {
				type: "project_instruction_set",
				id: event.set.id,
				name: event.set.name,
			},
			actor: {
				type: apiCtx.keyType === "oauth" ? "agent" : "api_key",
				userId: apiCtx.userId,
			},
			metadata: { ...event.metadata, via: "api" },
		},
	);
}

export function registerInstructionSetRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
): void {
	app.get(
		"/projects/:projectId/instructions/sets",
		requireScope("instructions:read"),
		async (c: Ctx) => {
			const resolved = await gate(c, false);
			if ("error" in resolved) {
				return c.json({ error: resolved.error }, resolved.status);
			}
			const sets = await listInstructionSets(
				c.req.param("projectId") ?? "",
			);
			return c.json(ok({ sets: sets.map(setView) }));
		},
	);

	app.post(
		"/projects/:projectId/instructions/sets",
		requireScope("projects:write"),
		async (c: Ctx) => {
			const input = await body(c, createBody);
			if ("error" in input) {
				return c.json(badRequest(input.error), 400);
			}
			const resolved = await gate(c, true);
			if ("error" in resolved) {
				return c.json({ error: resolved.error }, resolved.status);
			}
			const projectId = c.req.param("projectId") ?? "";
			try {
				const set = await createInstructionSet({
					projectId,
					organizationId: resolved.organizationId,
					userId: resolved.userId,
					name: input.data.name,
					slug: input.data.slug,
					repositoryIntegrationIds:
						input.data.repositoryIntegrationIds,
				});
				await audit(c, {
					action: "project.instructions.set_created",
					organizationId: resolved.organizationId,
					projectId,
					set,
					metadata: {
						slug: set.slug,
						repositoryCount: set.repositoryIntegrationIds.length,
					},
				});
				return c.json(ok({ set: setView(set) }), 201);
			} catch (error) {
				return refusal(c, error);
			}
		},
	);

	app.patch(
		"/projects/:projectId/instructions/sets/:setId",
		requireScope("projects:write"),
		async (c: Ctx) => {
			const input = await body(c, updateBody);
			if ("error" in input) {
				return c.json(badRequest(input.error), 400);
			}
			const resolved = await gate(c, true);
			if ("error" in resolved) {
				return c.json({ error: resolved.error }, resolved.status);
			}
			const projectId = c.req.param("projectId") ?? "";
			try {
				const { set, before } = await updateInstructionSet({
					projectId,
					organizationId: resolved.organizationId,
					userId: resolved.userId,
					setId: c.req.param("setId") ?? "",
					name: input.data.name,
					repositoryIntegrationIds:
						input.data.repositoryIntegrationIds,
				});
				await audit(c, {
					action: "project.instructions.set_updated",
					organizationId: resolved.organizationId,
					projectId,
					set,
					metadata: {
						renamed: before.name !== set.name,
						repositoryCount: set.repositoryIntegrationIds.length,
						previousRepositoryCount:
							before.repositoryIntegrationIds.length,
					},
				});
				return c.json(ok({ set: setView(set) }));
			} catch (error) {
				return refusal(c, error);
			}
		},
	);

	app.delete(
		"/projects/:projectId/instructions/sets/:setId",
		requireScope("projects:write"),
		async (c: Ctx) => {
			const resolved = await gate(c, true);
			if ("error" in resolved) {
				return c.json({ error: resolved.error }, resolved.status);
			}
			const projectId = c.req.param("projectId") ?? "";
			try {
				const set = await deleteInstructionSet({
					projectId,
					setId: c.req.param("setId") ?? "",
				});
				await audit(c, {
					action: "project.instructions.set_deleted",
					organizationId: resolved.organizationId,
					projectId,
					set,
					metadata: { slug: set.slug },
				});
				return c.json(ok({ id: set.id, deleted: true }));
			} catch (error) {
				return refusal(c, error);
			}
		},
	);
}
