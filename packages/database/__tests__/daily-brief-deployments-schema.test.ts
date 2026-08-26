import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type DeploymentItem,
	dailyBriefContentSchema,
	deploymentItemSchema,
} from "../src/daily-brief-schema";

describe("deploymentItemSchema", () => {
	it("parses a representative release item", () => {
		const item: DeploymentItem = {
			occurredAt: new Date("2026-06-07T10:00:00Z"),
			title: "v1.2.0 — Refunds",
			repoFullName: "Fabric-Pro/fabric",
			tagName: "v1.2.0",
			releaseName: "v1.2.0 — Refunds",
			url: "https://github.com/Fabric-Pro/fabric/releases/tag/v1.2.0",
			author: "octocat",
			body: "## What's changed\n- Refund split",
		};
		const parsed = deploymentItemSchema.parse(item);
		expect(parsed.tagName).toBe("v1.2.0");
		expect(parsed.occurredAt).toBeInstanceOf(Date);
	});

	it("coerces occurredAt from an ISO string and allows optional body", () => {
		const parsed = deploymentItemSchema.parse({
			occurredAt: "2026-06-07T10:00:00Z",
			title: "v1.0.0",
			repoFullName: "o/r",
			tagName: "v1.0.0",
			url: "https://x/y",
		});
		expect(parsed.occurredAt).toBeInstanceOf(Date);
		expect(parsed.body).toBeUndefined();
	});
});

describe("dailyBriefContentSchema deployments compatibility", () => {
	const base = {
		schemaVersion: 2 as const,
		executiveSummary: "x",
		priorityActions: [],
	};

	it("preserves sections.deployments and deploymentsError (forward)", () => {
		const parsed = dailyBriefContentSchema.parse({
			...base,
			sections: {
				deployments: [
					{
						occurredAt: "2026-06-07T10:00:00Z",
						title: "v1.0.0",
						repoFullName: "o/r",
						tagName: "v1.0.0",
						url: "https://x/y",
					},
				],
			},
			deploymentsError: "o/r: GitHub API error: 503",
		});
		expect(parsed.sections.deployments).toHaveLength(1);
		expect(parsed.deploymentsError).toBe("o/r: GitHub API error: 503");
	});

	it("parses a pre-deployments blob (backward)", () => {
		const parsed = dailyBriefContentSchema.parse({
			...base,
			sections: { github: [] },
		});
		expect(parsed.sections.deployments).toBeUndefined();
		expect(parsed.deploymentsError).toBeUndefined();
	});

	it("rollback contract: an old reader strips the new OPTIONAL fields without throwing", () => {
		// Simulates an OLD app build whose schema predates the deployments fields.
		// New data is added ONLY as optional keys (sections.deployments,
		// deploymentsError) — never as a new partialFailures.source enum value — so a
		// strict old reader strips them rather than rejecting the whole brief.
		const legacyContent = z
			.object({
				schemaVersion: z.union([z.literal(1), z.literal(2)]),
				executiveSummary: z.string(),
				priorityActions: z.array(z.any()),
				sections: z.object({ github: z.array(z.any()).optional() }),
				partialFailures: z
					.array(
						z.object({
							source: z.enum(["github"]),
							reason: z.string(),
						}),
					)
					.optional(),
			})
			.parse({
				...base,
				sections: { github: [], deployments: [{ tagName: "v1.0.0" }] },
				deploymentsError: "o/r: down",
				partialFailures: [{ source: "github", reason: "x" }],
			});
		expect(legacyContent).not.toHaveProperty("deploymentsError");
		expect(legacyContent.sections).not.toHaveProperty("deployments");
		expect(legacyContent.partialFailures).toHaveLength(1);
	});

	it("guard: the schema must NOT accept a 'deployments' partialFailures source", () => {
		// A strict z.enum value would make a rolled-back reader reject the entire
		// blob; deployment failures are surfaced via deploymentsError instead.
		const result = dailyBriefContentSchema.safeParse({
			...base,
			sections: {},
			partialFailures: [{ source: "deployments", reason: "x" }],
		});
		expect(result.success).toBe(false);
	});
});

describe("latestProdRelease (prod-release anchor)", () => {
	const base = {
		schemaVersion: 2 as const,
		executiveSummary: "x",
		priorityActions: [],
		sections: {},
	};

	it("accepts a brief carrying latestProdRelease and round-trips it", () => {
		const parsed = dailyBriefContentSchema.safeParse({
			...base,
			latestProdRelease: {
				occurredAt: "2026-06-05T10:00:00Z",
				title: "v1.3.6",
				repoFullName: "o/r",
				tagName: "v1.3.6",
				url: "https://github.com/o/r/releases/tag/v1.3.6",
				author: "bot",
				body: "notes",
			},
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.latestProdRelease?.tagName).toBe("v1.3.6");
		}
	});

	it("is optional — an old blob without it still validates", () => {
		expect(dailyBriefContentSchema.safeParse(base).success).toBe(true);
	});
});
