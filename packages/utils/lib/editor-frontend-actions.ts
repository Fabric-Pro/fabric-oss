/**
 * The document editor's CopilotKit frontend actions, defined once
 * (Fizzy #2946).
 *
 * The editor registers each with `useCopilotAction` (`DocumentEditor`,
 * `useClarifyingQuestions`, the Excalidraw render in
 * `useDefaultMcpInlineRender`). On a client Proposal's chat the project
 * document agent binds the same definitions in place of the description and
 * schema the browser sent, so no client text reaches the model as a tool's
 * description. Both read them here, so the two cannot drift.
 *
 * A definition is the action's name, its description and its parameters in
 * CopilotKit's `Parameter[]` form, which `useCopilotAction` takes as they
 * are. {@link frontendActionJsonDefinition} gives the JSON schema the agent
 * binds, derived the way CopilotKit derives it.
 *
 * Where the editor's description names the project's repository or carries
 * the project's clarifying-question policy, the definition is a builder: the
 * editor passes what it knows, and the agent, which takes no client text,
 * passes no repository and the policy the server resolved.
 *
 * Pure and browser-safe.
 */

/** A parameter type, as CopilotKit names them. */
type EditorActionParameterType =
	| "string"
	| "number"
	| "boolean"
	| "object"
	| "string[]"
	| "number[]"
	| "boolean[]"
	| "object[]";

/** A parameter in CopilotKit's `Parameter` form. */
export interface EditorActionParameter {
	name: string;
	type: EditorActionParameterType;
	description?: string;
	/** Required unless `false`, as CopilotKit reads it. */
	required?: boolean;
	attributes?: EditorActionParameter[];
}

export interface EditorActionDefinition<
	P extends EditorActionParameter[] = EditorActionParameter[],
> {
	name: string;
	description: string;
	parameters: P;
}

/** A frontend action as the agent binds it: the JSON schema CopilotKit sends. */
export interface FrontendActionJsonDefinition {
	name: string;
	description: string;
	parameters: {
		type: "object";
		properties: Record<string, unknown>;
		required: string[];
	};
}

/**
 * A definition with its parameters' literal types kept, so
 * `useCopilotAction` types its handler's arguments from them as it does
 * from parameters written inline.
 */
function defineAction<const P extends EditorActionParameter[]>(
	name: string,
	description: string,
	parameters: P,
): EditorActionDefinition<P> {
	return { name, description, parameters };
}

/** A parameter list with its literal types kept, as {@link defineAction}. */
function defineParameters<const P extends EditorActionParameter[]>(
	parameters: P,
): P {
	return parameters;
}

// =============================================================================
// JSON schema
// =============================================================================

function parameterSchema(
	parameter: EditorActionParameter,
): Record<string, unknown> {
	const described =
		parameter.description === undefined
			? {}
			: { description: parameter.description };
	switch (parameter.type) {
		case "string":
		case "number":
		case "boolean":
			return { type: parameter.type, ...described };
		case "object":
		case "object[]": {
			const attributes = parameter.attributes;
			const required =
				attributes
					?.filter((attribute) => attribute.required !== false)
					.map((attribute) => attribute.name) ?? [];
			const body = {
				...(attributes
					? {
							properties: Object.fromEntries(
								attributes.map((attribute) => [
									attribute.name,
									parameterSchema(attribute),
								]),
							),
						}
					: {}),
				...(required.length > 0 ? { required } : {}),
			};
			return parameter.type === "object[]"
				? {
						type: "array",
						items: { type: "object", ...body },
						...described,
					}
				: { type: "object", ...described, ...body };
		}
		default:
			return {
				type: "array",
				items: { type: parameter.type.slice(0, -2) },
				...described,
			};
	}
}

/**
 * The parameters as a JSON schema object, as CopilotKit's
 * `actionParametersToJsonSchema` builds it: a parameter is required unless it
 * says `required: false`. A description left out stays out.
 */
export function editorActionParametersSchema(
	parameters: readonly EditorActionParameter[],
): FrontendActionJsonDefinition["parameters"] {
	return {
		type: "object",
		properties: Object.fromEntries(
			parameters.map((parameter) => [
				parameter.name,
				parameterSchema(parameter),
			]),
		),
		required: parameters
			.filter((parameter) => parameter.required !== false)
			.map((parameter) => parameter.name),
	};
}

/** The definition as the agent binds it. */
export function frontendActionJsonDefinition(
	definition: EditorActionDefinition,
): FrontendActionJsonDefinition {
	return {
		name: definition.name,
		description: definition.description,
		parameters: editorActionParametersSchema(definition.parameters),
	};
}

// =============================================================================
// Confirm card and Regenerate
// =============================================================================

/**
 * The accept/reject card for a proposed change. The editor registers it with
 * no description and no parameters; the agent calls it itself.
 */
export const CONFIRM_CHANGES_ACTION = defineAction("confirm_changes", "", []);

export const REGENERATE_DOCUMENT_ACTION = defineAction(
	"regenerate_document",
	"Fully regenerate document content from scratch using AI with project context and RAG. Use this for major rewrites, not iterative edits.",
	[
		{
			name: "prompt",
			type: "string",
			description:
				"Instructions for what to generate (e.g., 'Regenerate the entire PRD with more technical details')",
			required: true,
		},
	],
);

// =============================================================================
// Meetings
// =============================================================================

export const SELECT_MEETINGS_ACTION = defineAction(
	"select_meetings",
	"Show a meeting selector. On confirmation the application fetches transcripts and returns them for document editing; do not call fetchMeetingNotes afterwards.",
	[],
);

export const FETCH_MEETING_NOTES_ACTION = defineAction(
	"fetchMeetingNotes",
	"Compatibility read of transcripts fetched by the current meeting selection. Does not start another fetch. Use the transcript text returned by select_meetings to edit the document.",
	[
		{
			name: "selectedMeetings",
			type: "object[]",
			attributes: [
				{ name: "joinUrl", type: "string", required: true },
				{ name: "startTime", type: "string", required: false },
			],
			description:
				"The selectedMeetings array returned by select_meetings. Pass it directly.",
			required: true,
		},
	],
);

// =============================================================================
// Clarifying questions
// =============================================================================

export type ClarifyingQuestionFrequency = "MINIMAL" | "BALANCED" | "THOROUGH";

/**
 * The built-in clarifying-question policy for a frequency tier: what the
 * model reads when the Prompt Library has no `clarifying_questions` prompt
 * for the tier.
 */
export function clarifyingQuestionPolicy(
	frequency: ClarifyingQuestionFrequency,
): string {
	switch (frequency) {
		case "MINIMAL":
			return [
				"Clarifying-question policy: MINIMAL.",
				"Avoid interrupting the user with questions. Make a reasonable assumption and proceed.",
				"Only call `ask_clarifying_question` when you genuinely cannot proceed without the user's input —",
				"at most one question, and only when it truly blocks progress.",
			].join(" ");
		case "THOROUGH":
			return [
				"Clarifying-question policy: THOROUGH.",
				"Proactively call `ask_clarifying_question` whenever additional detail would meaningfully improve the result.",
				"You may ask up to 3 focused questions per turn, one card at a time, each with up to 3 short suggested answers.",
			].join(" ");
		default:
			return [
				"Clarifying-question policy: BALANCED.",
				"Call `ask_clarifying_question` when there is material ambiguity that would change the output;",
				"otherwise proceed with a reasonable approach. At most one question per turn.",
			].join(" ");
	}
}

/**
 * The clarifying-question card, with the project's policy embedded in the
 * description: a bound tool's description always reaches the model.
 */
export function askClarifyingQuestionAction(policy: string) {
	return defineAction(
		"ask_clarifying_question",
		"Use this tool to ask the user a single clarifying or follow-up question and wait " +
			"for their answer. ALWAYS call this tool to ask a clarifying question — never write " +
			"the question as plain text. Provide a concise question and up to 3 short, distinct " +
			"suggested answers in `options` (the user can also type their own answer). The tool " +
			"returns the user's answer; continue using it. If the result indicates the user " +
			"dismissed it (answered: false), record the question under an Open Questions section " +
			"and pause instead of guessing. " +
			`${policy} ` +
			"Use calm, neutral language — never imply an answer is required or 'best'.",
		[
			{
				name: "question",
				type: "string",
				description:
					"The clarifying question to ask the user (one sentence).",
				required: true,
			},
			{
				name: "options",
				type: "string[]",
				description:
					"Up to 3 short, distinct suggested answers the user can click. Keep each concise and parallel in form.",
				required: false,
			},
			{
				name: "allowCustom",
				type: "boolean",
				description:
					"Whether to offer a free-text 'type your own answer' field. Defaults to true; leave unset.",
				required: false,
			},
		],
	);
}

// =============================================================================
// Excalidraw
// =============================================================================

/**
 * The managed-default Excalidraw server's `create_view`, which the browser
 * runs through `/api/mcp-app/invoke`. It draws in the chat, never in the
 * document.
 */
export const CREATE_VIEW_ACTION = defineAction(
	"create_view",
	"Create an interactive Excalidraw diagram that renders inline in the chat. " +
		"Call this tool ONLY when the user explicitly asks for an Excalidraw diagram, " +
		"a drawing, a flowchart, or an architecture diagram. NEVER call it for " +
		"conversational replies, questions, status updates, feedback, or option " +
		"discussions — when in doubt, do NOT call it and answer in text. For an " +
		"explanatory diagram inside document content, emit a mermaid code block via " +
		"the document tools instead. The diagram renders as a canvas in the " +
		"chat — it does NOT modify the document. Pair with `write_document_local` " +
		"only if the user also asks for the diagram to be referenced in the document body.",
	[
		{
			// IMPORTANT: the upstream Excalidraw MCP tool validates
			// `elements` as a **JSON-encoded string**, not a raw array
			// (confirmed by direct MCP call: `"expected": "string", "code":
			// "invalid_type"`). The LLM must therefore emit `elements` as a
			// stringified JSON array — declaring this as `string` keeps the
			// tool schema and the MCP server in lockstep.
			name: "elements",
			type: "string",
			description:
				"JSON-encoded string of a NON-EMPTY array of Excalidraw element " +
				"objects (rectangle, ellipse, diamond, arrow, text, line, " +
				'freedraw, etc.) — never send "[]". Each element needs id, type, x, y, width, ' +
				"height, angle, strokeColor, backgroundColor, fillStyle, " +
				"strokeWidth, strokeStyle, roughness, opacity, groupIds, " +
				"frameId, roundness, seed, versionNonce, isDeleted, " +
				"boundElements, updated, link, locked. Pass `JSON.stringify(elements)`. " +
				"Refer to the Excalidraw scene format spec.",
			required: true,
		},
	],
);

// =============================================================================
// Repository reads
// =============================================================================

/**
 * Each repository action takes the repository as `owner/name`, as the editor
 * names it, or null for the same text without it (the agent's).
 */
type RepositoryName = string | null;

function repositoryPathParameters() {
	return defineParameters([
		{
			name: "path",
			type: "string",
			description:
				"File or directory path in the repo (e.g. 'src/auth/middleware.ts' or 'src/')",
			required: true,
		},
		{
			name: "ref",
			type: "string",
			description:
				"Branch or commit SHA. Defaults to the project's default branch.",
			required: false,
		},
	]);
}

function stateParameters(description: string) {
	return defineParameters([
		{ name: "state", type: "string", description, required: false },
	]);
}

const GITHUB_REPOSITORY = "the project's GitHub repository";

function gitlabRepository(repository: RepositoryName): string {
	return repository
		? `${repository} on GitLab`
		: "the project's GitLab repository";
}

export function githubGetFileContentsAction(repository: RepositoryName) {
	return defineAction(
		"github_get_file_contents",
		`Read a file or list a directory from the project's GitHub repository${repository ? ` (${repository})` : ""}. Use this to look at source code, configs, READMEs, etc. when editing documents. The owner and repo are auto-filled. Just provide the file path.`,
		repositoryPathParameters(),
	);
}

export function githubGetRepositoryAction(repository: RepositoryName) {
	return defineAction(
		"github_get_repository",
		`Get repository metadata for ${repository ?? GITHUB_REPOSITORY}. Returns description, language, topics, default branch, and last updated date.`,
		[],
	);
}

export function githubListPullRequestsAction(repository: RepositoryName) {
	return defineAction(
		"github_list_pull_requests",
		`List recent pull requests from ${repository ?? GITHUB_REPOSITORY}. Useful for understanding recent changes and what's in progress.`,
		stateParameters(
			"Filter by state: 'open', 'closed', or 'all'. Defaults to 'open'.",
		),
	);
}

export function githubListIssuesAction(repository: RepositoryName) {
	return defineAction(
		"github_list_issues",
		`List recent issues from ${repository ?? GITHUB_REPOSITORY}. Useful for understanding bugs, feature requests, and open work items.`,
		stateParameters(
			"Filter by state: 'open', 'closed', or 'all'. Defaults to 'open'.",
		),
	);
}

export function gitlabGetFileContentsAction(repository: RepositoryName) {
	return defineAction(
		"gitlab_get_file_contents",
		`Read a file or list a directory from the project's GitLab repository${repository ? ` (${repository})` : ""}. Use this to look at source code, configs, READMEs, etc. when editing documents. Just provide the file path.`,
		repositoryPathParameters(),
	);
}

export function gitlabGetProjectAction(repository: RepositoryName) {
	return defineAction(
		"gitlab_get_project",
		`Get project metadata for ${gitlabRepository(repository)}. Returns description, default branch, topics, and last activity date.`,
		[],
	);
}

export function gitlabListMergeRequestsAction(repository: RepositoryName) {
	return defineAction(
		"gitlab_list_merge_requests",
		`List recent merge requests from ${gitlabRepository(repository)}. Useful for understanding recent changes and what's in progress.`,
		stateParameters(
			"Filter by state: 'opened', 'closed', 'merged', or 'all'. Defaults to 'opened'.",
		),
	);
}

export function gitlabListIssuesAction(repository: RepositoryName) {
	return defineAction(
		"gitlab_list_issues",
		`List recent issues from ${gitlabRepository(repository)}. Useful for understanding bugs, feature requests, and open work items.`,
		stateParameters(
			"Filter by state: 'opened', 'closed', or 'all'. Defaults to 'opened'.",
		),
	);
}
