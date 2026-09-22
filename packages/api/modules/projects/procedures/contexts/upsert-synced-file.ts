/**
 * upsertSyncedFile — push a text file into a project's Context by its
 * relative path (Fizzy #2616).
 *
 * The API half of synced knowledge files; `fabric_upsert_project_context` is
 * the MCP half. Both call `upsertSyncedContext`, which owns the validation,
 * the write, the embedding and the audit row, so this file is authorization
 * and the wire contract only.
 *
 * Authorization, all answered server-side:
 *  - WHETHER the caller may see the project at all: `hasProjectAccess`, the
 *    check the Context tab's create path (`create-context.ts`) and the
 *    sibling `update-context-metadata.ts` make. The permission resolver
 *    alone is not enough: its org-role fallback grants an organization
 *    member their org role's permissions on EVERY project in the
 *    organization, including a project they have no standing on, so an org
 *    `member` would hold CONTEXT_CREATE here on a project the app hides from
 *    them. The MCP twin refuses that caller too (not-found when the project
 *    is not visible).
 *  - WHAT the caller may do: CONTEXT_CREATE on the project, the permission
 *    the MCP tool asks for too. The middleware checks it; the handler asks
 *    the same resolver again because it needs the answer's organization, and
 *    refuses on the same terms, so the two can never disagree.
 *  - WHICH organization: the project's hosting organization, from that same
 *    resolution. No caller-supplied `organizationId` is accepted: a
 *    multi-organization member's active session organization is not
 *    necessarily the project's, and a row written under the wrong one would
 *    be a context in one tenant pointing at a project in another.
 */
import { ORPCError } from "@orpc/client";
import { hasProjectAccess } from "@repo/database";
import { hasPermission, Permissions } from "@repo/permissions";
import { z } from "zod";
import { resolveEffectiveProjectPermissions } from "../../../../lib/effective-project-permissions";
import {
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	MAX_SYNCED_CONTEXT_BYTES,
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
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "PUT",
		path: "/projects/:projectId/contexts/synced-files",
		tags: ["Projects", "Contexts"],
		summary: "Create or update a synced context file by path",
		description:
			"Push a text file into the project's Context keyed by its relative path. A new path creates a source and indexes it; the same content again changes nothing; changed content replaces the stored version and re-indexes it, but only when `expectedContentHash` names the version being replaced — otherwise the call answers CONFLICT with the stored hash and who last changed it, and writes nothing. Content identical to another synced source in the project is reported as `duplicate` and not stored twice.",
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
					"The `contentHash` of the stored version you mean to replace, from a previous response or from a CONFLICT. Omitting it means: create the source if the path is new, otherwise only accept content identical to what is stored. Omitting it never means overwrite.",
				),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		const access = await resolveEffectiveProjectPermissions(
			input.projectId,
			user.id,
		);
		if (!access) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		// Project access — required because the permission resolver's
		// org-role fallback grants org permissions on projects the caller
		// cannot see. Same check, same refusal, as update-context-metadata.
		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			access.organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
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
			userId: user.id,
			organizationId: access.organizationId,
			via: "web",
			request: context,
		});

		if (result.status === "conflict") {
			throw new ORPCError("CONFLICT", {
				message:
					"This file was changed by someone else since the version you are replacing. Nothing was written: read the stored version, merge, and push again with its contentHash as expectedContentHash.",
				data: result,
			});
		}

		return result;
	});
