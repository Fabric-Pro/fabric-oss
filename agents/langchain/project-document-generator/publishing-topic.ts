/**
 * The Publishing Suite's topic assistant runs this agent beside one topic and
 * describes that topic in a readable whose description starts "The publishing
 * topic currently open" (`TopicAssistant.tsx`). Its state carries only the
 * planning analysis as the document, so without this section the model never
 * learns which topic it is discussing.
 */

/** Matched against the readable's description, as the other readables are. */
export const PUBLISHING_TOPIC_READABLE = "publishing topic";

export interface PublishingTopic {
	title: string;
	angle?: string;
	pitch?: string;
	status?: string;
	contentFormats: string[];
	unansweredQuestions: string[];
	planningAnalysis?: string;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function texts(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => text(entry) ?? []);
}

/** Reads the readable's value; anything without a title is not a topic. */
export function readPublishingTopic(
	value: unknown,
): PublishingTopic | undefined {
	if (!value || typeof value !== "object") return undefined;
	const fields = new Map(Object.entries(value));
	const title = text(fields.get("title"));
	if (!title) return undefined;
	return {
		title,
		angle: text(fields.get("angle")),
		pitch: text(fields.get("pitch")),
		status: text(fields.get("status")),
		contentFormats: texts(fields.get("contentFormats")),
		unansweredQuestions: texts(fields.get("unansweredQuestions")),
		planningAnalysis: text(fields.get("planningAnalysis")),
	};
}

/**
 * The prompt section for the open topic. The planning analysis is repeated
 * only when the run's document does not already hold it, so a long analysis
 * is not sent twice.
 */
export function buildPublishingTopicSection(
	topic: PublishingTopic,
	currentDocument: string | undefined,
): string {
	const lines = [
		"---",
		"",
		"## Publishing Topic",
		"",
		`**Title:** ${topic.title}`,
	];
	if (topic.angle) lines.push(`**Angle:** ${topic.angle}`);
	if (topic.pitch) lines.push(`**Pitch:** ${topic.pitch}`);
	if (topic.status) lines.push(`**Status:** ${topic.status}`);
	if (topic.contentFormats.length > 0) {
		lines.push(`**Content formats:** ${topic.contentFormats.join(", ")}`);
	}
	if (topic.unansweredQuestions.length > 0) {
		lines.push(
			"",
			"**Unanswered questions:**",
			...topic.unansweredQuestions.map((question) => `- ${question}`),
		);
	}
	if (
		topic.planningAnalysis &&
		topic.planningAnalysis !== currentDocument?.trim()
	) {
		lines.push("", "**Planning analysis:**", "", topic.planningAnalysis);
	}
	lines.push(
		"",
		"This is the topic the user is looking at. Answer questions about it from these fields, and keep any rewrite of the planning analysis consistent with them.",
	);
	return `\n\n${lines.join("\n")}`;
}
