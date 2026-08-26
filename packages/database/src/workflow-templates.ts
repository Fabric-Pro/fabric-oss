/**
 * Template Workflow Mapping
 *
 * Defines which agent templates have dedicated Temporal workflows.
 * Templates not listed here will be routed to the Orchestrator.
 */

export interface TemplateWorkflowConfig {
	/** Temporal workflow name */
	workflowName: string;
	/** Temporal task queue */
	taskQueue: string;
	/** Whether the workflow supports progress tracking */
	hasProgress: boolean;
	/** Whether the workflow uses sub-agents */
	hasSubAgents: boolean;
	/** Default max iterations for iterative workflows */
	defaultMaxIterations?: number;
	/** Default max sub-agents */
	defaultMaxSubAgents?: number;
}

/**
 * Mapping of template slugs to their dedicated Temporal workflow configurations.
 * Templates not in this map will be routed to the Orchestrator.
 */
export const TEMPLATE_WORKFLOWS: Record<string, TemplateWorkflowConfig> = {
	"deep-researcher": {
		workflowName: "deepResearcherWorkflow",
		taskQueue: "fabric-worker",
		hasProgress: true,
		hasSubAgents: true,
		defaultMaxIterations: 3,
		defaultMaxSubAgents: 6,
	},
	// Future templates with dedicated workflows can be added here:
	// "code-reviewer": {
	//   workflowName: "codeReviewerWorkflow",
	//   taskQueue: "fabric-worker",
	//   hasProgress: true,
	//   hasSubAgents: false,
	// },
} as const;

/**
 * Get the workflow configuration for a template slug.
 * Returns null if the template should use the Orchestrator.
 *
 * @param templateSlug - The slug of the agent template
 * @returns Workflow configuration or null if not a workflow template
 */
export function getTemplateWorkflow(
	templateSlug: string,
): TemplateWorkflowConfig | null {
	return TEMPLATE_WORKFLOWS[templateSlug] ?? null;
}

/**
 * Check if a template has a dedicated workflow.
 *
 * @param templateSlug - The slug of the agent template
 * @returns true if the template has a dedicated workflow
 */
export function hasTemplateWorkflow(templateSlug: string): boolean {
	return templateSlug in TEMPLATE_WORKFLOWS;
}

/**
 * Get all template slugs that have dedicated workflows.
 *
 * @returns Array of template slugs with workflows
 */
export function getWorkflowTemplateSlugs(): string[] {
	return Object.keys(TEMPLATE_WORKFLOWS);
}
