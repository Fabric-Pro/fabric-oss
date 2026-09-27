/**
 * The JSON columns of member proposal branches (member proposal branch spec
 * §4.1, §4.2): the branch's frozen destination and presentation, and one
 * entry of an operation's journal.
 *
 * The per-proposal `pullRequestContext` v2 lives beside v1 in
 * `pull-request-context.ts`.
 */
import { z } from "zod";
import {
	PULL_REQUEST_PROVIDERS,
	pullRequestRepositorySchema,
} from "./pull-request-context";

const nonEmpty = z.string().min(1);

/** A full object id: SHA-1, or SHA-256 for a repository that uses it. */
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** A git tree entry mode, as `ls-tree` prints it. */
const treeMode = z.string().regex(/^[0-7]{6}$/);

/** The raw tree entry under the frozen root (spec §4.1 "Entry"). */
export type TreeEntry = {
	type: "blob" | "symlink" | "gitlink";
	mode: string;
	oid: string;
};

export const treeEntrySchema: z.ZodType<TreeEntry> = z
	.object({
		type: z.enum(["blob", "symlink", "gitlink"]),
		mode: treeMode,
		oid: objectId,
	})
	.strict();

/**
 * One path an operation changed. `path` is relative to the frozen root and
 * `rawPath` is the repository path; `before`/`after` are null for an absent
 * entry. `afterSource`/`beforeSource` name the proposal whose stored file
 * holds those bytes, when Fabric knows one.
 */
export const branchOperationEntrySchema = z
	.object({
		path: nonEmpty,
		rawPath: nonEmpty,
		before: treeEntrySchema.nullable(),
		after: treeEntrySchema.nullable(),
		afterSha256: z
			.string()
			.regex(/^[0-9a-f]{64}$/)
			.nullable(),
		afterSource: nonEmpty.nullable(),
		beforeSource: nonEmpty.nullable(),
	})
	.strict();

export type BranchOperationEntry = z.infer<typeof branchOperationEntrySchema>;

/** The branch's destination, frozen at creation (spec Decision 15). */
export const branchDestinationSchema = z
	.object({
		integrationId: nonEmpty,
		syncId: nonEmpty,
		/** The canonical repository identity the ref reservation is keyed on. */
		repositoryKey: nonEmpty,
		provider: z.enum(PULL_REQUEST_PROVIDERS),
		repository: pullRequestRepositorySchema,
		/** Branch name, without `refs/heads/`. */
		targetRef: nonEmpty,
		/** POSIX, relative, no trailing slash; "" is the repository root. */
		rootPath: z.string(),
	})
	.strict()
	.refine(
		(destination) =>
			destination.repository.provider === destination.provider,
		{
			message: "The repository's provider must equal the destination's",
			path: ["repository", "provider"],
		},
	);

export type BranchDestination = z.infer<typeof branchDestinationSchema>;

/** The pull request's title and body, rendered at the branch's first claim. */
export const branchPresentationSchema = z
	.object({ title: z.string(), body: z.string() })
	.strict();

export type BranchPresentation = z.infer<typeof branchPresentationSchema>;
