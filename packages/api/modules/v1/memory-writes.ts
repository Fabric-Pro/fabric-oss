/**
 * v1 Living Memory write lane (ADR-022, phase 3)
 *
 *   GET  /projects/:projectId/memory/targets             the write folders and where they land
 *   GET  /projects/:projectId/memory/files?targetId=     the files Living Memory holds under one
 *                                                        folder, one page at a time
 *   GET  /projects/:projectId/memory/file?targetId=&path=  one of those files, with its text
 *   POST /projects/:projectId/memory/upload-urls         signed PUTs to stage file bytes
 *   POST /projects/:projectId/memory/writes              submit a write
 *   GET  /projects/:projectId/memory/writes/:writeId     the receipt of a write
 *
 * The key-backed twin of `projects.contexts.memoryWrites.*` and
 * `projects.contexts.repositorySync.writeTargets.list`, which a Better Auth
 * session reaches and an API key or an OAuth token does not. Every route calls
 * the same functions as the app's procedures and the MCP tools
 * (`../projects/lib/memory-write/*`); this file is authorization and the wire
 * contract only.
 *
 * ## Two gates, as every key-backed surface owes (AGENTS.md)
 *
 *  1. The credential's scope, `memory:write`, checked by `requireScope` on every
 *     route, reads included: there is no separate read scope, and a credential
 *     that may not write has no use for the folders. A refusal is the
 *     middleware's flat `{ error: "Missing required scope: memory:write" }`.
 *  2. The caller's LIVE permission on the project, re-checked on every call
 *     with the resolver the context routes use (`resolveContextProject`):
 *     `CONTEXT_CREATE` to write and stage, `CONTEXT_READ` to read. A refusal is
 *     the nested `{ error: { message } }`.
 *
 * The project supplies the tenant, never the request, and a credential bound to
 * one project reaches that project alone (`credentialMayReachProject`).
 *
 * A write is recorded `via: CLI`, with the OAuth client when the credential is
 * a signed-in agent (`keyId` of an OAuth credential is the client's row).
 */
import { db } from "@repo/database";
import { Permissions } from "@repo/permissions";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import {
	memoryWriteSubmitFields,
	memoryWriteUploadFilesField,
} from "../projects/lib/memory-write/memory-write-input";
import {
	getMemoryFolderFilesView,
	getMemoryFolderFileView,
	getMemoryWriteTargetsView,
	getMemoryWriteView,
	MEMORY_FOLDER_FILES_DEFAULT_PAGE,
	MEMORY_FOLDER_FILES_MAX_PAGE,
} from "../projects/lib/memory-write/memory-write-views";
import {
	type RequiredContextPermission,
	resolveContextProject,
} from "./contexts";
import { badRequest, notFound, ok } from "./helpers";

/**
 * The most bytes a submit body may carry, refused with 413 before it is parsed.
 * Inline text is held to 3 MiB by admission; the rest is the paths, the
 * message and JSON's escaping. The hosting platform's own request cap (4.5 MB)
 * may refuse a larger body first.
 */
const MAX_SUBMIT_BODY_BYTES = 4 * 1024 * 1024;

/** An upload-URL request names sizes only. */
const MAX_UPLOAD_BODY_BYTES = 16 * 1024;

const READ_PERMISSION: RequiredContextPermission = {
	permission: Permissions.CONTEXT_READ,
	refusal: "No permission to read context sources of this project",
};

const WRITE_PERMISSION: RequiredContextPermission = {
	permission: Permissions.CONTEXT_CREATE,
	refusal: "No permission to add context sources to this project",
};

const submitBodySchema = z.object(memoryWriteSubmitFields);
const uploadBodySchema = z.object({ files: memoryWriteUploadFilesField });
const filesQuerySchema = z.object({
	targetId: z.string().min(1).max(128),
	after: z.string().min(1).max(1024).optional(),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(MEMORY_FOLDER_FILES_MAX_PAGE)
		.default(MEMORY_FOLDER_FILES_DEFAULT_PAGE),
});
const fileQuerySchema = z.object({
	targetId: z.string().min(1).max(128),
	path: z.string().min(1).max(1024),
});

type MemoryContext = Context<{ Variables: ExternalApiVariables }>;

function tooLarge(limit: number) {
	return (c: MemoryContext) =>
		c.json(
			{
				error: {
					message: `Request body is too large: at most ${limit} bytes. Stage larger files with upload-urls and name them in the write.`,
				},
			},
			413,
		);
}

/** The project, gated for `required`, or the refusal to answer with. */
async function gate(c: MemoryContext, required: RequiredContextPermission) {
	const projectId = c.req.param("projectId") ?? "";
	const resolved = await resolveContextProject(
		projectId,
		c.get("externalApiContext"),
		{ org: c.req.query("org"), personal: c.req.query("personal") === "1" },
		required,
	);
	if ("error" in resolved) {
		return {
			ok: false as const,
			response: c.json({ error: resolved.error }, resolved.status),
		};
	}
	return { ok: true as const, projectId, ...resolved };
}

async function readJson(c: MemoryContext): Promise<unknown | undefined> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}

export function registerMemoryWriteRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	const base = "/projects/:projectId/memory";

	/** The write folders, the branch and repository they land in, and the commit the sync last applied. */
	app.get(`${base}/targets`, requireScope("memory:write"), async (c) => {
		const gated = await gate(c, READ_PERMISSION);
		if (!gated.ok) {
			return gated.response;
		}
		return c.json(
			ok(
				await getMemoryWriteTargetsView({
					projectId: gated.projectId,
					organizationId: gated.organizationId,
				}),
			),
		);
	});

	/**
	 * What Living Memory holds under one folder: path, blob id, content hash and
	 * size per file, with the commit the listing reflects. Paged by path
	 * (`after` is the previous page's `nextCursor`).
	 */
	app.get(`${base}/files`, requireScope("memory:write"), async (c) => {
		const gated = await gate(c, READ_PERMISSION);
		if (!gated.ok) {
			return gated.response;
		}
		const query = filesQuerySchema.safeParse(c.req.query());
		if (!query.success) {
			return c.json(
				badRequest(
					`targetId is required; limit is 1 to ${MEMORY_FOLDER_FILES_MAX_PAGE}.`,
				),
				400,
			);
		}
		const view = await getMemoryFolderFilesView({
			projectId: gated.projectId,
			organizationId: gated.organizationId,
			targetId: query.data.targetId,
			after: query.data.after ?? null,
			limit: query.data.limit,
		});
		if (!view) {
			return c.json(notFound("Write folder"), 404);
		}
		return c.json(ok(view));
	});

	/** One file under a folder, with its text. */
	app.get(`${base}/file`, requireScope("memory:write"), async (c) => {
		const gated = await gate(c, READ_PERMISSION);
		if (!gated.ok) {
			return gated.response;
		}
		const query = fileQuerySchema.safeParse(c.req.query());
		if (!query.success) {
			return c.json(badRequest("targetId and path are required."), 400);
		}
		const view = await getMemoryFolderFileView({
			projectId: gated.projectId,
			organizationId: gated.organizationId,
			...query.data,
		});
		if (!view) {
			return c.json(notFound("File"), 404);
		}
		return c.json(ok(view));
	});

	/** Signed PUTs for file bytes too large to send inline. */
	app.post(
		`${base}/upload-urls`,
		requireScope("memory:write"),
		bodyLimit({
			maxSize: MAX_UPLOAD_BODY_BYTES,
			onError: tooLarge(MAX_UPLOAD_BODY_BYTES),
		}),
		async (c) => {
			const gated = await gate(c, WRITE_PERMISSION);
			if (!gated.ok) {
				return gated.response;
			}
			const body = uploadBodySchema.safeParse(await readJson(c));
			if (!body.success) {
				return c.json(
					badRequest(
						"files is required: 1 to 50 objects, each with the size of the file in bytes.",
					),
					400,
				);
			}
			// Lazy, like the context routes: storage is no other v1 request's
			// module-load cost.
			const { createMemoryWriteUploadUrls } = await import(
				"../projects/lib/memory-write/create-memory-write-upload-urls"
			);
			const result = await createMemoryWriteUploadUrls({
				projectId: gated.projectId,
				files: body.data.files,
			});
			if (!result) {
				return c.json(
					{
						error: {
							message:
								"Storage provider does not support presigned uploads",
						},
					},
					412,
				);
			}
			return c.json(ok(result));
		},
	);

	/**
	 * Submit a write. 202: the write is admitted and a workflow commits it or
	 * opens a pull request; read the receipt for the outcome. A request that
	 * cannot be admitted is 400 with every problem in `error.data.problems`, and a
	 * request the member already has in flight or landed answers its receipt
	 * with `deduplicated: true`.
	 */
	app.post(
		`${base}/writes`,
		requireScope("memory:write"),
		bodyLimit({
			maxSize: MAX_SUBMIT_BODY_BYTES,
			onError: tooLarge(MAX_SUBMIT_BODY_BYTES),
		}),
		async (c) => {
			const gated = await gate(c, WRITE_PERMISSION);
			if (!gated.ok) {
				return gated.response;
			}
			const body = submitBodySchema.safeParse(await readJson(c));
			if (!body.success) {
				return c.json(
					badRequest(
						"targetId, message and entries (1 to 50) are required; each entry has a path and an op of PUT or DELETE.",
					),
					400,
				);
			}

			const apiContext = c.get("externalApiContext");
			const actor = await db.user.findUnique({
				where: { id: gated.userId },
				select: { email: true, name: true },
			});
			// Lazy: admission pulls the Temporal client, which no other v1
			// request needs at module load.
			const { submitMemoryWriteRequest } = await import(
				"../projects/lib/memory-write/submit-memory-write-request"
			);
			const result = await submitMemoryWriteRequest({
				projectId: gated.projectId,
				organizationId: gated.organizationId,
				userId: gated.userId,
				via: "CLI",
				oauthClientId:
					apiContext.keyType === "oauth" ? apiContext.keyId : null,
				...body.data,
				audit: {
					headers: c.req.raw.headers,
					user: {
						id: gated.userId,
						email: actor?.email ?? "",
						name: actor?.name ?? null,
					},
				},
			});
			switch (result.kind) {
				case "refused":
					return c.json(
						{
							error: {
								message:
									"This write cannot be admitted. Every problem is in data.problems.",
								code: "MEMORY_WRITE_REFUSED",
								data: { problems: result.problems },
							},
						},
						400,
					);
				case "too-many-pending":
					return c.json(
						{
							error: {
								message: `At most ${result.limit} of your writes can be pending in a project. Wait for one to finish.`,
								code: "TOO_MANY_PENDING_WRITES",
								data: { limit: result.limit },
							},
						},
						429,
					);
				case "start-failed":
					return c.json(
						{
							error: {
								message:
									"The write could not be started. Try again.",
								code: "WORKFLOW_START_FAILED",
							},
						},
						503,
					);
				case "accepted":
					return c.json(
						ok({
							writeId: result.writeId,
							status: result.status,
							digest: result.digest,
							deduplicated: result.deduplicated,
						}),
						202,
					);
				default: {
					const unreachable: never = result;
					return unreachable;
				}
			}
		},
	);

	/** The receipt of a write: its status and, once settled, how it ended. */
	app.get(
		`${base}/writes/:writeId`,
		requireScope("memory:write"),
		async (c) => {
			const gated = await gate(c, READ_PERMISSION);
			if (!gated.ok) {
				return gated.response;
			}
			const view = await getMemoryWriteView({
				writeId: c.req.param("writeId") ?? "",
				projectId: gated.projectId,
				organizationId: gated.organizationId,
			});
			if (!view) {
				return c.json(notFound("Write"), 404);
			}
			return c.json(ok(view));
		},
	);
}
