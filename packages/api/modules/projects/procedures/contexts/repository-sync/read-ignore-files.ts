/**
 * `projects.contexts.repositorySync.readIgnoreFiles` — the `.contextignore`
 * of each ticked folder (`folders`) of one branch (`ref`) of a connected
 * repository (`repositoryIntegrationId`), so the Living Memory configure
 * dialog can show what a sync of those folders will skip, and count it, the
 * way the Coding Instructions dialog reads a folder's `.fabricignore`
 * (`instructions/repository-sync/read-ignore-file.ts`). The input takes
 * `listTree`'s field names and shapes, so the dialog reuses the state it
 * configures with.
 *
 * Authorization, in order, exactly as `listTree`: `projectNotFoundUnlessVisible`,
 * then CONTEXT_CREATE, then the hosting organization resolved server-side
 * (`resolveContextSyncAccess`); any `organizationId` in the input is ignored.
 * Visibility first: this spends the project's credential and returns the
 * CONTENT of files in the private repository, which a host-organization
 * member the org-role fallback admits without seeing the project must not
 * read.
 *
 * Each folder is a path `configure` would accept in its spelling
 * (`contextSyncPathSpellingProblem`; `""` is the whole repository), at most
 * `MAX_CONTEXT_SYNC_PATHS` of them, and only the exact `F/.contextignore` is
 * read — the one file the run applies as F's policy. Each answer follows the
 * run's own reading (`readIgnorePolicies` in `@repo/temporal`):
 *
 *  - `absent`: no regular file there (the provider reports a folder, a
 *    submodule or a symbolic link at that path as absent; the dialog tells
 *    those apart from its listing, where the run protects the folder);
 *  - `rules`: at most `MAX_CONTEXT_IGNORE_BYTES` of UTF-8 text, returned as
 *    written, since gitignore semantics need the text, not parsed rules;
 *  - `tooLarge` and `encoding`: a policy the run cannot evaluate, so it
 *    protects the folder; the text is never returned;
 *  - `ruleRejected`: a rule `findContextIgnoreProblem` refuses, on `line`,
 *    which fails the run; the text is never returned.
 *
 * The integration is refused exactly as `configure` refuses it
 * (`./repository`), and a failed read throws `configure`'s errors for the
 * same outcome; a failure is never an absent file. A provider
 * `@repo/connectors` cannot read (`isRepositoryTreeProvider`) is a typed
 * `supported: false`, answered right after the integration loads and before
 * any credential is resolved.
 *
 * Not audited: it returns files the sync of these folders reads anyway and
 * writes nothing — as `listTree` is not. Not cached: every call reads the
 * provider live, a few files at a time.
 */
import { ORPCError } from "@orpc/client";
import { isRepositoryTreeProvider, readRepositoryFile } from "@repo/connectors";
import {
	CONTEXT_IGNORE_FILENAME,
	contextSyncPathSpellingProblem,
	decodeContextIgnore,
	findContextIgnoreProblem,
	MAX_CONTEXT_IGNORE_BYTES,
	MAX_CONTEXT_SYNC_PATH_LENGTH,
} from "@repo/instructions/context-sync-rules";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { resolveContextSyncAccess } from "./access";
import { MAX_CONTEXT_SYNC_PATHS } from "./paths";
import {
	contextSyncRefSchema,
	loadContextSyncIntegration,
	repositoryReadError,
	resolveContextSyncCredential,
} from "./repository";

/** How many files are read from the provider at once. */
const READ_CONCURRENCY = 4;

/** One folder's `.contextignore`, as the run would read it (file comment). */
export type ContextIgnoreFileResult = { folder: string } & (
	| { state: "absent" }
	| { state: "rules"; text: string }
	| { state: "tooLarge" }
	| { state: "encoding" }
	| { state: "ruleRejected"; line: number }
);

type ReadIgnoreFilesResult = {
	supported: boolean;
	files: ContextIgnoreFileResult[];
};

/** The policy file the run applies for a selected folder. */
function contextIgnorePathOf(folder: string): string {
	return folder === ""
		? CONTEXT_IGNORE_FILENAME
		: `${folder}/${CONTEXT_IGNORE_FILENAME}`;
}

/** What the run makes of a file's bytes (file comment). */
function contextIgnoreResultOf(
	folder: string,
	bytes: Uint8Array,
): ContextIgnoreFileResult {
	const text = decodeContextIgnore(bytes);
	if (text === null) {
		return { folder, state: "encoding" };
	}
	const problem = findContextIgnoreProblem(text);
	return problem
		? { folder, state: "ruleRejected", line: problem.line }
		: { folder, state: "rules", text };
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(CONTEXT_CREATE).
 */
export const readContextRepositoryIgnoreFilesProcedure =
	tenantProtectedProcedure
		// Visibility before permission: see the file comment.
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
		.route({
			method: "GET",
			path: "/projects/:projectId/contexts/repository-sync/ignore-files",
			tags: ["Projects", "Contexts"],
			summary:
				"Read the .contextignore of selected repository folders for the sync",
		})
		.input(
			z.object({
				projectId: z.string().min(1).max(128),
				organizationId: z.string().nullable().optional(),
				// `listTree`'s field names and shapes: the dialog passes the
				// same state to both.
				repositoryIntegrationId: z.string().min(1).max(128),
				ref: contextSyncRefSchema,
				folders: z
					.array(z.string().max(MAX_CONTEXT_SYNC_PATH_LENGTH))
					.max(MAX_CONTEXT_SYNC_PATHS),
			}),
		)
		.handler(async ({ input, context }): Promise<ReadIgnoreFilesResult> => {
			const { organizationId } = await resolveContextSyncAccess(
				input.projectId,
				context.user.id,
				Permissions.CONTEXT_CREATE,
			);
			const folders = [...new Set(input.folders)];
			const invalid = folders.find(
				(folder) => contextSyncPathSpellingProblem(folder) !== null,
			);
			if (invalid !== undefined) {
				throw new ORPCError("BAD_REQUEST", {
					message: `"${invalid}" is not a repository path in its plain form.`,
					data: { code: "INVALID_PATH", path: invalid },
				});
			}

			const integration = await loadContextSyncIntegration({
				repositoryIntegrationId: input.repositoryIntegrationId,
				projectId: input.projectId,
			});
			// Answered from the provider alone: no token is resolved for a
			// read that cannot happen.
			if (!isRepositoryTreeProvider(integration.provider)) {
				return { supported: false, files: [] };
			}
			if (folders.length === 0) {
				return { supported: true, files: [] };
			}
			const { token, refreshFault } = await resolveContextSyncCredential(
				integration,
				{ userId: context.user.id, organizationId },
			);

			const readOne = async (
				folder: string,
			): Promise<ContextIgnoreFileResult | "unsupported"> => {
				const result = await readRepositoryFile({
					provider: integration.provider,
					token,
					repositoryUrl: integration.repositoryUrl,
					owner: integration.repositoryOwner,
					repo: integration.repositoryName,
					azureOrganization: integration.azureOrganization,
					branch: input.ref,
					path: contextIgnorePathOf(folder),
					maxBytes: MAX_CONTEXT_IGNORE_BYTES,
				});
				if (!result.ok) {
					if (result.outcome === "unsupported") {
						return "unsupported";
					}
					throw repositoryReadError(result.outcome, {
						ref: input.ref,
						refreshFault,
						unreachableMessage:
							"Couldn't reach the repository to read its .contextignore files. Try again.",
					});
				}
				switch (result.state) {
					case "found":
						return contextIgnoreResultOf(folder, result.bytes);
					case "absent":
						return { folder, state: "absent" };
					case "tooLarge":
						return { folder, state: "tooLarge" };
					default: {
						const unreachable: never = result;
						return unreachable;
					}
				}
			};

			const files: ContextIgnoreFileResult[] = [];
			for (
				let start = 0;
				start < folders.length;
				start += READ_CONCURRENCY
			) {
				const batch = await Promise.all(
					folders.slice(start, start + READ_CONCURRENCY).map(readOne),
				);
				for (const answer of batch) {
					if (answer === "unsupported") {
						return { supported: false, files: [] };
					}
					files.push(answer);
				}
			}
			return { supported: true, files };
		});
