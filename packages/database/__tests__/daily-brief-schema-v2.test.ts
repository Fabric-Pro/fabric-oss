import { describe, expect, it } from "vitest";
import {
	DAILY_BRIEF_SCHEMA_VERSION,
	dailyBriefContentSchema,
} from "../src/daily-brief-schema";

describe("daily-brief schema v2", () => {
	it("exposes schema version 2", () => {
		expect(DAILY_BRIEF_SCHEMA_VERSION).toBe(2);
	});

	it("parses a v2 content blob with all new optional fields", () => {
		const content = {
			schemaVersion: 2,
			executiveSummary: "quiet week",
			priorityActions: [],
			sections: {},
			storylines: [
				{
					storyCuid: "cstory1",
					storyIdentifier: "F-12",
					headline: "Refund split",
					narrative: "Decision then PR then doc update",
					relatedItems: [
						{
							kind: "github",
							refId: "pr-412",
							occurredAt: new Date().toISOString(),
						},
					],
				},
			],
			ahead: [
				{
					kind: "upcoming_meeting",
					title: "Sprint review",
					occursAt: new Date().toISOString(),
					fabricLink: "/app/projects/p1/meetings/m1",
				},
			],
		};
		const parsed = dailyBriefContentSchema.safeParse(content);
		expect(parsed.success).toBe(true);
	});

	it("still accepts a v1-shaped blob at schemaVersion: 1", () => {
		const v1 = {
			schemaVersion: 1,
			executiveSummary: "",
			priorityActions: [],
			sections: {},
		};
		const parsed = dailyBriefContentSchema.safeParse(v1);
		expect(parsed.success).toBe(true);
	});
});
