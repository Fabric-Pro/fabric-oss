/**
 * The frozen destination and rendered outbound text of a REPOSITORY proposal
 * (Fizzy #2563 spec §5.2), stored as `pullRequestContext` in the admission
 * transaction. Creation-side steps check the current configuration still
 * equals it; nothing re-resolves it (spec §2.2). `branch` is attempt 1's ref;
 * the current one is the row's `pullRequestRef`.
 *
 * The names are body inputs only: the context keeps no separate copy of the
 * proposer's or project's name beyond the rendered author and text.
 */
import { z } from "zod";

export const PULL_REQUEST_PROVIDERS = [
	"GITHUB",
	"GITLAB",
	"AZURE_DEVOPS",
] as const;

const nonEmpty = z.string().min(1);

/** A full object id: SHA-1, or SHA-256 for a repository that uses it. */
const commitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

const identity = z.object({ name: nonEmpty, email: nonEmpty });

export const pullRequestRepositorySchema = z.discriminatedUnion("provider", [
	z.object({
		provider: z.literal("GITHUB"),
		owner: nonEmpty,
		repo: nonEmpty,
	}),
	/** Subgroups kept: `group/subgroup/project`. */
	z.object({ provider: z.literal("GITLAB"), projectPath: nonEmpty }),
	z.object({
		provider: z.literal("AZURE_DEVOPS"),
		/** An origin only: scheme and host, no path and no userinfo. */
		apiOrigin: z.string().regex(/^https:\/\/[^/@\s]+$/),
		organization: nonEmpty,
		project: nonEmpty,
		repository: nonEmpty,
	}),
]);

/**
 * The #2563 per-proposal context. Rows admitted before member proposal
 * branches keep it and drain on the #2563 workflow (member proposal branch
 * spec Decision 4).
 */
export const pullRequestContextSchemaV1 = z
	.object({
		v: z.literal(1),
		integrationId: nonEmpty,
		syncId: nonEmpty,
		syncGeneration: z.number().int().positive(),
		provider: z.enum(PULL_REQUEST_PROVIDERS),
		/** Branch name, without `refs/heads/`. */
		targetRef: nonEmpty,
		/** POSIX, relative, no trailing slash; "" is the repository root. */
		rootPath: z.string(),
		baseCommitSha: commitSha,
		repository: pullRequestRepositorySchema,
		branch: nonEmpty,
		author: identity,
		committer: identity,
		title: z.string(),
		body: z.string(),
		message: z.string(),
		/** ISO 8601 UTC, whole seconds: part of the reproducible commit. */
		committedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
	})
	.refine((context) => context.repository.provider === context.provider, {
		message: "The repository's provider must equal the context's",
		path: ["repository", "provider"],
	});

/**
 * The member proposal branch context (member proposal branch spec §4.2): v1's
 * destination, identities and commit text, without `branch`, `title` and
 * `body`, which belong to the branch. Strict, so a v1-shaped value can never
 * parse as v2.
 */
export const pullRequestContextSchemaV2 = z
	.object({
		v: z.literal(2),
		integrationId: nonEmpty,
		syncId: nonEmpty,
		syncGeneration: z.number().int().positive(),
		provider: z.enum(PULL_REQUEST_PROVIDERS),
		/** Branch name, without `refs/heads/`. */
		targetRef: nonEmpty,
		/** POSIX, relative, no trailing slash; "" is the repository root. */
		rootPath: z.string(),
		baseCommitSha: commitSha,
		repository: pullRequestRepositorySchema,
		author: identity,
		committer: identity,
		message: z.string(),
		/** ISO 8601 UTC, whole seconds: part of the reproducible commit. */
		committedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
	})
	.strict()
	.refine((context) => context.repository.provider === context.provider, {
		message: "The repository's provider must equal the context's",
		path: ["repository", "provider"],
	});

/** Every stored `pullRequestContext`. Readers switch on `v`. */
export const pullRequestContextSchema = z.discriminatedUnion("v", [
	pullRequestContextSchemaV1,
	pullRequestContextSchemaV2,
]);

export type PullRequestRepository = z.infer<typeof pullRequestRepositorySchema>;
export type PullRequestContextV1 = z.infer<typeof pullRequestContextSchemaV1>;
export type PullRequestContextV2 = z.infer<typeof pullRequestContextSchemaV2>;
export type PullRequestContext = z.infer<typeof pullRequestContextSchema>;
