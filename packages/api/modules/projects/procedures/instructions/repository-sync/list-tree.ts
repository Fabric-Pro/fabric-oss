/**
 * `projects.instructions.repositorySync.listTree` — the folders and files of
 * one branch (`ref`) of a connected repository (`repositoryIntegrationId`),
 * so the Coding Instructions configure dialog can offer its folder
 * (`rootPath`) as a selection instead of a typed path (Fizzy #2725, after
 * Living Memory's Fizzy #2674). The input takes `configure`'s field names
 * and shapes, so the dialog reuses the state it configures with.
 *
 * Authorization, in order: `projectNotFoundUnlessVisible`, then
 * INSTRUCTION_CREATE (`configure`'s permission), then the hosting
 * organization resolved server-side (`requireHostingOrganizationId`); any
 * `organizationId` in the input is ignored.
 *
 * Visibility applies here although `configure` and `get` do not compose it.
 * The permission gate's org-role fallback admits a host-organization member
 * with no ProjectMember row who did not create the project — someone
 * `hasProjectAccess` would not let discover it. `configure`'s branch check
 * tells such a member only whether one branch exists; this listing spends the
 * project's credential and returns the private repository's whole folder and
 * file structure, a same-organization cross-project disclosure. Browsing is
 * therefore limited to what the caller can see, and answered NOT_FOUND in
 * the words a missing project gets otherwise. A member `configure` admits
 * without visibility can still type the folder.
 *
 * The write permission, not INSTRUCTION_READ: the read spends the
 * integration's own credential against the customer's provider, the same
 * reason the Living Memory listing sits behind CONTEXT_CREATE, and only a
 * member who could configure has a use for it.
 *
 * The integration is refused exactly as `configure` refuses it
 * (`./repository`), and a failed read throws `configure`'s errors for the
 * same outcome, so the dialog's copy applies unchanged; a failure is never
 * an empty listing. GitLab, or any provider `@repo/connectors` cannot list
 * (`isRepositoryTreeProvider`), has no listing: that is a typed
 * `supported: false`, not an error, answered right after the integration
 * loads and before any credential is resolved, and the dialog keeps the
 * typed folder.
 *
 * Only entries whose path `configure` would accept as a `rootPath` are
 * returned (`normalizeRootPath` in `./repository`, in the spelling it
 * stores, within the input's length bound). A rejected folder is dropped
 * WITH its descendants, even those that would pass alone, so the tree never
 * shows a folder's contents without the folder. Files are returned for
 * orientation only — a member can see where CLAUDE.md or AGENTS.md live —
 * and the dialog does not let one be chosen. A file the listing marks
 * `regular: false` (a symbolic link, which the sync never reads) keeps the
 * marker, so the dialog's exclusion preview shows it as skipped (Fizzy
 * #2726).
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
import { requireHostingOrganizationId } from "../hosting-organization";
import {
	instructionSyncRefSchema,
	loadInstructionSyncIntegration,
	MAX_INSTRUCTION_SYNC_ROOT_PATH_LENGTH,
	normalizeRootPath,
	repositoryReadError,
	resolveInstructionSyncCredential,
} from "./repository";

/**
 * `path` is one `configure` would store as a `rootPath` exactly as spelled:
 * not the repository root (the dialog offers that itself), within the
 * input's length bound, and unchanged by `normalizeRootPath`.
 */
function isRootPathSpelling(path: string): boolean {
	return (
		path !== "" &&
		path.length <= MAX_INSTRUCTION_SYNC_ROOT_PATH_LENGTH &&
		normalizeRootPath(path) === path
	);
}

/**
 * The entries whose path, and every ancestor folder's path, passes
 * `isRootPathSpelling`: a rejected folder takes its descendants with it,
 * whether or not the provider listed the folder itself.
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
			isRootPathSpelling(path) &&
			(slash === -1 || selectable(path.slice(0, slash)));
		verdicts.set(path, verdict);
		return verdict;
	};
	return entries.filter((entry) => selectable(entry.path));
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_CREATE).
 */
export const listInstructionRepositoryTreeProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/repository-sync/tree",
		tags: ["Projects", "Instructions"],
		summary: "List a repository branch's folders and files for the sync",
	})
	.input(
		z.object({
			// `configure`'s field names and shapes: the dialog passes the
			// same state to both.
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			repositoryIntegrationId: z.string().min(1),
			ref: instructionSyncRefSchema,
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
			const organizationId = await requireHostingOrganizationId(
				input.projectId,
				context.user.id,
			);

			const integration = await loadInstructionSyncIntegration({
				repositoryIntegrationId: input.repositoryIntegrationId,
				projectId: input.projectId,
			});
			// Answered from the provider alone: no token is resolved for a
			// listing that cannot happen.
			if (!isRepositoryTreeProvider(integration.provider)) {
				return { supported: false, entries: [], truncated: false };
			}
			const { token, refreshFault } =
				await resolveInstructionSyncCredential(integration, {
					userId: context.user.id,
					organizationId,
				});
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
						"Couldn't reach the repository to list its folders. Try again.",
				});
			}
			return {
				supported: true,
				entries: selectableEntries(result.entries),
				truncated: result.truncated,
			};
		},
	);
