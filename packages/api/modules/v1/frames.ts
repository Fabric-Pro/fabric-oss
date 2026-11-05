/**
 * v1 Frames routes
 * GET /frames          list frames (FRAME + SLIDESHOW)
 * GET /frames/:id      get frame details
 */
import {
	canDeleteOrganizationFrames,
	canReadOrganizationFrames,
	canUpdateOrganizationFrames,
	FrameUpdateConflictError,
	getFrameById,
	getFrameEditHistory,
	listFrames,
	listSharingGrants,
	revertFrameToVersion,
	revokeFrameSharing,
	shareFrame,
	updateFrame,
} from "@repo/database";
import type { Hono } from "hono";
import { z } from "zod";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import {
	frameContentEditSchema,
	frameRestoreSchema,
} from "../frames/lib/frame-edit-contract";
import {
	frameExportStartSchema,
	frameRevokeSharingSchema,
	frameShareSchema,
	frameSharingMutationDto,
} from "../frames/lib/frame-operation-contracts";
import { frameReadDto } from "../frames/lib/frame-read-dto";
import { notFound, ok, resolveV1Context } from "./helpers";

function mapFrame(f: {
	id: string;
	title: string;
	description?: string | null;
	kind?: string;
	fileType: string;
	status: string;
	isPublic: boolean;
	shareToken?: string | null;
	userId: string;
	organizationId?: string;
	createdAt: Date;
	updatedAt: Date;
}) {
	return {
		id: f.id,
		title: f.title,
		description: f.description ?? null,
		kind: f.kind ?? null,
		fileType: f.fileType,
		status: f.status,
		isPublic: f.isPublic,
		shareToken: frameReadDto(f).shareToken,
		userId: f.userId,
		organizationId: f.organizationId ?? null,
		createdAt: f.createdAt.toISOString(),
		updatedAt: f.updatedAt.toISOString(),
	};
}

export function registerFrameRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	app.get("/frames", requireScope("frames:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const parsed = z
			.object({
				limit: z.coerce
					.number()
					.int()
					.positive()
					.transform((value) => Math.min(value, 200))
					.default(50),
				offset: z.coerce.number().int().min(0).default(0),
				conversationId: z.string().trim().min(1).max(200).optional(),
			})
			.safeParse({
				limit: c.req.query("limit"),
				offset: c.req.query("offset"),
				conversationId: c.req.query("conversationId"),
			});
		if (!parsed.success) {
			return c.json(
				{
					error: {
						message:
							"Provide a positive integer limit, a non-negative offset and a valid conversation ID.",
					},
				},
				400,
			);
		}
		const { limit, offset, conversationId } = parsed.data;

		const frames = await listFrames({
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
			limit,
			offset,
			conversationId,
		});

		return c.json(ok(frames.map(mapFrame), { total: frames.length }));
	});

	app.get("/frames/:id/history", requireScope("frames:read"), async (c) => {
		const ctx = await resolveV1Context(
			c.get("externalApiContext"),
			c.req.query("org"),
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}
		const id = c.req.param("id");
		if (!id) {
			return c.json(notFound("Frame"), 404);
		}
		const frame = await getFrameById({
			id,
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
		});
		if (!frame) {
			return c.json(notFound("Frame"), 404);
		}
		const history = await getFrameEditHistory(id, 200);
		return c.json(
			ok({
				updatedAt: frame.updatedAt.toISOString(),
				history: history.map((e) => ({
					id: e.id,
					editType: e.editType,
					editedAt: e.editedAt.toISOString(),
					canRestore: Boolean(e.contentSnapshot),
					revertedToVersion: e.revertedToVersion,
				})),
			}),
		);
	});
	for (const action of ["update", "restore"] as const) {
		app.post(
			`/frames/:id/${action}`,
			requireScope("frames:write"),
			async (c) => {
				const ctx = await resolveV1Context(
					c.get("externalApiContext"),
					c.req.query("org"),
				);
				if ("error" in ctx) {
					return c.json(
						{ error: { message: ctx.error } },
						ctx.status,
					);
				}
				const id = c.req.param("id");
				if (!id) {
					return c.json(notFound("Frame"), 404);
				}
				if (
					!ctx.organizationId ||
					!(await canUpdateOrganizationFrames(
						ctx.userId,
						ctx.organizationId,
					))
				) {
					return c.json(
						{ error: { message: "No permission to edit frames." } },
						403,
					);
				}
				const raw = await c.req.json().catch(() => null);
				try {
					if (action === "update") {
						const parsed = frameContentEditSchema.safeParse(raw);
						if (!parsed.success) {
							return c.json(
								{
									error: {
										message:
											"Provide the reviewed revision and valid content fields. Sharing is changed separately.",
									},
								},
								400,
							);
						}
						const frame = await updateFrame({
							...parsed.data,
							id,
							userId: ctx.userId,
							organizationId: ctx.organizationId ?? undefined,
							expectedUpdatedAt: new Date(
								parsed.data.expectedUpdatedAt,
							),
						});
						if (!frame) {
							return c.json(notFound("Frame"), 404);
						}
						return c.json(
							ok(
								frameReadDto({
									...frame,
									createdAt: frame.createdAt.toISOString(),
									updatedAt: frame.updatedAt.toISOString(),
								}),
							),
						);
					}
					const parsed = frameRestoreSchema.safeParse(raw);
					if (!parsed.success) {
						return c.json(
							{
								error: {
									message:
										"Provide a reviewed revision and one saved version.",
								},
							},
							400,
						);
					}
					const result = await revertFrameToVersion({
						...parsed.data,
						frameId: id,
						userId: ctx.userId,
						organizationId: ctx.organizationId ?? undefined,
						expectedUpdatedAt: new Date(
							parsed.data.expectedUpdatedAt,
						),
					});
					if (!result.success) {
						return c.json(
							{
								error: {
									message: "Saved version is unavailable.",
								},
							},
							404,
						);
					}
					return c.json(
						ok({ success: true, updatedAt: result.updatedAt }),
					);
				} catch (error) {
					if (error instanceof FrameUpdateConflictError) {
						return c.json(
							{
								error: {
									message: error.message,
									code: "CONFLICT",
								},
							},
							409,
						);
					}
					throw error;
				}
			},
		);
	}

	// Durable export and sharing operations resolve the same actor/tenant as the UI.
	app.post("/frames/:id/exports", requireScope("frames:write"), async (c) => {
		const ctx = await resolveV1Context(
			c.get("externalApiContext"),
			c.req.query("org"),
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}
		if (!ctx.organizationId) {
			return c.json(notFound("Frame"), 404);
		}
		const input = frameExportStartSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!input.success) {
			return c.json(
				{
					error: {
						message:
							"Provide a reviewed revision, UUID requestId and valid orientation.",
					},
				},
				400,
			);
		}
		const service = await import("../frames/lib/frame-export-service");
		try {
			return c.json(
				ok(
					await service.startFrameExport(
						{
							userId: ctx.userId,
							organizationId: ctx.organizationId,
						},
						{ frameId: c.req.param("id") ?? "", ...input.data },
					),
				),
			);
		} catch (error) {
			if (error instanceof service.FrameExportError) {
				return c.json(
					{ error: { message: error.message, code: error.code } },
					exportErrorStatus(error.status),
				);
			}
			throw error;
		}
	});
	for (const action of ["status", "cancel", "download"] as const) {
		const path =
			action === "status"
				? "/frames/:id/exports/:exportId"
				: `/frames/:id/exports/:exportId/${action}`;
		const handler = async (
			c: import("hono").Context<{ Variables: ExternalApiVariables }>,
		) => {
			const ctx = await resolveV1Context(
				c.get("externalApiContext"),
				c.req.query("org"),
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}
			if (!ctx.organizationId) {
				return c.json(notFound("Frame"), 404);
			}
			const service = await import("../frames/lib/frame-export-service");
			const actor = {
				userId: ctx.userId,
				organizationId: ctx.organizationId,
			};
			const input = {
				frameId: c.req.param("id") ?? "",
				exportId: c.req.param("exportId") ?? "",
			};
			try {
				return c.json(
					ok(
						await (action === "status"
							? service.getFrameExport(actor, input)
							: action === "cancel"
								? service.cancelFrameExport(actor, input)
								: service.downloadFrameExport(actor, input)),
					),
				);
			} catch (error) {
				if (error instanceof service.FrameExportError) {
					return c.json(
						{ error: { message: error.message, code: error.code } },
						exportErrorStatus(error.status),
					);
				}
				throw error;
			}
		};
		if (action === "status") {
			app.get(path, requireScope("frames:read"), handler);
		} else {
			app.post(
				path,
				requireScope(
					action === "cancel" ? "frames:write" : "frames:read",
				),
				handler,
			);
		}
	}
	app.get("/frames/:id/sharing", requireScope("frames:read"), async (c) => {
		const ctx = await resolveV1Context(
			c.get("externalApiContext"),
			c.req.query("org"),
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}
		if (
			!ctx.organizationId ||
			!(await canReadOrganizationFrames(ctx.userId, ctx.organizationId))
		) {
			return c.json(notFound("Frame"), 404);
		}
		const frame = await getFrameById({
			id: c.req.param("id") ?? "",
			userId: ctx.userId,
			organizationId: ctx.organizationId,
		});
		if (!frame) {
			return c.json(notFound("Frame"), 404);
		}
		const grants = await listSharingGrants(frame.id);
		return c.json(
			ok({
				scope: frame.shareScope,
				hasPublicLink: Boolean(frame.isPublic && frame.shareToken),
				updatedAt: frame.updatedAt.toISOString(),
				grants: grants.map((g) => ({
					id: g.id,
					email: g.email,
					invitedAt: g.invitedAt.toISOString(),
				})),
			}),
		);
	});
	for (const action of ["share", "revoke-sharing"] as const) {
		app.post(
			`/frames/:id/${action}`,
			requireScope("frames:write"),
			async (c) => {
				const ctx = await resolveV1Context(
					c.get("externalApiContext"),
					c.req.query("org"),
				);
				if ("error" in ctx) {
					return c.json(
						{ error: { message: ctx.error } },
						ctx.status,
					);
				}
				if (
					!ctx.organizationId ||
					!(await (action === "revoke-sharing"
						? canDeleteOrganizationFrames(
								ctx.userId,
								ctx.organizationId,
							)
						: canUpdateOrganizationFrames(
								ctx.userId,
								ctx.organizationId,
							)))
				) {
					return c.json(
						{
							error: {
								message: "No permission to change sharing.",
							},
						},
						403,
					);
				}
				const raw = await c.req.json().catch(() => null);
				try {
					const actor = {
						frameId: c.req.param("id") ?? "",
						userId: ctx.userId,
						organizationId: ctx.organizationId,
					};
					if (action === "share") {
						const input = frameShareSchema.safeParse(raw);
						if (!input.success) {
							return c.json(
								{
									error: {
										message:
											"Provide the reviewed revision, sharing scope and valid recipients.",
									},
								},
								400,
							);
						}
						const result = await shareFrame({
							...actor,
							...input.data,
							expectedUpdatedAt: new Date(
								input.data.expectedUpdatedAt,
							),
						});
						if (!result.ok) {
							return c.json(
								{ error: { message: result.message } },
								sharingErrorStatus(result.reason),
							);
						}
						return c.json(ok(frameSharingMutationDto(result)));
					}
					const input = frameRevokeSharingSchema.safeParse(raw);
					if (!input.success) {
						return c.json(
							{
								error: {
									message:
										"Provide the reviewed revision and one valid revoke mode.",
								},
							},
							400,
						);
					}
					const result = await revokeFrameSharing({
						...actor,
						...input.data,
						expectedUpdatedAt: new Date(
							input.data.expectedUpdatedAt,
						),
					});
					if (!result.ok) {
						return c.json(
							{ error: { message: result.message } },
							sharingErrorStatus(result.reason),
						);
					}
					return c.json(ok(frameSharingMutationDto(result)));
				} catch (error) {
					if (error instanceof FrameUpdateConflictError) {
						return c.json(
							{
								error: {
									message: error.message,
									code: "CONFLICT",
								},
							},
							409,
						);
					}
					throw error;
				}
			},
		);
	}

	app.get("/frames/:id", requireScope("frames:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const id = c.req.param("id");
		if (!id) {
			return c.json(notFound("Frame"), 404);
		}
		const frame = await getFrameById({
			id,
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
		});

		if (!frame) {
			return c.json(notFound("Frame"), 404);
		}

		return c.json(ok(mapFrame(frame)));
	});
}

function exportErrorStatus(status: number): 400 | 403 | 404 | 409 | 503 {
	return status === 400 || status === 403 || status === 404 || status === 409
		? status
		: 503;
}

function sharingErrorStatus(reason: string): 400 | 403 | 404 {
	if (reason === "frame_not_found") {
		return 404;
	}
	return [
		"invalid_email",
		"invalid_revoke_mode",
		"emails_need_an_inviting_scope",
	].includes(reason)
		? 400
		: 403;
}
