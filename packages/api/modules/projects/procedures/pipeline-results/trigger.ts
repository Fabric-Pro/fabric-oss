import { ORPCError } from "@orpc/client";
import { db, listProjectQaTriggerTargets } from "@repo/database";
import { resolveFreshRepoToken } from "@repo/integrations";
import type { CiTriggerResult } from "@repo/integrations/ci-trigger";
import { logger } from "@repo/logs";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { deriveCiTriggerPlan } from "../../lib/ci-trigger-dispatch";
import { assertPipelineResultsEnabled } from "../../lib/pipeline-results-feature";

/**
 * Starting a run in the customer's EXISTING CI pipeline.
 *
 * Two procedures: one to show what could be run, one to run it. Results are NOT
 * handled here — the run lands in the customer's CI and the pipeline-results sync
 * that already exists picks it up on its next pass, cursor and all. Nothing
 * downstream of ingestion changes, which is the entire reason this is the
 * cheapest useful slice of the QA-execution spec.
 *
 * Fabric never writes CI configuration, creates repositories, or pushes to a
 * customer repo. Where a provider cannot be triggered without a config change
 * they must make themselves (GitHub's `workflow_dispatch:`), the answer says so
 * in those words rather than reporting a generic failure.
 */

/** A ref can't contain whitespace or a `..` path traversal. */
const refSchema = z
	.string()
	.min(1)
	.max(255)
	.refine((v) => !/\s|\.\./.test(v), {
		message: "Not a valid branch or ref",
	});

/**
 * Best-effort run scoping. Bounded because these are forwarded verbatim to a
 * third-party API, and an unbounded map is a free amplification vector.
 */
const inputsSchema = z
	.record(z.string().min(1).max(100), z.string().max(500))
	.refine((v) => Object.keys(v).length <= 20, {
		message: "At most 20 inputs",
	});

/**
 * The project's owning organization, read from the row rather than taken from
 * the caller — `requireProjectPermission` is the tenant boundary above, so no
 * caller-supplied org is trusted here (the same stance as "Sync now"). Doubles as
 * the existence check.
 */
async function requireProjectOrganizationId(
	projectId: string,
): Promise<string | null> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true },
	});
	if (!project) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}
	return project.organizationId;
}

/**
 * What can be started, per connected repo. Read-gated by TEST_CASE_READ;
 * `requireProjectPermission` is the tenant boundary and the query re-scopes by
 * projectId.
 *
 * Each source is resolved independently: a repo whose credential has expired
 * reports its own error and the others still list. Returns no credentials — this
 * is rendered in the browser.
 */
export const listTriggerablePipelinesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pipeline-results/triggerable",
		tags: ["Projects", "Test Cases"],
		summary: "List the CI pipelines Fabric could start a run in",
	})
	.input(z.object({ projectId: z.string() }))
	.handler(async ({ input, context }) => {
		assertPipelineResultsEnabled();
		const user = context.user;
		const organizationId = await requireProjectOrganizationId(
			input.projectId,
		);

		const targets = await listProjectQaTriggerTargets({
			projectId: input.projectId,
		});

		return Promise.all(
			targets.map(async (target) => {
				const base = {
					integrationId: target.integrationId,
					provider: target.provider,
					owner: target.owner,
					repo: target.repo,
					/** Pre-fills the ref: the QA override, else the repo default. */
					defaultRef: target.effectiveBranch,
				};

				const plan = deriveCiTriggerPlan(target);
				if (!plan.ok) {
					return {
						...base,
						kind: "unsupported" as const,
						pipelines: [],
						error: plan.error,
					};
				}
				// GitLab runs the config on the ref — there is nothing to list and no
				// credential call to make just to say so.
				if (plan.kind === "ref") {
					return {
						...base,
						kind: "ref" as const,
						pipelines: [],
						error: null,
					};
				}

				try {
					const { token } = await resolveFreshRepoToken({
						integrationId: target.integrationId,
						projectId: input.projectId,
						userId: user.id,
						organizationId,
					});
					if (!token) {
						return {
							...base,
							kind: "definition" as const,
							pipelines: [],
							error: `No usable ${target.provider} credential — reconnect the repository in Project Settings.`,
						};
					}
					return {
						...base,
						kind: "definition" as const,
						pipelines: await plan.listPipelines(token),
						error: null,
					};
				} catch (err) {
					const message =
						err instanceof Error ? err.message : String(err);
					logger.warn("qa.pipeline.trigger.list_failed", {
						projectId: input.projectId,
						integrationId: target.integrationId,
						provider: target.provider,
						error: message,
					});
					return {
						...base,
						kind: "definition" as const,
						pipelines: [],
						error: message,
					};
				}
			}),
		);
	});

/**
 * Start a run in one connected repo's CI.
 *
 * **Gated by TEST_CASE_UPDATE, deliberately — and this is the arguable part.**
 * Every procedure that *configures* this same credential (connect, disconnect,
 * update-branch, health, reindex) requires PROJECT_SETTINGS_EDIT, which only a
 * PROJECT_ADMIN holds. Triggering sits below that bar, so a project EDITOR who
 * was never trusted to connect the integration can still spend it to start a
 * build in the customer's CI.
 *
 * That is intended: the people this feature exists for — QA engineers and
 * developers — are EDITORs, and putting "Run tests" behind PROJECT_ADMIN would
 * make the feature unusable by its own audience. The line drawn is *configure
 * vs. use*: changing which repo and credential a project trusts stays with
 * admins, while using an already-trusted credential for the thing it was
 * connected for does not.
 *
 * Do NOT justify this by parity with "Sync now" (`sync.ts`, also
 * TEST_CASE_UPDATE). That is a read-only pull; this spends a write-capable
 * credential on the customer's own infrastructure and consumes their CI minutes.
 * The compensating control is the audit trail below, which records every
 * attempt — including the ones refused before a provider was ever called.
 *
 * A provider refusal is RETURNED, not thrown: "your workflow declares no
 * `workflow_dispatch:`" is a specific thing the user must go and fix, and it
 * belongs in a persistent panel they can read, not in a toast that disappears.
 * Only Fabric-side faults (unknown repo, missing credential) throw.
 */
export const triggerPipelineProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/pipeline-results/trigger",
		tags: ["Projects", "Test Cases"],
		summary: "Start a run in a connected repository's CI pipeline",
		description:
			"Queues a run in the customer's existing CI (GitHub Actions, GitLab CI, Azure DevOps Builds). Fabric writes no CI configuration; results arrive through the normal pipeline-results sync. Requires TEST_CASE_UPDATE.",
	})
	.input(
		z.object({
			projectId: z.string(),
			integrationId: z.string(),
			/** Omit to use the repo's QA branch, else its default branch. */
			ref: refSchema.optional(),
			/** GitHub workflow id / ADO build definition id. Unused by GitLab. */
			pipelineId: z.string().max(255).optional(),
			inputs: inputsSchema.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertPipelineResultsEnabled();
		const user = context.user;
		const organizationId = await requireProjectOrganizationId(
			input.projectId,
		);

		/**
		 * Record an attempt that never reached the provider.
		 *
		 * These paths used to throw straight out, which left the most
		 * investigation-worthy case of all with no trail: someone probing another
		 * project's integration id gets a bare 404 and the ledger never knows they
		 * asked. "Refused before we called anyone" is still an attempt to spend a
		 * customer credential, so it is audited like one.
		 */
		const auditRefusal = (failure: string, detail: string): void => {
			recordAuditFromRequest(context, {
				action: "project.ci_run.triggered",
				category: "project",
				severity: "info",
				outcome: "failure",
				projectId: input.projectId,
				resource: {
					type: "repository_integration",
					id: input.integrationId,
				},
				metadata: { failure, detail, ref: input.ref ?? null },
			});
		};

		// Scoped by projectId, so an integration id from another project simply is
		// not in the result and 404s rather than being triggered.
		const [target] = await listProjectQaTriggerTargets({
			projectId: input.projectId,
			integrationId: input.integrationId,
		});
		if (!target) {
			auditRefusal("NOT_CONNECTED", "Repository is not connected");
			throw new ORPCError("NOT_FOUND", {
				message: "Repository is not connected to this project",
			});
		}

		const plan = deriveCiTriggerPlan(target);
		if (!plan.ok) {
			auditRefusal("UNSUPPORTED", plan.error);
			throw new ORPCError("BAD_REQUEST", { message: plan.error });
		}

		const ref = input.ref ?? target.effectiveBranch;

		const { token } = await resolveFreshRepoToken({
			integrationId: target.integrationId,
			projectId: input.projectId,
			userId: user.id,
			organizationId,
		});
		if (!token) {
			auditRefusal(
				"NO_CREDENTIAL",
				`No usable ${target.provider} credential`,
			);
			throw new ORPCError("BAD_REQUEST", {
				message: `No usable ${target.provider} credential — reconnect the repository in Project Settings before starting a run.`,
			});
		}

		let result: CiTriggerResult;
		try {
			if (plan.kind === "definition") {
				// The union makes this the only place the id can be required, so
				// there is no "definitely set by now" assertion further down.
				if (!input.pipelineId) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							target.provider === "GITHUB"
								? "Choose which workflow to run."
								: "Choose which build pipeline to run.",
					});
				}
				result = await plan.trigger(token, {
					ref,
					pipelineId: input.pipelineId,
					inputs: input.inputs,
				});
			} else {
				result = await plan.trigger(token, {
					ref,
					inputs: input.inputs,
				});
			}
		} catch (err) {
			// "Choose a pipeline" is a caller mistake, not a provider fault — it
			// must stay a 4xx rather than be folded into an outcome that reads as
			// "your CI is unreachable".
			if (err instanceof ORPCError) {
				throw err;
			}
			// The provider clients answer bad statuses with a rejection object, so
			// reaching here means the request never completed: a DNS failure, a
			// dropped connection, or the 20s `AbortSignal.timeout` firing. Left
			// unhandled that surfaces as an opaque 500, which tells the user
			// nothing and — worse — skips the audit row for an attempt that may
			// well have reached the provider. Both are avoided by folding it into
			// the same outcome shape every other refusal uses.
			result = {
				ok: false,
				failure: "PROVIDER_ERROR",
				message: `Fabric couldn't reach ${target.provider} to start the run. It may have timed out — check your CI provider before trying again. (${
					err instanceof Error ? err.message : String(err)
				})`,
			};
		}

		logger.info("qa.pipeline.trigger.attempted", {
			projectId: input.projectId,
			integrationId: target.integrationId,
			provider: target.provider,
			ref,
			pipelineId: input.pipelineId ?? null,
			ok: result.ok,
			failure: result.ok ? null : result.failure,
			userId: user.id,
		});

		// SOC 2 CC6/CC7: Fabric used a stored customer credential to start work in
		// the customer's own infrastructure. That is the kind of outward action an
		// investigation needs an immutable actor trail for, so a refusal is recorded
		// as deliberately as a success.
		recordAuditFromRequest(context, {
			action: "project.ci_run.triggered",
			category: "project",
			severity: "info",
			outcome: result.ok ? "success" : "failure",
			projectId: input.projectId,
			resource: {
				type: "repository_integration",
				id: target.integrationId,
			},
			metadata: {
				provider: target.provider,
				ref,
				pipelineId: input.pipelineId ?? null,
				// Which inputs were forwarded, never their values — they are
				// user-supplied and forwarded to a third party.
				inputKeys: Object.keys(input.inputs ?? {}),
				runId: result.ok ? result.runId : null,
				failure: result.ok ? null : result.failure,
			},
		});

		return result;
	});
