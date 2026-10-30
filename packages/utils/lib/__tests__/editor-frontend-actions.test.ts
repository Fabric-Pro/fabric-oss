import { describe, expect, it } from "vitest";
import {
	askClarifyingQuestionAction,
	clarifyingQuestionPolicy,
	editorActionParametersSchema,
	FETCH_MEETING_NOTES_ACTION,
	frontendActionJsonDefinition,
	githubGetRepositoryAction,
	gitlabListIssuesAction,
} from "../editor-frontend-actions";

describe("editorActionParametersSchema", () => {
	it("derives the schema as CopilotKit does: required unless `required: false`", () => {
		expect(
			editorActionParametersSchema([
				{ name: "query", type: "string", description: "What to find." },
				{ name: "limit", type: "number", required: false },
				{ name: "tags", type: "string[]", description: "Tags." },
				{ name: "strict", type: "boolean", required: true },
			]),
		).toEqual({
			type: "object",
			properties: {
				query: { type: "string", description: "What to find." },
				limit: { type: "number" },
				tags: {
					type: "array",
					items: { type: "string" },
					description: "Tags.",
				},
				strict: { type: "boolean" },
			},
			required: ["query", "tags", "strict"],
		});
	});

	it("turns an object list into an array of objects with its own required attributes", () => {
		expect(
			frontendActionJsonDefinition(FETCH_MEETING_NOTES_ACTION).parameters,
		).toEqual({
			type: "object",
			properties: {
				selectedMeetings: {
					type: "array",
					items: {
						type: "object",
						properties: {
							joinUrl: { type: "string" },
							startTime: { type: "string" },
						},
						required: ["joinUrl"],
					},
					description:
						"The selectedMeetings array returned by select_meetings. Pass it directly.",
				},
			},
			required: ["selectedMeetings"],
		});
	});
});

describe("descriptions with the editor's dynamic parts", () => {
	it("names the repository for the editor and says the same without it for the agent", () => {
		expect(
			githubGetRepositoryAction("example-org/example-repo").description,
		).toBe(
			"Get repository metadata for example-org/example-repo. Returns description, language, topics, default branch, and last updated date.",
		);
		expect(githubGetRepositoryAction(null).description).toBe(
			"Get repository metadata for the project's GitHub repository. Returns description, language, topics, default branch, and last updated date.",
		);
		expect(
			gitlabListIssuesAction("example-org/example-repo").description,
		).toBe(
			"List recent issues from example-org/example-repo on GitLab. Useful for understanding bugs, feature requests, and open work items.",
		);
		expect(gitlabListIssuesAction(null).description).toBe(
			"List recent issues from the project's GitLab repository. Useful for understanding bugs, feature requests, and open work items.",
		);
	});

	it("embeds the clarifying-question policy in the card's description", () => {
		const policy = clarifyingQuestionPolicy("THOROUGH");
		expect(askClarifyingQuestionAction(policy).description).toContain(
			` dismissed it (answered: false), record the question under an Open Questions section and pause instead of guessing. ${policy} Use calm, neutral language`,
		);
	});
});
