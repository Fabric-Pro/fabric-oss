/**
 * `projects.instructions.repositorySync.readCommitFile` — one file as one
 * commit of the synced branch holds it (Fizzy #2878 §10): the body behind a
 * row of `compareCommits`, read per expanded row the way `getFile` reads a
 * snapshot's. Text only, capped at `SNAPSHOT_LIMITS.maxInlineTextBytes`.
 *
 * `state`:
 *
 *  - `found`: `content`, valid UTF-8, with no credential in it;
 *  - `absent`: the commit holds no regular file at the path (a deleted file's
 *    "after", an added file's "before");
 *  - `tooLarge`: longer than the inline cap; `binary`: not text;
 *  - `withheld`: Fabric will not show it, with `reason` `refused` (a sync run
 *    refused this commit's tree for a secret) or `secret` (this file's text
 *    holds one). The text is never returned, and neither is a line number or
 *    a rule name.
 *
 * Refused as NOT_FOUND, in the words a missing file gets: a path outside the
 * sync's folder, or one the published version's frozen ignore rules or the
 * credential-name rules would leave out (`pathIsExcluded`), and a commit that
 * is not part of the synced branch's history (`assertCommitOnBranch`). `path`
 * is relative to the folder, as in `compareCommits`.
 *
 * Authorization: `projectNotFoundUnlessVisible`, then INSTRUCTION_CREATE, then
 * the hosting organization resolved server-side. The write permission, not
 * INSTRUCTION_READ, for `listTree`'s reason: the read spends the integration's
 * own credential against the customer's provider, on a commit the published
 * copy may never have held. Not audited, as `getFile` is not: the repository's
 * own readers can read this file.
 */
import { ORPCError } from "@orpc/client";
import { readRepositoryFileAtCommit } from "@repo/connectors";
import { getInstructionCommitOverlay } from "@repo/database";
import {
	SNAPSHOT_LIMITS,
	scanTextForSecrets,
	validateRelativePath,
} from "@repo/instructions";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import {
	assertCommitOnBranch,
	loadCommitSource,
	readError,
} from "./commit-source";
import { commitShaSchema, pathIsExcluded } from "./compare-commits";

type CommitFileAnswer =
	| { state: "found"; content: string }
	| { state: "absent" | "tooLarge" | "binary" }
	| { state: "withheld"; reason: "refused" | "secret" };

function notFound(): ORPCError<"NOT_FOUND", { code: string }> {
	return new ORPCError("NOT_FOUND", {
		message: "File not found",
		data: { code: "COMMIT_FILE_NOT_FOUND" },
	});
}

/** The bytes as text, or null when they are not valid UTF-8 or hold a NUL. */
function decodeText(bytes: Uint8Array): string | null {
	if (bytes.includes(0)) {
		return null;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_CREATE).
 */
export const readInstructionRepositoryCommitFileProcedure =
	tenantProtectedProcedure
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
		.route({
			method: "GET",
			path: "/projects/:projectId/instructions/repository-sync/commit-file",
			tags: ["Projects", "Instructions"],
			summary: "Read one file as a commit of the synced branch holds it",
		})
		.input(
			z.object({
				projectId: z.string(),
				organizationId: z.string().nullable().optional(),
				sha: commitShaSchema,
				path: z.string().min(1).max(512),
			}),
		)
		.handler(async ({ input, context }): Promise<CommitFileAnswer> => {
			const checked = validateRelativePath(input.path);
			if (!checked.ok) {
				throw notFound();
			}
			const source = await loadCommitSource({
				projectId: input.projectId,
				userId: context.user.id,
			});
			if (pathIsExcluded(source)(checked.path)) {
				throw notFound();
			}
			await assertCommitOnBranch(source, input.sha);
			const overlay = await getInstructionCommitOverlay({
				projectId: input.projectId,
				organizationId: source.organizationId,
				shas: [input.sha],
			});
			if (overlay.refused.has(input.sha)) {
				return { state: "withheld", reason: "refused" };
			}
			const read = await readRepositoryFileAtCommit({
				...source.repository,
				sha: input.sha,
				path:
					source.rootPath === ""
						? checked.path
						: `${source.rootPath}/${checked.path}`,
				maxBytes: SNAPSHOT_LIMITS.maxInlineTextBytes,
			});
			if (!read.ok) {
				if (read.outcome === "unsupported") {
					throw readError(source, "unreachable");
				}
				throw readError(source, read.outcome);
			}
			if (read.state === "absent" || read.state === "tooLarge") {
				return { state: read.state };
			}
			const text = decodeText(read.bytes);
			if (text === null) {
				return { state: "binary" };
			}
			if (scanTextForSecrets(text, { limit: 0 }).total > 0) {
				return { state: "withheld", reason: "secret" };
			}
			return { state: "found", content: text };
		});
