/**
 * `projects.instructions.repositorySync.readIgnoreFile` — the rules of the
 * `.fabricignore` at a folder (`rootPath`) of one branch (`ref`) of a
 * connected repository (`repositoryIntegrationId`), so the Coding
 * Instructions configure dialog can show what a sync of that folder will
 * skip (Fizzy #2726). A `.fabricignore` with at least one rule REPLACES the
 * project's ignore rules in the sync (`resolveIgnoreGlobs`), so the dialog
 * cannot say what is excluded, or offer to change it, without reading it.
 * The input takes `listTree`'s field names and shapes plus `configure`'s
 * `rootPath`, so the dialog reuses the state it configures with.
 *
 * Authorization, in order, exactly as `listTree`: `projectNotFoundUnlessVisible`,
 * then INSTRUCTION_CREATE (`configure`'s permission), then the hosting
 * organization resolved server-side (`requireHostingOrganizationId`); any
 * `organizationId` in the input is ignored. Visibility first for the same
 * reason as `listTree`: this spends the project's credential and returns the
 * CONTENT of a file in the private repository, which a host-organization
 * member the org-role fallback admits without seeing the project must not
 * read. Answered NOT_FOUND in the words a missing project gets otherwise.
 *
 * `rootPath` is checked as `configure` checks it (`normalizeRootPath`,
 * INVALID_ROOT_PATH), and only the exact root-level `.fabricignore` of that
 * folder is read — the one file the sync applies, and only as a regular
 * file: the sync keeps no folder, submodule or symbolic link, so one of
 * those at that path is `absent` here (`readRepositoryFile`). The integration is refused
 * exactly as `configure` refuses it (`./repository`), and a failed read
 * throws `configure`'s errors for the same outcome; a failure is never an
 * absent file. GitLab, or any provider `@repo/connectors` cannot read
 * (`isRepositoryTreeProvider`), is a typed `supported: false`, answered
 * right after the integration loads and before any credential is resolved.
 *
 * At most `MAX_FABRICIGNORE_BYTES` are read, the limit the sync reads the
 * blob with: a longer file is `tooLarge`, which the sync drops, so its rules
 * are never returned. The rules are parsed here by the sync's own
 * `parseFabricIgnore`; a file that parses to no rules is `state: "rules"`
 * with none, which the sync treats as no file at all.
 *
 * Not audited: it returns the rules of one file the sync of this folder
 * would read anyway and writes nothing — as `listTree` is not. Not cached:
 * every call reads the provider live.
 */
import { ORPCError } from "@orpc/client";
import { isRepositoryTreeProvider, readRepositoryFile } from "@repo/connectors";
import {
	FABRIC_IGNORE_FILE,
	MAX_FABRICIGNORE_BYTES,
	parseFabricIgnore,
} from "@repo/instructions";
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

type ReadIgnoreFileResult = {
	supported: boolean;
	state: "absent" | "rules" | "tooLarge";
	rules: string[];
};

const UNSUPPORTED: ReadIgnoreFileResult = {
	supported: false,
	state: "absent",
	rules: [],
};

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_CREATE).
 */
export const readInstructionRepositoryIgnoreFileProcedure =
	tenantProtectedProcedure
		// Visibility before permission: see the file comment.
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
		.route({
			method: "GET",
			path: "/projects/:projectId/instructions/repository-sync/ignore-file",
			tags: ["Projects", "Instructions"],
			summary:
				"Read a repository folder's .fabricignore rules for the sync",
		})
		.input(
			z.object({
				// `listTree`'s and `configure`'s field names and shapes: the
				// dialog passes the same state to all three.
				projectId: z.string(),
				organizationId: z.string().nullable().optional(),
				repositoryIntegrationId: z.string().min(1),
				ref: instructionSyncRefSchema,
				rootPath: z.string().max(MAX_INSTRUCTION_SYNC_ROOT_PATH_LENGTH),
			}),
		)
		.handler(async ({ input, context }): Promise<ReadIgnoreFileResult> => {
			const organizationId = await requireHostingOrganizationId(
				input.projectId,
				context.user.id,
			);
			const rootPath = normalizeRootPath(input.rootPath);
			if (rootPath === null) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"The folder must be a relative path inside the repository.",
					data: { code: "INVALID_ROOT_PATH" },
				});
			}

			const integration = await loadInstructionSyncIntegration({
				repositoryIntegrationId: input.repositoryIntegrationId,
				projectId: input.projectId,
			});
			// Answered from the provider alone: no token is resolved for a
			// read that cannot happen.
			if (!isRepositoryTreeProvider(integration.provider)) {
				return UNSUPPORTED;
			}
			const { token, refreshFault } =
				await resolveInstructionSyncCredential(integration, {
					userId: context.user.id,
					organizationId,
				});
			const result = await readRepositoryFile({
				provider: integration.provider,
				token,
				repositoryUrl: integration.repositoryUrl,
				owner: integration.repositoryOwner,
				repo: integration.repositoryName,
				azureOrganization: integration.azureOrganization,
				branch: input.ref,
				// Only the exact root-level file counts, as in the sync.
				path:
					rootPath === ""
						? FABRIC_IGNORE_FILE
						: `${rootPath}/${FABRIC_IGNORE_FILE}`,
				maxBytes: MAX_FABRICIGNORE_BYTES,
			});
			if (!result.ok) {
				if (result.outcome === "unsupported") {
					return UNSUPPORTED;
				}
				throw repositoryReadError(result.outcome, {
					ref: input.ref,
					refreshFault,
					unreachableMessage:
						"Couldn't reach the repository to read its .fabricignore file. Try again.",
				});
			}
			if (result.state === "found") {
				return {
					supported: true,
					state: "rules",
					rules: parseFabricIgnore(result.text),
				};
			}
			return { supported: true, state: result.state, rules: [] };
		});
