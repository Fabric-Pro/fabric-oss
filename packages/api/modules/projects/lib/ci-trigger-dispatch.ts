/**
 * Map a connected repo to the provider call that starts a run in its CI. The
 * mirror of `derivePlan` in the pipeline-results sync activity:
 * pure, credential-free, and unit-testable without touching the network.
 *
 * Providers split on one axis that the caller genuinely has to care about —
 * whether a definition must be chosen before anything can run:
 *
 *  - GitHub and Azure DevOps run a *definition* (a workflow / a build pipeline),
 *    so the user picks one and the id is required.
 *  - GitLab runs a *ref*: it reads the `.gitlab-ci.yml` that exists on that ref
 *    and there is nothing to pick.
 *
 * That split is encoded as a discriminated union rather than an optional field,
 * so a caller cannot reach a GitHub trigger without a workflow id and there is no
 * "this is definitely set by now" assertion anywhere.
 */

import { type ProjectQaTriggerTarget, parseRepoUrl } from "@repo/database";
import {
	type CiTriggerResult,
	gitlabPipelineApiBase,
	listAdoBuildDefinitions,
	listGithubWorkflows,
	type TriggerablePipeline,
	triggerAdoBuild,
	triggerGithubWorkflow,
	triggerGitlabPipeline,
} from "@repo/integrations/ci-trigger";

/**
 * Best-effort run scoping. These only narrow the run where the
 * customer's own pipeline declares matching inputs/variables/parameters AND its
 * test command consumes them; where it does not, the whole suite runs. Never
 * block a trigger on them.
 */
type TriggerInputs = Record<string, string>;

export type CiTriggerPlan =
	| {
			ok: true;
			/** The provider runs a chosen definition: GitHub Actions, ADO Builds. */
			kind: "definition";
			listPipelines: (token: string) => Promise<TriggerablePipeline[]>;
			trigger: (
				token: string,
				options: {
					ref: string;
					pipelineId: string;
					inputs?: TriggerInputs;
				},
			) => Promise<CiTriggerResult>;
	  }
	| {
			ok: true;
			/** The provider runs whatever config exists on the ref: GitLab CI. */
			kind: "ref";
			trigger: (
				token: string,
				options: { ref: string; inputs?: TriggerInputs },
			) => Promise<CiTriggerResult>;
	  }
	| { ok: false; error: string };

export function deriveCiTriggerPlan(
	target: ProjectQaTriggerTarget,
): CiTriggerPlan {
	switch (target.provider) {
		case "GITHUB": {
			if (!target.owner || !target.repo) {
				return {
					ok: false,
					error: "Could not determine the GitHub owner/repo for this repository.",
				};
			}
			const { owner, repo } = target;
			return {
				ok: true,
				kind: "definition",
				listPipelines: (token) =>
					listGithubWorkflows({ token, owner, repo }),
				trigger: (token, options) =>
					triggerGithubWorkflow({
						token,
						owner,
						repo,
						workflowId: options.pipelineId,
						ref: options.ref,
						inputs: options.inputs,
					}),
			};
		}

		case "GITLAB": {
			if (!target.owner || !target.repo) {
				return {
					ok: false,
					error: "Could not determine the GitLab project path for this repository.",
				};
			}
			// Same SSRF-guarded host derivation the results fetcher uses, so a repo
			// that can be read can be triggered and vice versa.
			const apiBase = gitlabPipelineApiBase(target.repositoryUrl);
			if (!apiBase) {
				return {
					ok: false,
					error: "The GitLab repository URL is not a usable https host for API access.",
				};
			}
			const projectPath = `${target.owner}/${target.repo}`;
			return {
				ok: true,
				kind: "ref",
				trigger: (token, options) =>
					triggerGitlabPipeline({
						token,
						apiBase,
						projectPath,
						ref: options.ref,
						variables: options.inputs,
					}),
			};
		}

		case "AZURE_DEVOPS": {
			// The ADO project segment lives in the repo URL, not in its own column;
			// `azureOrganization` wins for the org when the integration stored it.
			const parsed = parseRepoUrl(target.repositoryUrl);
			const organization = target.azureOrganization || parsed?.owner;
			const project = parsed?.project;
			if (
				!parsed ||
				parsed.provider !== "AZURE_DEVOPS" ||
				!organization ||
				!project
			) {
				return {
					ok: false,
					error: "Could not determine the Azure DevOps org/project from the repository URL.",
				};
			}
			return {
				ok: true,
				kind: "definition",
				listPipelines: (pat) =>
					listAdoBuildDefinitions({ pat, organization, project }),
				trigger: (pat, options) =>
					triggerAdoBuild({
						pat,
						organization,
						project,
						definitionId: options.pipelineId,
						sourceBranch: options.ref,
						parameters: options.inputs,
					}),
			};
		}

		default: {
			// RepositoryProvider is a closed enum, so a new provider fails to compile
			// here until it is handled — the same exhaustiveness tie the sync path
			// uses, rather than a runtime hope.
			const unsupported: never = target.provider;
			return {
				ok: false,
				error: `Starting a run isn't supported for ${String(unsupported)} repositories yet.`,
			};
		}
	}
}
