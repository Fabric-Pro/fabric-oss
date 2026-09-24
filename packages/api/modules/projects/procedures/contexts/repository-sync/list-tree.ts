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
 * Only selectable entries are returned: each entry, folder or file, must
 * pass `configure`'s own per-path rule (`contextSyncPathSelectable` in
 * `./paths`: length, canonical spelling, no `.fabric` segment, no excluded
 * basename). A rejected folder is dropped WITH its descendants, even those
 * that would pass alone, so the tree never shows a folder's contents
 * without the folder. Files are not filtered by extension:
 * that rule lives in `@repo/temporal`'s `context-sync-rules.ts`, which this
 * package does not reach into; a selected folder's non-text files are left
 * out by the run.
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
import { contextSyncPathSelectable } from "./paths";
import {
	contextSyncRefSchema,
	loadContextSyncIntegration,
	repositoryReadError,
	resolveContextSyncCredential,
} from "./repository";

/**
 * The entries whose path, and every ancestor folder's path, passes
 * `contextSyncPathSelectable`: a rejected folder takes its descendants
 * with it, whether or not the provider listed the folder itself.
 */
function selectableEntries(
	entries: readonly RepositoryTreeEntry[],
): RepositoryTreeEntry[] {
	const verdicts = new Map<string, boolean>();
	const selectable = (path: string): boolean => {
		const known = verdicts.get(path);
		if (known !== undefined) {
			return known;
		}
		const slash = path.lastIndexOf("/");
		const verdict =
			contextSyncPathSelectable(path).ok &&
			(slash === -1 || selectable(path.slice(0, slash)));
		verdicts.set(path, verdict);
		return verdict;
	};
	return entries.filter((entry) => selectable(entry.path));
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
			entries: RepositoryTreeEntry[];
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
				entries: selectableEntries(result.entries),
				truncated: result.truncated,
			};
		},
	);
