/**
 * Starting a run in a customer's EXISTING CI pipeline.
 *
 * Fabric triggers; it never writes CI configuration, creates repositories, or
 * pushes to a customer repo. Results come back through the pipeline-results sync
 * that already exists, so nothing downstream of ingestion changes.
 */

export {
	listAdoBuildDefinitions,
	triggerAdoBuild,
} from "./azure-devops";
export { listGithubWorkflows, triggerGithubWorkflow } from "./github";
export { gitlabPipelineApiBase, triggerGitlabPipeline } from "./gitlab";
export type {
	CiTriggerFailure,
	CiTriggerProvider,
	CiTriggerRejection,
	CiTriggerResult,
	CiTriggerSuccess,
	TriggerablePipeline,
} from "./types";
