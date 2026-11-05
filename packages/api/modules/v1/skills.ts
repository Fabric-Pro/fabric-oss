import { ORPCError } from "@orpc/server";
import {
	SKILL_AUTHORING_MAX_BYTES,
	SKILL_IMPORT_MAX_REQUEST_BYTES,
	skillAssistSchema,
	skillFileReadSchema,
	skillImportCreateSchema,
	skillImportFileSchema,
	skillImportPreviewSchema,
} from "@repo/ai/skill-authoring-contracts";
import type { SkillActor } from "@repo/ai/skill-contracts";
import {
	SkillError,
	skillArchiveSchema,
	skillCreateSchema,
	skillDeleteSchema,
	skillGetSchema,
	skillGovernanceUpdateSchema,
	skillListSchema,
	skillPublishSchema,
	skillRestoreSchema,
	skillUpdateSchema,
} from "@repo/ai/skill-contracts";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import {
	type RecordAuditFromRequestInput,
	recordAuditFromRequest,
} from "../../lib/audit";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import {
	assistSkillCommand,
	createSkillImportCommand,
	previewSkillImportCommand,
	readSkillFileCommand,
	readSkillImportFileCommand,
} from "../skills/lib/skill-authoring";
import {
	archiveSkillCommand,
	createSkillCommand,
	deleteSkillCommand,
	getSkillCommand,
	getSkillGovernanceCommand,
	listSkillsCommand,
	publishSkillCommand,
	restoreSkillCommand,
	updateSkillCommand,
	updateSkillGovernanceCommand,
} from "../skills/lib/skill-commands";
import { ok, resolveV1Context } from "./helpers";

type Env = { Variables: ExternalApiVariables };
type Audit = (event: RecordAuditFromRequestInput) => unknown;
function checkPublicationScope(
	c: Context<Env>,
	body: { isPublished?: boolean; isDiscoverable?: boolean },
) {
	const scopes = c.get("externalApiContext").scopes;
	if (
		(body.isPublished || body.isDiscoverable) &&
		!scopes.includes("skills:publish") &&
		!scopes.includes("*")
	) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"Publishing or agent discovery requires explicit skills:publish scope.",
			data: { code: "INSUFFICIENT_SCOPE" },
		});
	}
}
const skillBodies = new WeakMap<Context<Env>, string>();
async function skillJson(c: Context<Env>): Promise<unknown> {
	return JSON.parse(skillBodies.get(c) ?? "");
}
/** Read the original stream without constructing a second native/Next Request. */
function boundedSkillBody({
	maxSize,
}: {
	maxSize: number;
}): MiddlewareHandler<Env> {
	return async (c, next) => {
		const tooLarge = () =>
			c.json(
				{
					error: {
						code: "PAYLOAD_TOO_LARGE",
						message: "Skill request exceeds the allowed size.",
					},
				},
				413,
			);
		const declared = c.req.header("content-length");
		if (declared && /^\d+$/.test(declared) && Number(declared) > maxSize) {
			return tooLarge();
		}
		const reader = c.req.raw.body?.getReader();
		let text = "";
		let bytes = 0;
		const decoder = new TextDecoder();
		if (reader) {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					bytes += value.byteLength;
					if (bytes > maxSize) {
						await reader.cancel().catch(() => undefined);
						return tooLarge();
					}
					text += decoder.decode(value, { stream: true });
				}
				text += decoder.decode();
			} catch {
				return c.json(
					{
						error: {
							code: "BAD_REQUEST",
							message:
								"The skill request body could not be read.",
						},
					},
					400,
				);
			} finally {
				reader.releaseLock();
			}
		}
		skillBodies.set(c, text);
		await next();
	};
}
export function registerSkillRoutes(app: Hono<Env>) {
	async function invoke(
		c: Context<Env>,
		command: (actor: SkillActor, audit: Audit) => Promise<unknown>,
		unwrap = false,
	) {
		c.header("Cache-Control", "private, no-store");
		const api = c.get("externalApiContext");
		const resolved = await resolveV1Context(api, c.req.query("org"));
		if ("error" in resolved) {
			return c.json(
				{
					error: {
						code: "ORGANIZATION_REQUIRED",
						message: resolved.error,
					},
				},
				resolved.status,
			);
		}
		if (!resolved.organizationId) {
			return c.json(
				{
					error: {
						code: "ORGANIZATION_REQUIRED",
						message: "An organization is required.",
					},
				},
				403,
			);
		}
		try {
			const result = await command(
				{
					userId: resolved.userId,
					organizationId: resolved.organizationId,
					external: true,
				},
				(event) =>
					recordAuditFromRequest(
						{ headers: c.req.raw.headers },
						{
							...event,
							actor: {
								type:
									api.keyType === "oauth"
										? "agent"
										: "api_key",
								userId: resolved.userId,
							},
						},
					),
			);
			if (
				result &&
				typeof result === "object" &&
				"__skillLegacyPage" in result
			) {
				const page = result.__skillLegacyPage as {
					skills: unknown[];
					total: number;
					hasMore: boolean;
					nextCursor: string | null;
				};
				return c.json(
					ok(page.skills, {
						total: page.total,
						hasMore: page.hasMore,
						nextCursor: page.nextCursor,
					}),
				);
			}
			return c.json(
				ok(
					unwrap &&
						result &&
						typeof result === "object" &&
						"skill" in result
						? result.skill
						: result,
				),
			);
		} catch (error) {
			if (error instanceof z.ZodError || error instanceof SyntaxError) {
				return c.json(
					{
						error: {
							code: "BAD_REQUEST",
							message: "Use the declared skill action schema.",
						},
					},
					400,
				);
			}
			if (error instanceof SkillError || error instanceof ORPCError) {
				const insufficient =
					error instanceof ORPCError &&
					error.data &&
					typeof error.data === "object" &&
					"code" in error.data &&
					error.data.code === "INSUFFICIENT_SCOPE";
				return c.json(
					{
						error: {
							code: insufficient
								? "INSUFFICIENT_SCOPE"
								: error.code,
							message: error.message,
						},
					},
					error.code === "FORBIDDEN"
						? 403
						: error.code === "NOT_FOUND"
							? 404
							: error.code === "CONFLICT"
								? 409
								: error.code === "SERVICE_UNAVAILABLE"
									? 503
									: 400,
				);
			}
			throw error;
		}
	}
	app.get("/skills", requireScope("skills:read"), (c) =>
		invoke(c, async (actor) => {
			const query = c.req.query();
			const boolean = (name: string) => {
				const value = query[name];
				if (value === undefined) {
					return;
				}
				if (value !== "true" && value !== "false") {
					throw new SkillError(
						"BAD_REQUEST",
						`${name} must be true or false.`,
					);
				}
				return value === "true";
			};
			const input = skillListSchema.parse({
				tab: query.tab,
				search: query.search,
				category: query.category,
				scope: query.scope,
				tags: c.req.queries("tags"),
				isPublished: boolean("isPublished"),
				isDiscoverable: boolean("isDiscoverable"),
				limit:
					query.limit === undefined ? undefined : Number(query.limit),
				offset:
					query.offset === undefined
						? undefined
						: Number(query.offset),
				cursor: query.cursor,
				sortBy: query.sortBy,
				sortOrder: query.sortOrder,
			});
			const result = await listSkillsCommand(actor, input, {
				includeContent: query.page !== "1",
			});
			// Preserve the existing array response; page=1 exposes the complete page.
			return query.page === "1" ? result : { __skillLegacyPage: result };
		}),
	);
	app.get("/skills/:id", requireScope("skills:read"), (c) =>
		invoke(
			c,
			(actor) =>
				getSkillCommand(
					actor,
					skillGetSchema.parse({ id: c.req.param("id") }),
				),
			true,
		),
	);
	app.post(
		"/skills",
		requireScope("skills:write"),
		boundedSkillBody({ maxSize: 1024 * 1024 }),
		(c) =>
			invoke(
				c,
				async (actor, audit) => {
					const input = skillCreateSchema.parse(
						await skillJson(c).catch(() => null),
					);
					checkPublicationScope(c, input);
					return createSkillCommand(actor, input, audit);
				},
				true,
			),
	);
	app.patch(
		"/skills/:id",
		requireScope("skills:write"),
		boundedSkillBody({ maxSize: 1024 * 1024 }),
		(c) =>
			invoke(
				c,
				async (actor, audit) =>
					updateSkillCommand(
						actor,
						{
							...skillUpdateSchema
								.omit({ id: true })
								.parse(await skillJson(c).catch(() => null)),
							id: c.req.param("id"),
						},
						audit,
					),
				true,
			),
	);
	app.delete(
		"/skills/:id",
		requireScope("skills:write"),
		boundedSkillBody({ maxSize: 1024 }),
		(c) =>
			invoke(c, async (actor, audit) => {
				const body = skillBodies.get(c) ?? "";
				if (body.trim()) {
					z.strictObject({}).parse(JSON.parse(body));
				}
				return deleteSkillCommand(
					actor,
					skillDeleteSchema.parse({
						id: c.req.param("id"),
						expectedVersion:
							c.req.query("expectedVersion") === undefined
								? undefined
								: Number(c.req.query("expectedVersion")),
					}),
					audit,
				);
			}),
	);
	app.post(
		"/skills/:id/archive",
		requireScope("skills:write"),
		boundedSkillBody({ maxSize: 2048 }),
		(c) =>
			invoke(
				c,
				async (actor, audit) =>
					archiveSkillCommand(
						actor,
						{
							...skillArchiveSchema
								.omit({ id: true })
								.parse(await skillJson(c).catch(() => null)),
							id: c.req.param("id"),
						},
						audit,
					),
				true,
			),
	);
	app.post(
		"/skills/:id/restore",
		requireScope("skills:write"),
		boundedSkillBody({ maxSize: 2048 }),
		(c) =>
			invoke(
				c,
				async (actor, audit) =>
					restoreSkillCommand(
						actor,
						{
							...skillRestoreSchema
								.omit({ id: true })
								.parse(await skillJson(c).catch(() => null)),
							id: c.req.param("id"),
						},
						audit,
					),
				true,
			),
	);
	app.post(
		"/skills/:id/publish",
		requireScope("skills:publish"),
		boundedSkillBody({ maxSize: 2048 }),
		(c) =>
			invoke(
				c,
				async (actor, audit) =>
					publishSkillCommand(
						actor,
						{
							...skillPublishSchema
								.omit({ id: true })
								.parse(await skillJson(c).catch(() => null)),
							id: c.req.param("id"),
						},
						audit,
					),
				true,
			),
	);
	app.get("/skill-governance", requireScope("governance:read"), (c) =>
		invoke(c, (actor) => getSkillGovernanceCommand(actor, {})),
	);
	app.patch(
		"/skill-governance",
		requireScope("governance:write"),
		boundedSkillBody({ maxSize: 2048 }),
		(c) =>
			invoke(c, async (actor, audit) =>
				updateSkillGovernanceCommand(
					actor,
					skillGovernanceUpdateSchema.parse(
						await skillJson(c).catch(() => null),
					),
					audit,
				),
			),
	);
	app.post(
		"/skill-assistance",
		requireScope("skills:write"),
		boundedSkillBody({ maxSize: SKILL_AUTHORING_MAX_BYTES }),
		(c) =>
			invoke(c, async (actor, audit) =>
				assistSkillCommand(
					actor,
					skillAssistSchema.parse(
						await skillJson(c).catch(() => null),
					),
					audit,
				),
			),
	);
	app.post(
		"/skill-imports/preview",
		requireScope("skills:write"),
		boundedSkillBody({ maxSize: SKILL_IMPORT_MAX_REQUEST_BYTES }),
		(c) =>
			invoke(c, async (actor, audit) =>
				previewSkillImportCommand(
					actor,
					skillImportPreviewSchema.parse(
						await skillJson(c).catch(() => null),
					),
					audit,
				),
			),
	);
	app.post(
		"/skill-imports",
		requireScope("skills:write"),
		boundedSkillBody({ maxSize: SKILL_IMPORT_MAX_REQUEST_BYTES }),
		(c) =>
			invoke(
				c,
				async (actor, audit) =>
					createSkillImportCommand(
						actor,
						skillImportCreateSchema.parse(
							await skillJson(c).catch(() => null),
						),
						audit,
					),
				true,
			),
	);
	app.get("/skills/:id/files", requireScope("skills:read"), (c) =>
		invoke(c, (actor) =>
			readSkillFileCommand(
				actor,
				skillFileReadSchema.parse({
					id: c.req.param("id"),
					path: c.req.query("path"),
					expectedVersion:
						c.req.query("expectedVersion") === undefined
							? undefined
							: Number(c.req.query("expectedVersion")),
				}),
			),
		),
	);
	app.post(
		"/skill-imports/file",
		requireScope("skills:write"),
		boundedSkillBody({ maxSize: SKILL_IMPORT_MAX_REQUEST_BYTES }),
		(c) =>
			invoke(c, async (actor, audit) =>
				readSkillImportFileCommand(
					actor,
					skillImportFileSchema.parse(
						await skillJson(c).catch(() => null),
					),
					audit,
				),
			),
	);
}
