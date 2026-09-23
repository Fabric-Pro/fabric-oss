/**
 * v1 Synced context files (Fizzy #2618, #2636)
 *
 *   PUT    /projects/:projectId/contexts/synced-files   push one text file by its path
 *                                                      (or move it, `movedFromSourcePath`)
 *   DELETE /projects/:projectId/contexts/synced-files   delete one, in the version named
 *
 * The key-backed twin of `projects.contexts.upsertSyncedFile`. That procedure
 * is a `tenantProtectedProcedure`, whose chain authenticates through
 * `auth.api.getSession` — a Better Auth session cookie, with no API-key or
 * bearer plugin configured — so no API key can reach it, and `fabric context
 * push` would have had nothing to call. The MCP gateway's
 * `fabric_upsert_project_context` needs an MCP client the CLI does not have.
 * All three surfaces call the same `upsertSyncedContext`, which owns the
 * validation, the write, the embed and the audit row; the DELETE and its
 * session twin `projects.contexts.deleteSyncedFile` call the same
 * `deleteSyncedContext`. This file is authorization and the wire contract
 * only.
 *
 * ## Two gates, as every key-backed surface owes (AGENTS.md)
 *
 *  1. The key's declared scope: `projects:write`, checked by `requireScope`
 *     at the route. The same scope `fabric_upsert_project_context` demands
 *     (`TOOL_SCOPES` in the gateway), from the same catalog
 *     (`ORG_API_KEY_SCOPES`), and absent from what a read-only role may mint.
 *     A refusal is the middleware's flat `{ error: "Missing required scope:
 *     projects:write" }`.
 *  2. The key creator's LIVE permission on the project — `CONTEXT_CREATE`
 *     to push, `CONTEXT_DELETE` to delete, as the Context tab asks — re-checked
 *     on every call — a wildcard `*` key included, since `hasScope` waves `*`
 *     through the first gate — through the same resolver the oRPC twins'
 *     `requireProjectPermission` uses. A refusal is the nested
 *     `{ error: { message } }`, so a scope problem and a permission problem
 *     never read as each other.
 *
 * ## The project supplies the tenant
 *
 * Exactly as the coding-instructions routes do it (`./instructions.ts`,
 * `resolveInstructionProject`), and for the same reason: an invited project
 * guest holds a `ProjectMember` row and no membership in the host
 * organization, so a membership-based `resolveV1Context` would refuse them for
 * a project they can open in the app. The write lands under the project's
 * HOSTING organization, never a caller-supplied one; an organization key must
 * be that organization's; and `?org=` still binds when it is sent.
 */
import { db, hasProjectAccess } from "@repo/database";
import { hasPermission, Permissions } from "@repo/permissions";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { resolveEffectiveProjectPermissions } from "../../lib/effective-project-permissions";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type {
	ExternalApiContext,
	ExternalApiVariables,
} from "../external-api/types";
import {
	syncedContextConflictMessage,
	syncedContextDeleteConflictMessage,
} from "../projects/lib/synced-context-conflict";
import { MAX_SYNCED_CONTEXT_BYTES } from "../projects/lib/synced-context-limits";
import { badRequest, forbidden, notFound, ok } from "./helpers";

/**
 * Bound on the path as sent, before normalising — the oRPC twin's
 * `MAX_SOURCE_PATH_INPUT_LENGTH`. The stored path is held to 512 characters
 * by `normalizeContextSourcePath`; this only keeps an unbounded string out of
 * the normaliser.
 */
const MAX_SOURCE_PATH_INPUT_LENGTH = 2048;

/**
 * The most bytes a request body may carry, refused with 413 BEFORE it is
 * parsed. The content itself is held to `MAX_SYNCED_CONTEXT_BYTES` (2 MiB of
 * UTF-8) by `upsertSyncedContext`, but only once `c.req.json()` has parsed
 * the whole body; without this bound any size of body would be read into
 * memory first.
 *
 * Sized from JSON's worst-case expansion so that no content the shared
 * function accepts is refused here: a control character other than NUL
 * (which the content rules allow) is escaped as `\u00XX`, six bytes for one,
 * so 2 MiB of content can be 12 MiB on the wire; a quote or a backslash is
 * two. Six wire bytes per content byte is the ceiling for every character:
 * a multi-byte UTF-8 character is sent as its own bytes, or, by an encoder
 * that escapes all non-ASCII, as `\uXXXX` (pairs) — at most three wire bytes
 * per content byte. The extra 64 KiB is headroom for the path (at most 2048
 * characters, escapable too), the title, the hash and the JSON punctuation.
 *
 * This is this route's own bound, not a promise that such a body arrives:
 * the hosting platform's request cap (for example a serverless function's
 * body limit) may be lower in some deployments and refuse it first.
 */
const MAX_SYNCED_FILE_BODY_BYTES = 6 * MAX_SYNCED_CONTEXT_BYTES + 64 * 1024;

/**
 * A delete's body is a path and a hash: at most 2048 characters of path,
 * escapable to six bytes each, plus 64 hex characters and punctuation.
 */
const MAX_SYNCED_FILE_DELETE_BODY_BYTES = 16 * 1024;

/** What the object-level gate asks of the key's creator, per method. */
interface RequiredContextPermission {
	permission:
		| typeof Permissions.CONTEXT_CREATE
		| typeof Permissions.CONTEXT_DELETE;
	/** The nested 403's sentence. */
	refusal: string;
}

const PUSH_PERMISSION: RequiredContextPermission = {
	permission: Permissions.CONTEXT_CREATE,
	refusal: "No permission to add context sources to this project",
};

const DELETE_PERMISSION: RequiredContextPermission = {
	permission: Permissions.CONTEXT_DELETE,
	refusal: "No permission to delete context sources from this project",
};

type ResolvedProject =
	| { error: { message: string }; status: 403 | 404 }
	| { userId: string; organizationId: string };

/**
 * The object-level gate, run after `requireScope("projects:write")` and never
 * instead of it.
 *
 * Order, and why:
 *  1. `?personal=1` is refused before any lookup: synced context files are an
 *     organization surface (`upsertSyncedContext` refuses a null tenant).
 *  2. The project and the caller's effective permissions, from the resolver
 *     the oRPC middleware uses. No project is 404.
 *  3. A project with no hosting organization is refused, as the shared
 *     function would refuse it — earlier, so nothing else is read.
 *  4. An organization key must belong to the hosting organization, and a
 *     mismatch is 404: a key must not learn that a project id exists in
 *     someone else's tenant.
 *  5. Visibility (`hasProjectAccess`). The resolver's org-role fallback
 *     grants an organization member their role's permissions on EVERY
 *     project in the organization, including ones the app hides from them;
 *     the oRPC twin and the MCP twin both refuse that caller, and so does
 *     this. 404, as the MCP twin answers it.
 *  6. The method's permission: `CONTEXT_CREATE` to push, `CONTEXT_DELETE` to
 *     delete. A personal-project owner would pass unconditionally, but step 3
 *     has already refused every personal project.
 *  7. Only then an explicit `?org=`, resolved without a membership check and
 *     compared against the hosting organization — after the permission
 *     check, so no caller without standing can use the slug as an oracle,
 *     and with one 404 for "no such slug" and "not this project's".
 */
async function resolveContextProject(
	projectId: string,
	apiCtx: ExternalApiContext,
	requested: { org?: string; personal: boolean },
	required: RequiredContextPermission,
): Promise<ResolvedProject> {
	if (requested.personal) {
		return {
			error: {
				message:
					"Synced context files are an organization surface; ?personal=1 is not supported",
			},
			status: 403,
		};
	}

	const access = await resolveEffectiveProjectPermissions(
		projectId,
		apiCtx.userId,
	);
	if (!access) {
		return { error: notFound("Project").error, status: 404 };
	}

	const hostingOrganizationId = access.organizationId;
	if (!hostingOrganizationId) {
		return {
			error: {
				message: "Synced context files require an organization project",
			},
			status: 403,
		};
	}

	if (
		apiCtx.keyType === "organization" &&
		apiCtx.organizationId !== hostingOrganizationId
	) {
		return { error: notFound("Project").error, status: 404 };
	}

	if (
		!(await hasProjectAccess(
			projectId,
			apiCtx.userId,
			hostingOrganizationId,
		))
	) {
		return { error: notFound("Project").error, status: 404 };
	}

	if (!hasPermission(access.permissions, required.permission)) {
		return { error: forbidden(required.refusal).error, status: 403 };
	}

	if (requested.org) {
		const named = await db.organization.findFirst({
			where: { slug: requested.org },
			select: { id: true },
		});
		if (!named || named.id !== hostingOrganizationId) {
			return { error: notFound("Project").error, status: 404 };
		}
	}

	return { userId: apiCtx.userId, organizationId: hostingOrganizationId };
}

interface SyncedFileBody {
	sourcePath: string;
	content: string;
	title?: string;
	expectedContentHash?: string;
	movedFromSourcePath?: string;
}

/**
 * The request body, shaped, or why it is not.
 *
 * Shape only. The semantic rules — path normalisation, the 2 MiB bound, empty
 * content, NUL, the title's characters, the hash's format — belong to
 * `upsertSyncedContext` and are not duplicated here. Anything else in the
 * body (an `organizationId`, a `userId`) is ignored: neither is ever taken
 * from the caller.
 */
function readSyncedFileBody(body: unknown): SyncedFileBody | { error: string } {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { error: "Body must be a JSON object." };
	}
	const raw = body as Record<string, unknown>;
	if (
		typeof raw.sourcePath !== "string" ||
		raw.sourcePath.length === 0 ||
		raw.sourcePath.length > MAX_SOURCE_PATH_INPUT_LENGTH
	) {
		return {
			error: `sourcePath is required: the file's path relative to the folder it was pushed from, a string of 1 to ${MAX_SOURCE_PATH_INPUT_LENGTH} characters.`,
		};
	}
	if (typeof raw.content !== "string") {
		return { error: "content is required: the file's full text." };
	}
	if (
		raw.title !== undefined &&
		raw.title !== null &&
		typeof raw.title !== "string"
	) {
		return { error: "title must be a string." };
	}
	if (
		raw.expectedContentHash !== undefined &&
		raw.expectedContentHash !== null &&
		typeof raw.expectedContentHash !== "string"
	) {
		return {
			error: "expectedContentHash must be the 'contentHash' string of the stored version.",
		};
	}
	if (
		raw.movedFromSourcePath !== undefined &&
		raw.movedFromSourcePath !== null
	) {
		if (
			typeof raw.movedFromSourcePath !== "string" ||
			raw.movedFromSourcePath.length === 0 ||
			raw.movedFromSourcePath.length > MAX_SOURCE_PATH_INPUT_LENGTH
		) {
			return {
				error: `movedFromSourcePath must be the file's previous path, a string of 1 to ${MAX_SOURCE_PATH_INPUT_LENGTH} characters.`,
			};
		}
		// A shape rule, not a semantic one: a move names the version at the
		// old path, so it is incomplete without one. The shared function
		// refuses it too, for the surfaces that do not pass through here.
		if (typeof raw.expectedContentHash !== "string") {
			return {
				error: "movedFromSourcePath requires expectedContentHash: the contentHash of the version at the old path you last saw.",
			};
		}
	}
	return {
		sourcePath: raw.sourcePath,
		content: raw.content,
		title: typeof raw.title === "string" ? raw.title : undefined,
		expectedContentHash:
			typeof raw.expectedContentHash === "string"
				? raw.expectedContentHash
				: undefined,
		movedFromSourcePath:
			typeof raw.movedFromSourcePath === "string"
				? raw.movedFromSourcePath
				: undefined,
	};
}

interface SyncedFileDeleteBody {
	sourcePath: string;
	expectedContentHash: string;
}

/**
 * A delete's body, shaped, or why it is not. Shape only, as for the push:
 * the path's rules and the hash's format belong to `deleteSyncedContext`.
 */
function readSyncedFileDeleteBody(
	body: unknown,
): SyncedFileDeleteBody | { error: string } {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { error: "Body must be a JSON object." };
	}
	const raw = body as Record<string, unknown>;
	if (
		typeof raw.sourcePath !== "string" ||
		raw.sourcePath.length === 0 ||
		raw.sourcePath.length > MAX_SOURCE_PATH_INPUT_LENGTH
	) {
		return {
			error: `sourcePath is required: the path the file was pushed under, a string of 1 to ${MAX_SOURCE_PATH_INPUT_LENGTH} characters.`,
		};
	}
	if (typeof raw.expectedContentHash !== "string") {
		return {
			error: "expectedContentHash is required: the 'contentHash' of the version you mean to delete. A delete never removes a version it does not name.",
		};
	}
	return {
		sourcePath: raw.sourcePath,
		expectedContentHash: raw.expectedContentHash,
	};
}

/**
 * The status for one of the shared functions' own refusals
 * (`upsertSyncedContext`, `deleteSyncedContext`), or `null` for anything else.
 * They signal with `ORPCError`; two codes are mapped here — BAD_REQUEST for
 * the caller's input, FORBIDDEN for a project with no organization — and
 * anything else (a Prisma or storage error, the delete's failed index
 * cleanup) propagates to the app's error handler rather than being given a
 * status it did not earn.
 */
function syncedFileRefusalStatus(error: unknown): 400 | 403 | null {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return null;
	}
	switch ((error as { code?: unknown }).code) {
		case "BAD_REQUEST":
			return 400;
		case "FORBIDDEN":
			return 403;
		default:
			return null;
	}
}

export function registerContextRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	/**
	 * PUT /projects/:projectId/contexts/synced-files
	 *
	 * PUT because it is an upsert keyed by the path in the body, and because
	 * repeating it is harmless: the same content at the same path answers
	 * `unchanged` before `expectedContentHash` is even looked at, so a retry
	 * of a request whose response was lost reports the write the first one
	 * made rather than making another.
	 *
	 * Outcomes are the shared function's: `created`, `updated`, `unchanged`
	 * and `duplicate` answer 200 with the result; `conflict` answers 409 with
	 * the result under `error.data` — the stored version's hash, when it
	 * changed and who changed it, never its content — so a client can show
	 * who it lost to and, if it means to, replace that exact version. A
	 * named hash on a path that no longer exists is a 409 too, with
	 * `current: null`: the file was deleted since, and sending it again
	 * without `expectedContentHash` recreates it, or answers `duplicate`
	 * instead if that content already exists elsewhere in the project.
	 *
	 * A body over `MAX_SYNCED_FILE_BODY_BYTES` answers 413 with the flat
	 * `{ error: "…" }` before anything is parsed or resolved.
	 */
	app.put(
		"/projects/:projectId/contexts/synced-files",
		requireScope("projects:write"),
		// After the scope, so a key without it still reads as a scope refusal;
		// before the handler, so nothing parses a body over the bound. A
		// declared Content-Length is refused unread; a body without one is
		// counted as it streams and refused at the first byte over.
		bodyLimit({
			maxSize: MAX_SYNCED_FILE_BODY_BYTES,
			onError: (c) =>
				c.json(
					{
						error: `Request body is too large: at most ${MAX_SYNCED_FILE_BODY_BYTES} bytes, for a file of at most 2 MiB of UTF-8.`,
					},
					413,
				),
		}),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const projectId = c.req.param("projectId");
			if (!projectId) {
				return c.json(badRequest("projectId is required"), 400);
			}

			let rawBody: unknown;
			try {
				rawBody = await c.req.json();
			} catch {
				return c.json(badRequest("Invalid JSON body"), 400);
			}
			const body = readSyncedFileBody(rawBody);
			if ("error" in body) {
				return c.json(badRequest(body.error), 400);
			}

			const resolved = await resolveContextProject(
				projectId,
				apiCtx,
				{
					org: c.req.query("org"),
					personal: c.req.query("personal") === "1",
				},
				PUSH_PERMISSION,
			);
			if ("error" in resolved) {
				return c.json({ error: resolved.error }, resolved.status);
			}

			// The audit row snapshots the actor's email and name, and a key
			// has no session to read them from.
			const actor = await db.user.findUnique({
				where: { id: resolved.userId },
				select: { email: true, name: true },
			});

			// Lazy, like the instructions write routes: the shared function
			// pulls the Temporal client and the realtime emitter, which no
			// other v1 request needs at module load.
			const { upsertSyncedContext } = await import(
				"../projects/lib/upsert-synced-context"
			);
			let result: Awaited<ReturnType<typeof upsertSyncedContext>>;
			try {
				result = await upsertSyncedContext({
					projectId,
					sourcePath: body.sourcePath,
					content: body.content,
					title: body.title,
					expectedContentHash: body.expectedContentHash,
					movedFromSourcePath: body.movedFromSourcePath,
					// The key's creator, whom every check above ran for.
					userId: resolved.userId,
					// The hosting organization, resolved from the project.
					organizationId: resolved.organizationId,
					via: "v1-api",
					request: {
						headers: c.req.raw.headers,
						user: {
							id: resolved.userId,
							email: actor?.email ?? "",
							name: actor?.name ?? null,
						},
					},
				});
			} catch (error) {
				const status = syncedFileRefusalStatus(error);
				if (status === null) {
					throw error;
				}
				const message =
					error instanceof Error ? error.message : "Request refused";
				return c.json({ error: { message } }, status);
			}

			if (result.status === "conflict") {
				return c.json(
					{
						error: {
							message: syncedContextConflictMessage(result),
							code: "CONFLICT",
							data: result,
						},
					},
					409,
				);
			}

			return c.json(ok(result));
		},
	);

	/**
	 * DELETE /projects/:projectId/contexts/synced-files   (Fizzy #2636)
	 *
	 * Body `{ sourcePath, expectedContentHash }`, both required: the file is
	 * deleted only while the path holds the version named. A JSON body on a
	 * DELETE reaches this handler intact — the app's catch-all route exports
	 * `DELETE` and hands the raw request to Hono — so the path, which may be
	 * 2048 characters, stays out of the URL and out of access logs.
	 *
	 * Outcomes are `deleteSyncedContext`'s: `deleted` and `absent` answer 200
	 * (`absent` is what a retry of a delete whose response was lost hears);
	 * `in-progress` answers 202 with `{ status: "in-progress", sourcePath }`
	 * — the deletion is still running on the server and the file may or may
	 * not be gone yet; calling again confirms it; `conflict` answers 409 with
	 * the stored version's stamp under `error.data`, as the PUT does. Same
	 * gates, same order, as the PUT, with `CONTEXT_DELETE` for
	 * `CONTEXT_CREATE`.
	 */
	app.delete(
		"/projects/:projectId/contexts/synced-files",
		requireScope("projects:write"),
		bodyLimit({
			maxSize: MAX_SYNCED_FILE_DELETE_BODY_BYTES,
			onError: (c) =>
				c.json(
					{
						error: `Request body is too large: at most ${MAX_SYNCED_FILE_DELETE_BODY_BYTES} bytes, for a path and a hash.`,
					},
					413,
				),
		}),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const projectId = c.req.param("projectId");
			if (!projectId) {
				return c.json(badRequest("projectId is required"), 400);
			}

			let rawBody: unknown;
			try {
				rawBody = await c.req.json();
			} catch {
				return c.json(badRequest("Invalid JSON body"), 400);
			}
			const body = readSyncedFileDeleteBody(rawBody);
			if ("error" in body) {
				return c.json(badRequest(body.error), 400);
			}

			const resolved = await resolveContextProject(
				projectId,
				apiCtx,
				{
					org: c.req.query("org"),
					personal: c.req.query("personal") === "1",
				},
				DELETE_PERMISSION,
			);
			if ("error" in resolved) {
				return c.json({ error: resolved.error }, resolved.status);
			}

			const actor = await db.user.findUnique({
				where: { id: resolved.userId },
				select: { email: true, name: true },
			});

			const { deleteSyncedContext } = await import(
				"../projects/lib/delete-synced-context"
			);
			let result: Awaited<ReturnType<typeof deleteSyncedContext>>;
			try {
				result = await deleteSyncedContext({
					projectId,
					sourcePath: body.sourcePath,
					expectedContentHash: body.expectedContentHash,
					userId: resolved.userId,
					organizationId: resolved.organizationId,
					via: "v1-api",
					request: {
						headers: c.req.raw.headers,
						user: {
							id: resolved.userId,
							email: actor?.email ?? "",
							name: actor?.name ?? null,
						},
					},
				});
			} catch (error) {
				const status = syncedFileRefusalStatus(error);
				if (status === null) {
					throw error;
				}
				const message =
					error instanceof Error ? error.message : "Request refused";
				return c.json({ error: { message } }, status);
			}

			if (result.status === "conflict") {
				return c.json(
					{
						error: {
							message: syncedContextDeleteConflictMessage(),
							code: "CONFLICT",
							data: result,
						},
					},
					409,
				);
			}

			if (result.status === "in-progress") {
				// Accepted, not done: the workflow is still running.
				return c.json(ok(result), 202);
			}

			return c.json(ok(result));
		},
	);
}
