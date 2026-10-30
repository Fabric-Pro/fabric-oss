/**
 * The editor's frontend actions a client Proposal's chat may offer, as the
 * agent binds them (Fizzy #2946).
 *
 * The browser sends each frontend action with its own description and
 * argument schema, and the model reads both as instructions. On a Proposal
 * run the agent binds these definitions instead and ignores what the browser
 * sent beside a name, so no client text reaches the model as a tool's
 * description or schema.
 *
 * Each is the definition the editor registers, from
 * `@repo/utils/editor-frontend-actions`, as the JSON schema CopilotKit sends
 * for it, so the two cannot drift. Where the editor names the project's
 * repository, the description here says the same without it. The
 * clarifying-question policy is the one the route resolved for the project,
 * or the default tier's when it sent none.
 */

import {
	askClarifyingQuestionAction,
	CONFIRM_CHANGES_ACTION,
	CREATE_VIEW_ACTION,
	clarifyingQuestionPolicy,
	FETCH_MEETING_NOTES_ACTION,
	type FrontendActionJsonDefinition,
	frontendActionJsonDefinition,
	githubGetFileContentsAction,
	githubGetRepositoryAction,
	githubListIssuesAction,
	githubListPullRequestsAction,
	gitlabGetFileContentsAction,
	gitlabGetProjectAction,
	gitlabListIssuesAction,
	gitlabListMergeRequestsAction,
	REGENERATE_DOCUMENT_ACTION,
	SELECT_MEETINGS_ACTION,
} from "@repo/utils/editor-frontend-actions";

/** A frontend action as the agent binds it, in the shape CopilotKit sends. */
export type FrontendActionDefinition = FrontendActionJsonDefinition;

/**
 * Every frontend action a Proposal run may bind, in the order the agent binds
 * them, with the clarifying-question card carrying `clarifyingPolicy` (the
 * default tier's built-in policy when null).
 */
export function proposalFrontendActionDefinitions(
	clarifyingPolicy: string | null,
): FrontendActionDefinition[] {
	return [
		CONFIRM_CHANGES_ACTION,
		REGENERATE_DOCUMENT_ACTION,
		askClarifyingQuestionAction(
			clarifyingPolicy ?? clarifyingQuestionPolicy("BALANCED"),
		),
		SELECT_MEETINGS_ACTION,
		FETCH_MEETING_NOTES_ACTION,
		CREATE_VIEW_ACTION,
		githubGetFileContentsAction(null),
		githubGetRepositoryAction(null),
		githubListPullRequestsAction(null),
		githubListIssuesAction(null),
		gitlabGetFileContentsAction(null),
		gitlabGetProjectAction(null),
		gitlabListMergeRequestsAction(null),
		gitlabListIssuesAction(null),
	].map(frontendActionJsonDefinition);
}
