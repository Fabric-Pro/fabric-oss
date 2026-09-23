/**
 * How the orchestrator names the project a conversation is attached to.
 *
 * The up-front clarity gate never saw the attached project, so "list the
 * meeting transcripts for this project" drew "which project?" although one was
 * attached (Fizzy #2040, F41). Both uses below ship behind
 * `orchestrator-clarity-project-context-v1`.
 */

const CLARITY_DESCRIPTION_LIMIT = 500;

/** The short project summary handed to the clarity gate. */
export function buildClarityProjectContext(project: {
	name: string;
	description?: string | null;
}): string {
	const description = project.description?.trim();
	return [
		`Attached project: ${project.name}`,
		description
			? `Description: ${description.slice(0, CLARITY_DESCRIPTION_LIMIT)}`
			: null,
	]
		.filter(Boolean)
		.join("\n");
}

/** One line inside `<project_context>` so the agent loop does not ask either. */
export function attachedProjectReferenceLine(projectName: string): string {
	return `This conversation is attached to the project "${projectName}". "This project", "the project" or "our project" means it — use it without asking which project.`;
}
