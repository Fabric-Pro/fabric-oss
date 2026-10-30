/**
 * The topic assistant describes the open Publishing Suite topic in a readable.
 * Before this, nothing read it, so asked for the topic's title the agent
 * searched project knowledge and named an unrelated line.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildPublishingTopicSection,
	PUBLISHING_TOPIC_READABLE,
	readPublishingTopic,
} from "../publishing-topic";

const TOPIC_ASSISTANT_PATH = join(
	__dirname,
	"../../../../apps/web/modules/saas/projects/components/publishing-suite/TopicAssistant.tsx",
);

const READABLE_VALUE = {
	title: "Brand Refresh: New Primary Accent Color",
	angle: "Feature deep-dive",
	pitch: "The primary accent moves from blue to green across the app.",
	status: "SUGGESTED",
	contentFormats: ["BLOG_POST", "LINKEDIN_POST"],
	unansweredQuestions: ["Which screens ship first?", "  "],
	planningAnalysis: "## Audience\nDesign-minded users.",
};

describe("readPublishingTopic", () => {
	it("reads every field the topic assistant sends", () => {
		expect(readPublishingTopic(READABLE_VALUE)).toEqual({
			title: "Brand Refresh: New Primary Accent Color",
			angle: "Feature deep-dive",
			pitch: "The primary accent moves from blue to green across the app.",
			status: "SUGGESTED",
			contentFormats: ["BLOG_POST", "LINKEDIN_POST"],
			unansweredQuestions: ["Which screens ship first?"],
			planningAnalysis: "## Audience\nDesign-minded users.",
		});
	});

	it("treats a null angle and pitch as absent", () => {
		const topic = readPublishingTopic({
			...READABLE_VALUE,
			angle: null,
			pitch: null,
		});
		expect(topic?.angle).toBeUndefined();
		expect(topic?.pitch).toBeUndefined();
	});

	it("is not a topic without a title", () => {
		expect(
			readPublishingTopic({ ...READABLE_VALUE, title: "" }),
		).toBeUndefined();
		expect(readPublishingTopic(undefined)).toBeUndefined();
		expect(readPublishingTopic("Brand Refresh")).toBeUndefined();
	});
});

describe("buildPublishingTopicSection", () => {
	const topic = readPublishingTopic(READABLE_VALUE);
	if (!topic) throw new Error("fixture must read as a topic");

	it("names the topic, its angle, pitch, formats and open questions", () => {
		const section = buildPublishingTopicSection(topic, "");
		expect(section).toContain("## Publishing Topic");
		expect(section).toContain(
			"**Title:** Brand Refresh: New Primary Accent Color",
		);
		expect(section).toContain("**Angle:** Feature deep-dive");
		expect(section).toContain(
			"**Pitch:** The primary accent moves from blue to green across the app.",
		);
		expect(section).toContain(
			"**Content formats:** BLOG_POST, LINKEDIN_POST",
		);
		expect(section).toContain("- Which screens ship first?");
	});

	it("carries the planning analysis when the run's document does not", () => {
		expect(buildPublishingTopicSection(topic, "")).toContain(
			"**Planning analysis:**\n\n## Audience\nDesign-minded users.",
		);
	});

	it("does not repeat a planning analysis the document already holds", () => {
		expect(
			buildPublishingTopicSection(
				topic,
				"## Audience\nDesign-minded users.\n",
			),
		).not.toContain("**Planning analysis:**");
	});
});

it("matches the description the topic assistant gives its readable", () => {
	const source = readFileSync(TOPIC_ASSISTANT_PATH, "utf-8");
	const description = source.match(
		/useCopilotReadable\(\{\s*description:\s*"([^"]+)"/,
	)?.[1];
	expect(description?.toLowerCase()).toContain(PUBLISHING_TOPIC_READABLE);
});
