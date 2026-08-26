/**
 * The test-case update path.
 *
 * A case drafted from an acceptance criterion goes stale the moment that
 * criterion is rewritten, and until now nothing said so — the suite went on
 * asserting a flow the product no longer had, which is worse than no coverage
 * because it reads AS coverage.
 *
 * Four procedures, in the order a person uses them: see which cases drifted,
 * ask for a proposal on one, then accept or reject it. The accept/reject split
 * is the control — an AI may propose a change to the suite, never make one.
 */

import { ORPCError } from "@orpc/client";
import {
	reviseTestCaseSteps,
	reviseTestCaseStepsFromImplementation,
} from "@repo/ai";
import {
	acceptTestCaseStepProposal,
	findImplementationPullRequest,
	fingerprintSpecText,
	listDriftedTestCases,
	proposeTestCaseSteps,
	rejectTestCaseStepProposal,
} from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { resolveFreshRepoToken } from "@repo/integrations";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

/**
 * Load the feature a drift check is relative to, plus the organization that
 * OWNS it.
 *
 * Scoped by projectId, so a story id from another project resolves to NOT_FOUND
 * here exactly as it would on any other path — the tenant guard is the WHERE
 * clause, not a check after the read.
 *
 * The organization is read off the project rather than taken from
 * `input.organizationId`. `resolveOrganizationId` hands back the caller's string
 * as-is and `requireProjectPermission` does not check it, so trusting the input
 * would let a caller pair their own project with somebody else's organization —
 * and here that id picks the AI provider and is billed for the generation.
 */
async function loadStoryForDrift(projectId: string, storyId: string) {
	const story = await db.userStory.findFirst({
		where: { id: storyId, projectId },
		select: {
			id: true,
			title: true,
			description: true,
			acceptanceCriteria: true,
			project: { select: { organizationId: true } },
		},
	});
	if (!story) {
		throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
	}
	return story;
}

export const listDriftedTestCasesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/features/{storyId}/drifted-test-cases",
		tags: ["Projects", "Test Cases"],
		summary:
			"List test cases whose feature text has changed since drafting",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_READ) gates the project.
		const story = await loadStoryForDrift(input.projectId, input.storyId);
		const currentSpecHash = fingerprintSpecText(story);
		const cases = await listDriftedTestCases({
			projectId: input.projectId,
			storyId: input.storyId,
			currentSpecHash,
		});
		return { cases, currentSpecHash };
	});

export const proposeTestCaseStepsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/{testCaseId}/propose-steps",
		tags: ["Projects", "Test Cases"],
		summary: "Ask AI to propose revised steps for a drifted test case",
	})
	.input(
		z.object({
			projectId: z.string(),
			testCaseId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: TEST_CASE_UPDATE — a proposal is written onto the case.
		const story = await loadStoryForDrift(input.projectId, input.storyId);
		const organizationId = story.project.organizationId;
		if (!story.acceptanceCriteria?.trim()) {
			// The criteria ARE the contract being revised against. Without them the
			// model has nothing falsifiable to work from and would invent
			// plausible-looking steps that verify nothing — so refuse rather than
			// bill a generation for junk.
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This feature has no acceptance criteria to revise the test case against.",
			});
		}

		const testCase = await db.testCase.findFirst({
			where: {
				id: input.testCaseId,
				projectId: input.projectId,
				deletedAt: null,
			},
			select: {
				title: true,
				steps: {
					orderBy: { order: "asc" },
					select: { action: true, expected: true },
				},
				workItemLinks: {
					where: { userStoryId: input.storyId },
					select: { acceptanceCriterionRefs: true },
				},
			},
		});
		if (!testCase) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test case not found",
			});
		}

		const revised = await reviseTestCaseSteps(
			{
				featureTitle: story.title,
				featureDescription: story.description,
				acceptanceCriteria: story.acceptanceCriteria,
				caseTitle: testCase.title,
				// Flattened across links rather than read off the first: the
				// drift check compares what a case claims to cover, and taking
				// one reference would understate it.
				acceptanceCriterionRefs: testCase.workItemLinks.flatMap(
					(l) => l.acceptanceCriterionRefs,
				),
				currentSteps: testCase.steps,
			},
			{
				userId: context.user.id,
				organizationId: organizationId ?? undefined,
				projectId: input.projectId,
			},
		);
		if (revised === null) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"No AI provider is configured for this workspace, so steps cannot be proposed.",
			});
		}
		if (revised.steps.length === 0) {
			// The model found nothing this case can still verify. Reported rather
			// than stored: an empty proposal a person could "accept" would blank the
			// case's steps, and deleting coverage is a decision, not an accept.
			return {
				proposed: false as const,
				reason: "NOTHING_TO_VERIFY" as const,
				rationale: revised.rationale,
			};
		}

		const stored = await proposeTestCaseSteps({
			projectId: input.projectId,
			testCaseId: input.testCaseId,
			steps: revised.steps,
			source: "SPEC",
		});
		if (!stored) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test case not found",
			});
		}
		return {
			proposed: true as const,
			steps: revised.steps,
			rationale: revised.rationale,
		};
	});

/**
 * How much of a pull request's diff is put in front of the model.
 *
 * Smaller than the pull-request reviewer's own ingest limit, because this is one
 * prompt rather than a stored record several lenses read. A revision that saw
 * part of the change must not read as one that saw all of it, so truncation is
 * returned to the caller and shown, never silently absorbed.
 */
const IMPLEMENTATION_REVISION_MAX_DIFF_BYTES = 200_000;

const GITHUB_API = "https://api.github.com";

export const proposeTestCaseStepsFromImplementationProcedure =
	tenantProtectedProcedure
		// TEST_CASE_UPDATE: a proposal is written onto the case, and this spends
		// both an API call against the customer's credential and a generation.
		.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
		.route({
			method: "POST",
			path: "/projects/{projectId}/test-cases/{testCaseId}/propose-steps-from-implementation",
			tags: ["Projects", "Test Cases"],
			summary:
				"Ask AI to revise a test case against the pull request that implemented its feature",
		})
		.input(
			z.object({
				projectId: z.string(),
				testCaseId: z.string(),
				storyId: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			assertTestCasesFeatureEnabled();
			// AUTHORIZATION: TEST_CASE_UPDATE gates the project; the org is read
			// off the project rather than taken from the input, for the reason
			// given on loadStoryForDrift — here it picks the AI provider and is
			// billed for the generation.
			const story = await loadStoryForDrift(
				input.projectId,
				input.storyId,
			);
			const organizationId = story.project.organizationId;

			// `CodingRun.storyId → pullRequestNumber` is the ONLY link Fabric has
			// between a feature and the pull request that implemented it. Without
			// one there is no diff to revise against, and this refuses by name
			// rather than falling back to the spec — a button labelled "revise
			// against what shipped" that quietly re-read the spec instead would be
			// worse than one that does not work.
			const pr = await findImplementationPullRequest({
				projectId: input.projectId,
				storyId: input.storyId,
			});
			if (!pr) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"No coding run for this feature recorded a pull request, so there is no implementation to revise against.",
				});
			}

			const testCase = await db.testCase.findFirst({
				where: {
					id: input.testCaseId,
					projectId: input.projectId,
					deletedAt: null,
				},
				select: {
					title: true,
					steps: {
						orderBy: { order: "asc" },
						select: { action: true, expected: true },
					},
				},
			});
			if (!testCase) {
				throw new ORPCError("NOT_FOUND", {
					message: "Test case not found",
				});
			}

			// The repository the coding run wrote to, matched to a connected
			// integration by owner/name. Scoped by projectId: an integration from
			// another project must not be usable to read a diff through this one,
			// and requireProjectPermission authorizes the project without ever
			// looking at which integrations belong to it.
			const integration = await db.projectRepositoryIntegration.findFirst(
				{
					where: {
						projectId: input.projectId,
						provider: "GITHUB",
						repositoryOwner: pr.repositoryOwner,
						repositoryName: pr.repositoryName,
					},
					select: { id: true },
				},
			);
			if (!integration) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"The repository that pull request was opened in is not connected to this project, so its diff cannot be read.",
				});
			}

			const { token } = await resolveFreshRepoToken({
				integrationId: integration.id,
				projectId: input.projectId,
				userId: context.user.id,
				organizationId,
			});
			if (!token) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"No usable credential for this repository — reconnect it in Settings ▸ Repositories and try again.",
				});
			}

			const endpoint = `${GITHUB_API}/repos/${encodeURIComponent(pr.repositoryOwner)}/${encodeURIComponent(pr.repositoryName)}/pulls/${pr.prNumber}`;
			const diffResponse = await fetch(endpoint, {
				headers: {
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": "2022-11-28",
					Accept: "application/vnd.github.v3.diff",
				},
			});
			if (!diffResponse.ok) {
				// Composed from the status alone: GitHub's own error envelope can
				// echo the credential back, and this message reaches the browser.
				throw new ORPCError("BAD_REQUEST", {
					message:
						diffResponse.status === 404
							? `Pull request #${pr.prNumber} was not found in that repository.`
							: `GitHub refused the diff for #${pr.prNumber} (HTTP ${diffResponse.status}).`,
				});
			}
			const body = await diffResponse.text();
			const diffTruncated =
				body.length > IMPLEMENTATION_REVISION_MAX_DIFF_BYTES;
			const diff = diffTruncated
				? body.slice(0, IMPLEMENTATION_REVISION_MAX_DIFF_BYTES)
				: body;
			if (diff.trim().length === 0) {
				// An empty diff is not a revision with nothing to change — it is a
				// revision with nothing to go on, and asking the model anyway would
				// bill a generation to be told so.
				throw new ORPCError("BAD_REQUEST", {
					message: `Pull request #${pr.prNumber} has an empty diff, so there is nothing to revise against.`,
				});
			}

			// Audited because it reaches OUT of Fabric with the customer's
			// credential and pulls their source code in (SOC 2 CC7.2), on the same
			// footing as reading a pull request for review.
			recordAuditFromRequest(context, {
				action: "project.pull_request.read",
				category: "project",
				severity: "info",
				outcome: "success",
				projectId: input.projectId,
				resource: { type: "test_case", id: input.testCaseId },
				metadata: {
					repository: `${pr.repositoryOwner}/${pr.repositoryName}`,
					prNumber: pr.prNumber,
					purpose: "test_case_step_revision",
					diffTruncated,
				},
			});

			const revised = await reviseTestCaseStepsFromImplementation(
				{
					featureTitle: story.title,
					caseTitle: testCase.title,
					currentSteps: testCase.steps,
					diff,
				},
				{
					userId: context.user.id,
					organizationId: organizationId ?? undefined,
					projectId: input.projectId,
				},
			);
			if (revised === null) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"No AI provider is configured for this workspace, so steps cannot be proposed.",
				});
			}
			if (revised.steps.length === 0) {
				// Reported rather than stored, as on the spec path: an empty
				// proposal a person could "accept" would blank the case's steps,
				// and deleting coverage is a decision, not an accept.
				return {
					proposed: false as const,
					reason: "NOTHING_TO_VERIFY" as const,
					rationale: revised.rationale,
					prNumber: pr.prNumber,
					prUrl: pr.pullRequestUrl,
					diffTruncated,
				};
			}

			const stored = await proposeTestCaseSteps({
				projectId: input.projectId,
				testCaseId: input.testCaseId,
				steps: revised.steps,
				// Recorded so accepting this proposal does NOT stamp the case as
				// matching the spec — it was never checked against one.
				source: "IMPLEMENTATION",
			});
			if (!stored) {
				throw new ORPCError("NOT_FOUND", {
					message: "Test case not found",
				});
			}
			return {
				proposed: true as const,
				steps: revised.steps,
				rationale: revised.rationale,
				prNumber: pr.prNumber,
				prUrl: pr.pullRequestUrl,
				diffTruncated,
			};
		});

export const acceptTestCaseStepsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/{testCaseId}/accept-steps",
		tags: ["Projects", "Test Cases"],
		summary: "Apply an AI-proposed step revision to a test case",
	})
	.input(
		z.object({
			projectId: z.string(),
			testCaseId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: TEST_CASE_UPDATE — accepting rewrites the case's steps.
		const story = await loadStoryForDrift(input.projectId, input.storyId);
		const result = await acceptTestCaseStepProposal({
			projectId: input.projectId,
			testCaseId: input.testCaseId,
			actorUserId: context.user.id,
			// Stamped as part of accepting: the case now matches the feature text
			// the proposal was generated from, so it is no longer drifted.
			currentSpecHash: fingerprintSpecText(story),
		});
		if (!result.applied && result.reason === "NOT_FOUND") {
			throw new ORPCError("NOT_FOUND", {
				message: "Test case not found",
			});
		}
		return result;
	});

export const rejectTestCaseStepsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/{testCaseId}/reject-steps",
		tags: ["Projects", "Test Cases"],
		summary: "Discard an AI-proposed step revision",
	})
	.input(
		z.object({
			projectId: z.string(),
			testCaseId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: TEST_CASE_UPDATE — clears a proposal from the case.
		//
		// Deliberately does NOT re-stamp the case as current. Rejecting says "this
		// suggestion was wrong", not "this case is up to date", so the case stays
		// listed as drifted and can be proposed against again.
		const cleared = await rejectTestCaseStepProposal({
			projectId: input.projectId,
			testCaseId: input.testCaseId,
		});
		if (!cleared) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test case not found",
			});
		}
		return { rejected: true };
	});
