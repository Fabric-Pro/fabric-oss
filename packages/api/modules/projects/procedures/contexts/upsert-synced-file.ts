/**
 * upsertSyncedFile — push a text file into a project's Context by its
 * relative path (Fizzy #2616).
 *
 * The API half of synced knowledge files; `fabric_upsert_project_context` is
 * the MCP half. Both call `upsertSyncedContext`, which owns the validation,
 * the write, the embedding and the audit row, so this file is authorization
 * and the wire contract only.
 *
 * Session only: `tenantProtectedProcedure` authenticates with a Better Auth
 * session cookie, so no API key reaches this route. The key-backed twin, which
 * `fabric context push` calls behind the `projects:write` scope, is
 * `PUT /api/v1/projects/:projectId/contexts/synced-files` in
 * `modules/v1/contexts.ts`; change the two together.
 *
 * Authorization, all answered server-side, in this order:
 *  - WHETHER the caller may see the project at all, FIRST:
 *    `projectNotFoundUnlessVisible` asks `hasProjectAccess`, the check the
 *    Context tab's create path (`create-context.ts`) and the sibling
 *    `update-context-metadata.ts` make, and answers a project the caller
 *    cannot see with NOT_FOUND in the words a missing id gets. First,
 *    because the permission gate refuses an existing project FORBIDDEN and
 *    a missing one NOT_FOUND, which would tell an outsider which ids are
 *    real in organizations they do not belong to. And needed on its own
 *    terms: the permission resolver's org-role fallback grants an
 *    organization member their org role's permissions on EVERY project in
 *    the organization, including a project they have no standing on, so an
 *    org `member` would hold CONTEXT_CREATE here on a project the app hides
 *    from them. The MCP twin refuses that caller too (not-found when the
 *    project is not visible).
 *  - WHAT the caller may do: CONTEXT_CREATE on the project, the permission
 *    the MCP tool asks for too (FORBIDDEN, to a caller who can see the
 *    project). The middleware checks it; the handler asks the same resolver
 *    again because it needs the answer's organization, and refuses on the
 *    same terms, so the two can never disagree.
 *  - WHICH organization: the project's hosting organization, from that same
 *    resolution. No caller-supplied `organizationId` is accepted: a
 *    multi-organization member's active session organization is not
 *    necessarily the project's, and a row written under the wrong one would
 *    be a context in one tenant pointing at a project in another.
 */
import { ORPCError } from "@orpc/client";
import { hasPermission, Permissions } from "@repo/permissions";
import { z } from "zod";
import { resolveEffectiveProjectPermissions } from "../../../../lib/effective-project-permissions";
import {
	PROJECT_NOT_FOUND_MESSAGE,
	projectNotFoundUnlessVisible,
} from "../../../../orpc/middleware/project-visibility";
import {
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { syncedContextConflictMessage } from "../../lib/synced-context-conflict";
import { MAX_SYNCED_CONTEXT_BYTES } from "../../lib/synced-context-limits";
import {
	MAX_SYNCED_CONTEXT_TITLE_LENGTH,
	upsertSyncedContext,
} from "../../lib/upsert-synced-context";

/**
 * Bound on the path as sent, before normalising. The stored path is held to
 * 512 characters by `normalizeContextSourcePath`; this only keeps an
 * unbounded string out of the normaliser.
 */
const MAX_SOURCE_PATH_INPUT_LENGTH = 2048;

export const upsertSyncedFileProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "PUT",
		path: "/projects/:projectId/contexts/synced-files",
		tags: ["Projects", "Contexts"],
		summary: "Create or update a synced context file by path",
		description:
			"Push a text file into the project's Context keyed by its relative path. A new path creates a source and indexes it; the same content again changes nothing; changed content replaces the stored version and re-indexes it, but only when `expectedContentHash` names the version being replaced — otherwise the call answers CONFLICT with the stored hash and who last changed it, and writes nothing. A named hash on a path that no longer exists (deleted since) is a CONFLICT with `current: null`; push again without `expectedContentHash` to recreate it, which answers `duplicate` instead if that content already exists elsewhere in the project. Content identical to another source in the project — synced or added in the Context tab — is reported as `duplicate` and not stored twice. A renamed file names its old path in `movedFromSourcePath`, with that path's hash as `expectedContentHash`: the source is renamed in place (`moved`) when it still holds that version and the content is unchanged; otherwise the answer is the ordinary one for the new path with `moveNotApplied` saying why, or a CONFLICT about the old path when it changed since.",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
			sourcePath: z
				.string()
				.min(1)
				.max(MAX_SOURCE_PATH_INPUT_LENGTH)
				.describe(
					"The file's path relative to the root of the working tree it comes from, e.g. `docs/architecture.md`. Backslashes, repeated separators and a leading `./` are normalised; absolute paths and `.`/`..` segments are refused. With the project, this is the key: pushing the same path again updates that source.",
				),
			content: z
				.string()
				.max(MAX_SYNCED_CONTEXT_BYTES)
				.refine(
					(value) =>
						Buffer.byteLength(value, "utf8") <=
						MAX_SYNCED_CONTEXT_BYTES,
					{
						message: `content is larger than ${MAX_SYNCED_CONTEXT_BYTES} bytes of UTF-8`,
					},
				)
				.describe(
					`The file's full text, at most ${MAX_SYNCED_CONTEXT_BYTES} bytes of UTF-8.`,
				),
			title: z
				.string()
				.trim()
				.min(1)
				.max(MAX_SYNCED_CONTEXT_TITLE_LENGTH)
				.optional()
				.describe(
					"How the source is named on the Context tab. Defaults to the file name.",
				),
			expectedContentHash: z
				.string()
				.regex(/^[0-9a-fA-F]{64}$/)
				.optional()
				.describe(
					"The `contentHash` of the stored version you mean to replace, from a previous response or from a CONFLICT. Omitting it means: create the source if the path is new, otherwise only accept content identical to what is stored. Omitting it never means overwrite. Required with `movedFromSourcePath`, where it names the version at the old path.",
				),
			movedFromSourcePath: z
				.string()
				.min(1)
				.max(MAX_SOURCE_PATH_INPUT_LENGTH)
				.optional()
				.describe(
					"The path this file had before it was renamed, under the same rules as `sourcePath` and different from it. The source there is renamed to `sourcePath` when it still holds the version named in `expectedContentHash` and `content` is that same version.",
				),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		const access = await resolveEffectiveProjectPermissions(
			input.projectId,
			user.id,
		);
		// Visibility was answered by `projectNotFoundUnlessVisible`; this
		// resolution is for the hosting organization, and refuses on the
		// permission gate's terms so the two can never disagree.
		if (!access) {
			throw new ORPCError("NOT_FOUND", {
				message: PROJECT_NOT_FOUND_MESSAGE,
			});
		}

		if (
			access.source !== "owner" &&
			!hasPermission(access.permissions, Permissions.CONTEXT_CREATE)
		) {
			throw new ORPCError("FORBIDDEN", {
				message: `Missing required permission: ${Permissions.CONTEXT_CREATE}`,
			});
		}

		const result = await upsertSyncedContext({
			projectId: input.projectId,
			sourcePath: input.sourcePath,
			content: input.content,
			title: input.title,
			expectedContentHash: input.expectedContentHash,
			movedFromSourcePath: input.movedFromSourcePath,
			userId: user.id,
			organizationId: access.organizationId,
			via: "web",
			request: context,
		});

		if (result.status === "conflict") {
			throw new ORPCError("CONFLICT", {
				message: syncedContextConflictMessage(result),
				data: result,
			});
		}

		return result;
	});
