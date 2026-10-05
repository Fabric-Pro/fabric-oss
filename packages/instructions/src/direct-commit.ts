/**
 * A direct commit to a repository-backed project's synced branch (Fizzy #2878
 * §10): the frozen destination and rendered commit text a `REPOSITORY_COMMIT`
 * snapshot carries, and what became of the commit.
 *
 * The context is the member proposal branch's v2 destination and commit text
 * (`pullRequestContextSchemaV2`) without a pull request around it: the commit
 * is built on the branch itself, with the author and message rendered once at
 * admission so every retry builds the same commit. Nothing re-resolves it; the
 * activity checks the live configuration still equals it.
 *
 * Pure: the workflow bundle imports this file's types, so it has no runtime
 * dependency beyond `zod`.
 */
import { z } from "zod";
import {
	PULL_REQUEST_PROVIDERS,
	pullRequestRepositorySchema,
} from "./pull-request-context";

const nonEmpty = z.string().min(1);

/** A full object id: SHA-1, or SHA-256 for a repository that uses it. */
const commitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

const identity = z.object({ name: nonEmpty, email: nonEmpty });

export const directCommitContextSchema = z
	.object({
		v: z.literal(1),
		integrationId: nonEmpty,
		syncId: nonEmpty,
		syncGeneration: z.number().int().positive(),
		provider: z.enum(PULL_REQUEST_PROVIDERS),
		/** Branch name, without `refs/heads/`: the only ref this commit may write. */
		targetRef: nonEmpty,
		/** POSIX, relative, no trailing slash; "" is the repository root. */
		rootPath: z.string(),
		/** The published `source.commitSha` the change was stated against. */
		baseCommitSha: commitSha,
		repository: pullRequestRepositorySchema,
		author: identity,
		committer: identity,
		message: nonEmpty,
		/** ISO 8601 UTC, whole seconds: part of the reproducible commit. */
		committedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
	})
	.strict()
	.refine((context) => context.repository.provider === context.provider, {
		message: "The repository's provider must equal the context's",
		path: ["repository", "provider"],
	});

export type DirectCommitContext = z.infer<typeof directCommitContextSchema>;

/**
 * What became of a direct commit, stored as `commitOutcome` on its snapshot
 * (null while it is pending). The one field a client polls: the snapshot
 * summary carries it beside `status`, so "Committing…" ends when it is set.
 *
 * - `committed`: one commit on `ref`, `sha`; Fabric's published copy follows
 *   it through the sync the commit triggers, which copies the branch's real
 *   tree (this snapshot is never published itself).
 * - `unchanged`: the branch already held exactly this content; nothing was
 *   committed. `sha` is the tip.
 * - `pull-request`: the branch refused the push (protection) or kept moving,
 *   so the SAME change was admitted as a pull request on the member's branch.
 *   `operationId` is the proposal's `pullRequestOperationId`; its pull request
 *   (URL, state) is the snapshot's ordinary `pullRequest` block.
 * - `branch-moved`: someone changed one of these files on the branch since
 *   the base. Nothing was written; the editor chooses to retry or suggest.
 * - `failed`: a typed code (`AUTHENTICATION_FAILED`, `REPOSITORY_CHANGED`,
 *   `CONFIGURATION_CHANGED`, `PERMISSION_REVOKED`, `TREE_CONFLICT`,
 *   `GIT_FAILED`, `VALIDATION_TIMEOUT`, `UNEXPECTED`, ...), never text.
 *
 * A change the secret scan refuses is not an outcome: the snapshot is
 * REJECTED with its findings and nothing is pushed.
 */
export const directCommitOutcomeSchema = z.discriminatedUnion("outcome", [
	z.object({
		outcome: z.literal("committed"),
		sha: commitSha,
		ref: nonEmpty,
	}),
	z.object({ outcome: z.literal("unchanged"), sha: commitSha }),
	z.object({
		outcome: z.literal("pull-request"),
		operationId: nonEmpty,
		reason: z.enum(["protected", "busy"]),
	}),
	z.object({ outcome: z.literal("branch-moved") }),
	z.object({
		outcome: z.literal("failed"),
		code: nonEmpty,
		retryable: z.boolean(),
	}),
]);

export type DirectCommitOutcome = z.infer<typeof directCommitOutcomeSchema>;

/** The commit's trailer, written so a lost acknowledgement finds its own commit again. */
export const DIRECT_COMMIT_TRAILER = "Fabric-Commit";
