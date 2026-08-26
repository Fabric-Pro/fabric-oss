import type { ProjectQaTriggerTarget } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const triggerGithubWorkflow = vi.fn();
const triggerGitlabPipeline = vi.fn();
const triggerAdoBuild = vi.fn();
const listGithubWorkflows = vi.fn();
const listAdoBuildDefinitions = vi.fn();

vi.mock("@repo/integrations/ci-trigger", () => ({
	gitlabPipelineApiBase: (url: string) =>
		url.startsWith("https://") ? `${new URL(url).origin}/api/v4` : null,
	listAdoBuildDefinitions: (...args: unknown[]) =>
		listAdoBuildDefinitions(...args),
	listGithubWorkflows: (...args: unknown[]) => listGithubWorkflows(...args),
	triggerAdoBuild: (...args: unknown[]) => triggerAdoBuild(...args),
	triggerGithubWorkflow: (...args: unknown[]) =>
		triggerGithubWorkflow(...args),
	triggerGitlabPipeline: (...args: unknown[]) =>
		triggerGitlabPipeline(...args),
}));

const { deriveCiTriggerPlan } = await import("../ci-trigger-dispatch");

function target(
	overrides: Partial<ProjectQaTriggerTarget>,
): ProjectQaTriggerTarget {
	return {
		integrationId: "int-1",
		provider: "GITHUB",
		owner: "acme",
		repo: "store",
		repositoryUrl: "https://github.com/acme/store",
		azureOrganization: null,
		defaultBranch: "main",
		qaBranch: null,
		effectiveBranch: "main",
		...overrides,
	} as ProjectQaTriggerTarget;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("deriveCiTriggerPlan", () => {
	it("routes GitHub as a definition provider and forwards the workflow id", async () => {
		const plan = deriveCiTriggerPlan(target({ provider: "GITHUB" }));

		expect(plan.ok).toBe(true);
		if (!plan.ok || plan.kind !== "definition") {
			throw new Error("expected a GitHub definition plan");
		}
		await plan.trigger("tok", { ref: "develop", pipelineId: "77" });
		expect(triggerGithubWorkflow).toHaveBeenCalledWith({
			token: "tok",
			owner: "acme",
			repo: "store",
			workflowId: "77",
			ref: "develop",
			inputs: undefined,
		});
	});

	it("routes GitLab as a ref provider — there is no definition to pick", async () => {
		const plan = deriveCiTriggerPlan(
			target({
				provider: "GITLAB",
				repositoryUrl: "https://gitlab.com/acme/store",
			}),
		);

		expect(plan.ok).toBe(true);
		if (!plan.ok || plan.kind !== "ref") {
			throw new Error("expected a GitLab ref plan");
		}
		await plan.trigger("tok", { ref: "main", inputs: { SUITE: "smoke" } });
		expect(triggerGitlabPipeline).toHaveBeenCalledWith({
			token: "tok",
			apiBase: "https://gitlab.com/api/v4",
			projectPath: "acme/store",
			ref: "main",
			variables: { SUITE: "smoke" },
		});
	});

	it("refuses a GitLab repo whose URL is not a usable API host", () => {
		const plan = deriveCiTriggerPlan(
			target({
				provider: "GITLAB",
				repositoryUrl: "git@gitlab.com:a/b.git",
			}),
		);

		expect(plan.ok).toBe(false);
		if (plan.ok) {
			return;
		}
		expect(plan.error).toContain("not a usable https host");
	});

	it("pulls the ADO org and project out of the repo URL", async () => {
		const plan = deriveCiTriggerPlan(
			target({
				provider: "AZURE_DEVOPS",
				repositoryUrl: "https://dev.azure.com/contoso/Store/_git/store",
			}),
		);

		expect(plan.ok).toBe(true);
		if (!plan.ok || plan.kind !== "definition") {
			throw new Error("expected an ADO definition plan");
		}
		await plan.trigger("pat", { ref: "main", pipelineId: "42" });
		expect(triggerAdoBuild).toHaveBeenCalledWith({
			pat: "pat",
			organization: "contoso",
			project: "Store",
			definitionId: "42",
			sourceBranch: "main",
			parameters: undefined,
		});
	});

	it("prefers the stored ADO organization over the one parsed from the URL", async () => {
		const plan = deriveCiTriggerPlan(
			target({
				provider: "AZURE_DEVOPS",
				repositoryUrl:
					"https://dev.azure.com/legacy-org/Store/_git/store",
				azureOrganization: "contoso",
			}),
		);

		if (!plan.ok || plan.kind !== "definition") {
			throw new Error("expected an ADO definition plan");
		}
		await plan.trigger("pat", { ref: "main", pipelineId: "42" });
		expect(triggerAdoBuild).toHaveBeenCalledWith(
			expect.objectContaining({ organization: "contoso" }),
		);
	});

	it("refuses an ADO repo URL with no project segment to scope builds to", () => {
		const plan = deriveCiTriggerPlan(
			target({
				provider: "AZURE_DEVOPS",
				repositoryUrl: "https://dev.azure.com/contoso/_git/store",
			}),
		);

		expect(plan.ok).toBe(false);
		if (plan.ok) {
			return;
		}
		expect(plan.error).toContain("Azure DevOps org/project");
	});
});
