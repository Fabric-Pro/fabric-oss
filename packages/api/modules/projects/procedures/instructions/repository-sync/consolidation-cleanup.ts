/**
 * The cleanup pull request a consolidation opens in the code repository
 * (specs/2026-10-21-ai-artifacts-hub §5.2, P4): its live state, and a merge
 * from Fabric after the person confirms.
 *
 * - `getConsolidationCleanupPullRequest` reads the pull request from the
 *   provider on demand, through the code repository's own credential. Once
 *   seen merged, the run records it and later reads answer from the row.
 * - `mergeConsolidationCleanupPullRequest` merges it, only while it is still
 *   this run's cleanup pull request, open, and its head is the commit Fabric
 *   pushed (the provider's `sha` guard), so a branch someone changed is
 *   never merged blindly.
 *
 * The token never leaves this module: it reaches the adapter as an argument,
 * and every provider refusal arrives sanitized (`MergeResult`), without a
 * URL, a header other than the accepted-permissions one, or a body.
 *
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * INSTRUCTION_READ for the read; the merge has the same gates as starting the
 * move (INSTRUCTION_CREATE, then PROJECT_SETTINGS_EDIT). The organization is
 * the project's own, and the run must belong to it.
 */
import { ORPCError } from "@orpc/client";
import {
	getLatestInstructionConsolidation,
	getProjectRepoIntegration,
	markInstructionConsolidationCleanupMerged,
} from "@repo/database";
import { cleanupBranchName } from "@repo/instructions";
import {
	adapterFor,
	type MergeResult,
	type PullRequestObservation,
	repositoryIdentity,
	sameRepository,
	type Target,
} from "@repo/integrations/instruction-pull-requests";
import { resolveFreshRepoToken } from "@repo/integrations/repo-auth";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	assertProjectPermission,
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { resolveHostingOrganizationAccess } from "../hosting-organization";

const projectInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

/** Squash, as Fabric merges its own pull requests: one commit removes the files. */
const MERGE_METHOD = "squash" as const;

const PROVIDER_LABEL: Record<string, string> = {
	GITHUB: "GitHub",
	GITLAB: "GitLab",
	AZURE_DEVOPS: "Azure DevOps",
};

type CleanupPullRequestState = "OPEN" | "MERGED" | "CLOSED" | "UNKNOWN";

type Run = NonNullable<
	Awaited<ReturnType<typeof getLatestInstructionConsolidation>>
>;

type Loaded = {
	run: Run;
	provider: string;
	repository: string;
	defaultBranch: string;
	target: Target | null;
	observation: PullRequestObservation | null;
};

/** The pull request number from a stored web URL, for a run recorded before the id was. */
function numberFromUrl(url: string): string | null {
	const match =
		/\/(?:pull|merge_requests|pullrequest)\/(\d+)(?:[/?#]|$)/.exec(url);
	return match?.[1] ?? null;
}

/**
 * The newest run of the project, its code repository and, when the provider
 * answers, the live pull request. `null` when no cleanup pull request was
 * opened. A pull request that is not the run's own (another branch, another
 * repository, another page) is never returned as the run's.
 */
async function loadCleanup(input: {
	projectId: string;
	userId: string;
	organizationId: string;
}): Promise<Loaded | null> {
	const run = await getLatestInstructionConsolidation(input.projectId);
	if (!run?.cleanupPullRequestUrl) {
		return null;
	}
	if (run.organizationId !== input.organizationId) {
		// The run belongs to the project's organization or to nobody here.
		return null;
	}
	const integration = await getProjectRepoIntegration(
		run.sourceIntegrationId,
		input.projectId,
	);
	if (!integration) {
		throw new ORPCError("NOT_FOUND", {
			message:
				"The code repository is no longer connected to the project.",
			data: { code: "REPOSITORY_UNAVAILABLE" },
		});
	}
	const base = {
		run,
		provider: integration.provider,
		repository: `${integration.repositoryOwner}/${integration.repositoryName}`,
		defaultBranch: integration.defaultBranch,
	};
	// A merge already recorded needs no provider call.
	if (run.cleanupMergedAt !== null) {
		return { ...base, target: null, observation: null };
	}
	const identity = repositoryIdentity(
		integration.provider,
		integration.repositoryUrl,
	);
	if (identity === null) {
		return { ...base, target: null, observation: null };
	}
	const signal = AbortSignal.timeout(30_000);
	const resolved = await resolveFreshRepoToken({
		integrationId: integration.id,
		projectId: input.projectId,
		userId: input.userId,
		organizationId: input.organizationId,
		signal,
	}).catch(() => ({ token: null, authMethod: null }));
	if (!resolved.token) {
		return { ...base, target: null, observation: null };
	}
	const target: Target = {
		auth: {
			token: resolved.token,
			authMethod:
				(resolved.authMethod ?? integration.authMethod) === "PAT"
					? "PAT"
					: "OAUTH",
		},
		repository: identity,
		signal,
	};
	const adapter = adapterFor(identity.provider);
	const branch = cleanupBranchName(run.id);
	let observation: PullRequestObservation | null = null;
	const externalId =
		run.cleanupPullRequestId ?? numberFromUrl(run.cleanupPullRequestUrl);
	try {
		if (externalId) {
			observation = await adapter.get({ ...target, externalId });
		} else {
			const found = await adapter.findOperation({
				...target,
				sourceRef: branch,
			});
			observation = found.kind === "FOUND" ? found.value : null;
		}
	} catch {
		// Sanitized provider failures and our own timeout alike: unknown.
		observation = null;
	}
	if (
		observation &&
		(observation.sourceRef !== branch ||
			!sameRepository(observation.sourceRepository, identity) ||
			observation.url !== run.cleanupPullRequestUrl)
	) {
		// Not this run's cleanup pull request: never shown or merged as it.
		observation = null;
	}
	return { ...base, target, observation };
}

function view(
	loaded: Loaded,
	canMerge: boolean,
): {
	state: CleanupPullRequestState;
	url: string;
	number: string | null;
	provider: string;
	repository: string;
	defaultBranch: string;
	fileCount: number;
	mergedAt: string | null;
	/** Whether this caller may merge it from Fabric, and the provider supports it. */
	canMerge: boolean;
} {
	const { run, observation } = loaded;
	const merged = run.cleanupMergedAt !== null;
	const state: CleanupPullRequestState = merged
		? "MERGED"
		: (observation?.state ?? "UNKNOWN");
	return {
		state,
		url: run.cleanupPullRequestUrl ?? "",
		number:
			observation?.externalId ??
			run.cleanupPullRequestId ??
			numberFromUrl(run.cleanupPullRequestUrl ?? ""),
		provider: loaded.provider,
		repository: loaded.repository,
		defaultBranch: loaded.defaultBranch,
		fileCount: run.fileCount,
		mergedAt:
			run.cleanupMergedAt?.toISOString() ?? observation?.mergedAt ?? null,
		canMerge:
			canMerge &&
			state === "OPEN" &&
			run.cleanupHeadSha !== null &&
			loaded.provider !== "AZURE_DEVOPS",
	};
}

/** Records a merge the provider reports, once. */
async function recordMergedIfSeen(loaded: Loaded, projectId: string) {
	if (
		loaded.observation?.state === "MERGED" &&
		loaded.run.cleanupMergedAt === null
	) {
		const at = loaded.observation.mergedAt
			? new Date(loaded.observation.mergedAt)
			: new Date();
		await markInstructionConsolidationCleanupMerged(
			loaded.run.id,
			projectId,
			Number.isNaN(at.getTime()) ? new Date() : at,
		);
		loaded.run = { ...loaded.run, cleanupMergedAt: at };
	}
}

const MAY_MERGE = [
	Permissions.INSTRUCTION_CREATE,
	Permissions.PROJECT_SETTINGS_EDIT,
] as const;

export const getConsolidationCleanupPullRequestProcedure =
	tenantProtectedProcedure
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
		.route({
			method: "GET",
			path: "/projects/:projectId/instructions/consolidation/cleanup-pull-request",
			tags: ["Projects", "Instructions"],
			summary:
				"The live state of the pull request removing AI files from the code repository",
		})
		.input(projectInput)
		.handler(async ({ input, context }) => {
			const access = await resolveHostingOrganizationAccess(
				input.projectId,
				context.user.id,
			);
			const loaded = await loadCleanup({
				projectId: input.projectId,
				userId: context.user.id,
				organizationId: access.organizationId,
			});
			if (!loaded) {
				return { pullRequest: null };
			}
			await recordMergedIfSeen(loaded, input.projectId);
			const canMerge = MAY_MERGE.every((p) =>
				access.permissions.includes(p),
			);
			return { pullRequest: view(loaded, canMerge) };
		});

type Refused = Extract<MergeResult, { kind: "REFUSED" }>;

/** A provider refusal as a message the panel shows as is. */
function mergeRefusalError(
	refused: Refused,
	ctx: { provider: string; number: string },
): ORPCError<string, unknown> {
	const name = PROVIDER_LABEL[ctx.provider] ?? "The provider";
	const pr = `pull request #${ctx.number}`;
	switch (refused.reason) {
		case "not_mergeable":
			return new ORPCError("CONFLICT", {
				message: `${name} won't merge ${pr} yet: required checks or reviews may be missing, it may have conflicts, or the repository may not allow squash merges. Open it to see what's needed.`,
				data: { code: "NOT_MERGEABLE" },
			});
		case "head_moved":
			return new ORPCError("CONFLICT", {
				message: `The cleanup branch changed after Fabric opened ${pr}, so Fabric didn't merge it. Review the new commits and merge it yourself.`,
				data: { code: "HEAD_MOVED" },
			});
		case "permission":
			return new ORPCError("BAD_REQUEST", {
				message: refused.acceptedPermissions
					? `The code repository's credential may not merge ${pr}. ${name} needs these permissions: ${refused.acceptedPermissions}.`
					: `The code repository's credential may not merge ${pr}. It needs write access to the repository's contents and pull requests.`,
				data: {
					code: "MERGE_FORBIDDEN",
					...(refused.acceptedPermissions
						? { acceptedPermissions: refused.acceptedPermissions }
						: {}),
				},
			});
		case "auth":
			return new ORPCError("BAD_REQUEST", {
				message:
					"The code repository's credential is missing or expired. Reconnect it in the project's integrations.",
				data: { code: "AUTHENTICATION_FAILED" },
			});
		case "not_found":
			return new ORPCError("NOT_FOUND", {
				message: `${name} couldn't find ${pr} in the code repository.`,
				data: { code: "PULL_REQUEST_NOT_FOUND" },
			});
		case "rate_limit":
			return new ORPCError("TOO_MANY_REQUESTS", {
				message: `${name} is limiting requests right now. Try again in a few minutes.`,
				data: {
					code: "PROVIDER_RATE_LIMITED",
					...(refused.retryAfterSeconds === undefined
						? {}
						: { retryAfter: refused.retryAfterSeconds }),
				},
			});
		case "unsupported":
			return new ORPCError("BAD_REQUEST", {
				message: `Fabric can't merge ${name} pull requests yet. Merge ${pr} there.`,
				data: { code: "MERGE_UNSUPPORTED" },
			});
		default:
			return new ORPCError("SERVICE_UNAVAILABLE", {
				message: `Couldn't get an answer from ${name}. Check ${pr} before trying again: it may have merged.`,
				data: { code: "PROVIDER_UNAVAILABLE" },
			});
	}
}

export const mergeConsolidationCleanupPullRequestProcedure =
	tenantProtectedProcedure
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
		.route({
			method: "POST",
			path: "/projects/:projectId/instructions/consolidation/cleanup-pull-request/merge",
			tags: ["Projects", "Instructions"],
			summary:
				"Merge the pull request removing AI files from the code repository",
		})
		.input(
			projectInput.extend({
				/** The pull request number the person confirmed. */
				pullRequestNumber: z.string().regex(/^[1-9][0-9]{0,9}$/),
			}),
		)
		.handler(async ({ input, context }) => {
			await assertProjectPermission(
				input.projectId,
				context.user.id,
				Permissions.PROJECT_SETTINGS_EDIT,
			);
			const { organizationId } = await resolveHostingOrganizationAccess(
				input.projectId,
				context.user.id,
			);
			const loaded = await loadCleanup({
				projectId: input.projectId,
				userId: context.user.id,
				organizationId,
			});
			if (!loaded) {
				throw new ORPCError("NOT_FOUND", {
					message: "There is no cleanup pull request to merge.",
					data: { code: "NO_CLEANUP_PULL_REQUEST" },
				});
			}
			const { run, observation, target } = loaded;
			if (!target) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"The code repository's credential is missing or expired. Reconnect it in the project's integrations.",
					data: { code: "AUTHENTICATION_FAILED" },
				});
			}
			if (!observation) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message:
						"Couldn't read the cleanup pull request from the code repository. Try again.",
					data: { code: "PROVIDER_UNAVAILABLE" },
				});
			}
			if (observation.externalId !== input.pullRequestNumber) {
				throw new ORPCError("CONFLICT", {
					message:
						"That pull request is not this move's cleanup pull request. Refresh the page.",
					data: { code: "WRONG_PULL_REQUEST" },
				});
			}
			await recordMergedIfSeen(loaded, input.projectId);
			if (observation.state !== "OPEN") {
				throw new ORPCError("CONFLICT", {
					message:
						observation.state === "MERGED"
							? `Pull request #${observation.externalId} is already merged.`
							: `Pull request #${observation.externalId} was closed without merging.`,
					data: {
						code:
							observation.state === "MERGED"
								? "ALREADY_MERGED"
								: "PULL_REQUEST_CLOSED",
					},
				});
			}
			if (!run.cleanupHeadSha) {
				throw new ORPCError("PRECONDITION_FAILED", {
					message: `Fabric didn't record the commit it pushed for pull request #${observation.externalId}, so it won't merge it. Merge it yourself.`,
					data: { code: "HEAD_UNKNOWN" },
				});
			}
			if (observation.headSha !== run.cleanupHeadSha) {
				throw mergeRefusalError(
					{ kind: "REFUSED", reason: "head_moved" },
					{
						provider: loaded.provider,
						number: observation.externalId,
					},
				);
			}
			const result = await adapterFor(target.repository.provider).merge({
				...target,
				externalId: observation.externalId,
				expectedHeadSha: run.cleanupHeadSha,
				method: MERGE_METHOD,
				commitTitle: "Move AI instructions out of the code repository",
			});
			if (result.kind === "REFUSED") {
				throw mergeRefusalError(result, {
					provider: loaded.provider,
					number: observation.externalId,
				});
			}
			const mergedAt = new Date();
			await markInstructionConsolidationCleanupMerged(
				run.id,
				input.projectId,
				mergedAt,
			);
			recordAuditFromRequest(context, {
				action: "project.instructions.consolidation_cleanup_merged",
				category: "project",
				organizationId,
				projectId: input.projectId,
				resource: {
					type: "project_repository_integration",
					id: run.sourceIntegrationId,
					name: loaded.repository,
				},
				metadata: {
					pullRequest: Number(observation.externalId),
					mergeMethod: MERGE_METHOD,
					fileCount: run.fileCount,
				},
			});
			return {
				pullRequest: view(
					{
						...loaded,
						run: { ...run, cleanupMergedAt: mergedAt },
					},
					true,
				),
			};
		});
