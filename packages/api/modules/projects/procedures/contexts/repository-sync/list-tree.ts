/**
 * `projects.contexts.repositorySync.listTree` — the folders and files of one
 * branch (`ref`) of a connected repository (`repositoryIntegrationId`), so
 * the configure dialog can offer them as selections instead of typed paths
 * (Fizzy #2674). The input takes `configure`'s field names and shapes, so
 * the dialog reuses the state it configures with.
 *
 * Authorization, in order: `projectNotFoundUnlessVisible`, then
 * CONTEXT_CREATE, then the hosting organization resolved server-side
 * (`resolveContextSyncAccess`); any `organizationId` in the input is
 * ignored. The write permission, not CONTEXT_READ: the read spends the
 * integration's own credential against the customer's provider, the same
 * reason `read-pull-request.ts` sits behind its surface's write permission,
 * and only a member who could configure has a use for the listing.
 *
 * The integration is refused exactly as `configure` refuses it (`./repository`),
 * and a failed read throws `configure`'s errors for the same outcome, so the
 * dialog's copy applies unchanged; a failure is never an empty listing.
 * GitLab, or any provider `@repo/connectors` cannot list
 * (`isRepositoryTreeProvider`), has no listing: that is a typed
 * `supported: false`, not an error, answered right after the integration
 * loads and before any credential is resolved, and the dialog keeps typed
 * paths.
 *
 * EVERY entry the provider listed is returned, in its order (Fizzy #2750
 * §5.7): the dialog shows rows that will never sync with the reason, rather
 * than hiding them. Each entry is the provider's `{ path, type, regular? }`
 * plus `configure`'s own verdict on its path in the two roles a tree row
 * can play, each ABSENT when `configure` would accept the path in that role:
 *
 *  - `selectRefusal`: why `configure` would refuse the path as a selected
 *    path (`contextSyncPathSelectable`): `INVALID_PATH` (too long, or not
 *    its own canonical spelling) or `EXCLUDED_PATH` (a `.fabric` segment, or
 *    a coding-instructions basename — `configure` cannot tell a file from a
 *    folder, so a folder named `AGENTS.md` is refused too, while a file
 *    inside it is judged by its own basename);
 *  - `excludeRefusal`: why `configure` would refuse it as a left-out path
 *    (`contextSyncExcludedPathAllowed`): `INVALID_PATH`, `EXCLUDED_PATH` (a
 *    `.fabric` segment) or `EXCLUDED_PATH_POLICY_FILE` (a `.contextignore`).
 *    A coding-instructions file may be left out (a no-op).
 *
 * Each entry is judged by its own path alone. Whether it would actually
 * sync — the defaults applied relative to the folder that owns it, the text
 * extensions, symbolic links — is the dialog's call, made with the rules
 * the run itself uses (`@repo/instructions/context-sync-rules`), and so is
 * whether a row sits inside a selected or left-out folder.
 *
 * Not audited: it returns structure, not content, and writes nothing — as
 * `configure`'s own branch check is not audited apart from the write it
 * guards. Not cached: every call reads the provider live.
 */
import {
	isRepositoryTreeProvider,
	listRepositoryTree,
	type RepositoryTreeEntry,
} from "@repo/connectors";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { resolveContextSyncAccess } from "./access";
import {
	contextSyncExcludedPathAllowed,
	contextSyncPathSelectable,
} from "./paths";
import {
	contextSyncRefSchema,
	loadContextSyncIntegration,
	repositoryReadError,
	resolveContextSyncCredential,
} from "./repository";

/** One listed entry, with `configure`'s verdict on its path (file comment). */
export type ContextRepositoryTreeEntry = RepositoryTreeEntry & {
	/** Absent when the path may be selected. */
	selectRefusal?: "INVALID_PATH" | "EXCLUDED_PATH";
	/** Absent when the path may be left out. */
	excludeRefusal?:
		| "INVALID_PATH"
		| "EXCLUDED_PATH"
		| "EXCLUDED_PATH_POLICY_FILE";
};

/** Every entry, each with the verdicts its own path earns. */
function withPathVerdicts(
	entries: readonly RepositoryTreeEntry[],
): ContextRepositoryTreeEntry[] {
	return entries.map((entry) => {
		const select = contextSyncPathSelectable(entry.path);
		const exclude = contextSyncExcludedPathAllowed(entry.path);
		return {
			...entry,
			...(select.ok ? {} : { selectRefusal: select.code }),
			...(exclude.ok ? {} : { excludeRefusal: exclude.code }),
		};
	});
}

export const listContextRepositoryTreeProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "GET",
		path: "/projects/:projectId/contexts/repository-sync/tree",
		tags: ["Projects", "Contexts"],
		summary: "List a repository branch's folders and files for the sync",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
			organizationId: z.string().nullable().optional(),
			// `configure`'s field names and shapes: the dialog passes the
			// same state to both.
			repositoryIntegrationId: z.string().min(1).max(128),
			ref: contextSyncRefSchema,
		}),
	)
	.handler(
		async ({
			input,
			context,
		}): Promise<{
			supported: boolean;
			entries: ContextRepositoryTreeEntry[];
			truncated: boolean;
		}> => {
			const { organizationId } = await resolveContextSyncAccess(
				input.projectId,
				context.user.id,
				Permissions.CONTEXT_CREATE,
			);

			const integration = await loadContextSyncIntegration({
				repositoryIntegrationId: input.repositoryIntegrationId,
				projectId: input.projectId,
			});
			// Answered from the provider alone: no token is resolved for a
			// listing that cannot happen.
			if (!isRepositoryTreeProvider(integration.provider)) {
				return { supported: false, entries: [], truncated: false };
			}
			const { token, refreshFault } = await resolveContextSyncCredential(
				integration,
				{ userId: context.user.id, organizationId },
			);
			const result = await listRepositoryTree({
				provider: integration.provider,
				token,
				repositoryUrl: integration.repositoryUrl,
				owner: integration.repositoryOwner,
				repo: integration.repositoryName,
				azureOrganization: integration.azureOrganization,
				branch: input.ref,
			});
			if (!result.ok) {
				if (result.outcome === "unsupported") {
					return { supported: false, entries: [], truncated: false };
				}
				throw repositoryReadError(result.outcome, {
					ref: input.ref,
					refreshFault,
					unreachableMessage:
						"Couldn't reach the repository to list its files. Try again.",
				});
			}
			return {
				supported: true,
				entries: withPathVerdicts(result.entries),
				truncated: result.truncated,
			};
		},
	);
