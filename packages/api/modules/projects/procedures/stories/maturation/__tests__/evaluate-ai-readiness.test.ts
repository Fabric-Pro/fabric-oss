import { NoObjectGeneratedError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Array<(...args: unknown[]) => unknown> = [];
	const mocks = {
		hasProjectAccess: vi.fn(),
		userStoryFindFirst: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		generateObject: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: {
			...((actual.db as object) || {}),
			userStory: {
				findFirst: (...args: unknown[]) =>
					mocks.userStoryFindFirst(...args),
			},
		},
		hasProjectAccess: (...args: unknown[]) =>
			mocks.hasProjectAccess(...args),
		setAiUsageRecorder: vi.fn(),
	};
});

class AIProviderNotConfiguredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AIProviderNotConfiguredError";
	}
}

vi.mock("@repo/ai", async () => {
	const { zodSchema } = await import("ai");
	return {
		AIProviderNotConfiguredError,
		NoObjectGeneratedError,
		zodSchema,
		getAIModelWithMetadata: (...args: unknown[]) =>
			mocks.getAIModelWithMetadata(...args),
		generateObject: (...args: unknown[]) => mocks.generateObject(...args),
	};
});

vi.mock("../../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.push(fn);
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		requireInputOrgPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

await import("../evaluate-ai-readiness");
const {
	isEngineeringReadinessQuestion,
	partitionReadinessSections,
	stripEngineeringReadinessSections,
} = await import("../evaluate-ai-readiness");
const evaluateAiReadiness = handlers[0] as (ctx: {
	input: {
		projectId: string;
		storyId: string;
		organizationId?: string | null;
	};
	context: { user: { id: string }; session: unknown };
}) => Promise<{
	aiReadiness: {
		aiReadinessScore: number;
		tierLabel: string;
		rationale: string;
		strengths: string[];
		gaps: string[];
	};
}>;

const MODEL_WITH_METADATA = {
	model: { provider: "mock-provider" },
	metadata: {
		provider: "ANTHROPIC_DIRECT",
		maxOutputTokens: 64_000,
		contextWindow: 200_000,
	},
};

describe("evaluateAiReadinessProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws FORBIDDEN if user lacks project access", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			evaluateAiReadiness({
				input: { projectId: "proj-1", storyId: "story-1" },
				context: { user: { id: "user-1" }, session: {} },
			}),
		).rejects.toThrow("You don't have access to this project");
	});

	it("throws NOT_FOUND if userStory does not exist in the specified project", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.userStoryFindFirst.mockResolvedValue(null);

		await expect(
			evaluateAiReadiness({
				input: { projectId: "proj-1", storyId: "story-1" },
				context: { user: { id: "user-1" }, session: {} },
			}),
		).rejects.toThrow("Feature story not found");

		expect(mocks.userStoryFindFirst).toHaveBeenCalledWith({
			where: { id: "story-1", projectId: "proj-1" },
			select: expect.any(Object),
		});
	});

	it("returns AI readiness evaluation with strict personal-context tenant filtering", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			title: "Download Command.md",
			description:
				"As a developer, I want to download agent Command.md directly.",
			acceptanceCriteria:
				"GIVEN developer on detail page WHEN click download THEN file downloads.",
			createdAt: new Date(),
			lastEditedAt: null,
			decisionLogEntries: [],
		});

		mocks.getAIModelWithMetadata.mockResolvedValue(MODEL_WITH_METADATA);
		mocks.generateObject.mockResolvedValue({
			object: {
				aiReadinessScore: 85,
				tierLabel: "Nearly Ready",
				rationale: "Rich narrative and testable ACs present.",
				strengths: ["Rich specification narrative present"],
				gaps: ["No open questions"],
			},
		});

		const result = await evaluateAiReadiness({
			input: { projectId: "proj-1", storyId: "story-1" },
			context: { user: { id: "user-1" }, session: {} },
		});

		expect(result.aiReadiness).toBeDefined();
		expect(result.aiReadiness.aiReadinessScore).toBe(85);
		expect(result.aiReadiness.tierLabel).toBe("Nearly Ready");
		expect(mocks.userStoryFindFirst).toHaveBeenCalledWith({
			where: { id: "story-1", projectId: "proj-1" },
			select: expect.objectContaining({
				decisionLogEntries: expect.objectContaining({
					where: expect.objectContaining({
						parentId: null,
						deletedAt: null,
						organizationId: null,
						userId: "user-1",
					}),
				}),
			}),
		});
		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			{
				userId: "user-1",
				organizationId: undefined,
				featureKey: "maturation",
			},
		);
		expect(mocks.generateObject).toHaveBeenCalledWith(
			expect.objectContaining({
				maxOutputTokens: 16_384,
			}),
		);
	});

	it("uses org-scoped tenant filtering for decision log entries in org context", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			title: "Org Story",
			createdAt: new Date(),
			lastEditedAt: null,
			decisionLogEntries: [],
		});
		mocks.getAIModelWithMetadata.mockResolvedValue(MODEL_WITH_METADATA);
		mocks.generateObject.mockResolvedValue({
			object: {
				aiReadinessScore: 90,
				tierLabel: "Nearly Ready",
				rationale: "Good",
				strengths: [],
				gaps: [],
			},
		});

		await evaluateAiReadiness({
			input: {
				projectId: "proj-1",
				storyId: "story-1",
				organizationId: "org-1",
			},
			context: { user: { id: "user-1" }, session: {} },
		});

		expect(mocks.userStoryFindFirst).toHaveBeenCalledWith({
			where: { id: "story-1", projectId: "proj-1" },
			select: expect.objectContaining({
				decisionLogEntries: expect.objectContaining({
					where: expect.objectContaining({
						parentId: null,
						deletedAt: null,
						organizationId: "org-1",
					}),
				}),
			}),
		});
	});

	it("throws SERVICE_UNAVAILABLE when LLM model execution fails", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			title: "Download Command.md",
			description: "As a developer...",
			acceptanceCriteria: "GIVEN...",
			createdAt: new Date(),
			lastEditedAt: null,
			decisionLogEntries: [],
		});
		mocks.getAIModelWithMetadata.mockRejectedValue(
			new Error("AI Model Provider Outage"),
		);

		await expect(
			evaluateAiReadiness({
				input: { projectId: "proj-1", storyId: "story-1" },
				context: { user: { id: "user-1" }, session: {} },
			}),
		).rejects.toThrow(
			"AI readiness evaluation service is currently unavailable",
		);
	});

	it("throws helpful message when AI provider is not configured", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			projectId: "proj-1",
			title: "Unconfigured Story",
			description: "Desc",
			acceptanceCriteria: "AC",
			createdAt: new Date(),
			lastEditedAt: null,
			decisionLogEntries: [],
		});
		mocks.getAIModelWithMetadata.mockRejectedValue(
			new AIProviderNotConfiguredError("No provider configured"),
		);

		await expect(
			evaluateAiReadiness({
				input: { projectId: "proj-1", storyId: "story-1" },
				context: { user: { id: "user-1" }, session: {} },
			}),
		).rejects.toThrow(
			"No AI provider is configured. Add one in Settings → AI Providers to score readiness.",
		);
	});

	it("throws helpful message when model runs out of output token budget", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			projectId: "proj-1",
			title: "Truncated Story",
			description: "Desc",
			acceptanceCriteria: "AC",
			createdAt: new Date(),
			lastEditedAt: null,
			decisionLogEntries: [],
		});
		mocks.getAIModelWithMetadata.mockResolvedValue(MODEL_WITH_METADATA);
		const lengthError = new NoObjectGeneratedError({
			message: "Response truncated",
			finishReason: "length",
		});
		mocks.generateObject.mockRejectedValue(lengthError);

		await expect(
			evaluateAiReadiness({
				input: { projectId: "proj-1", storyId: "story-1" },
				context: { user: { id: "user-1" }, session: {} },
			}),
		).rejects.toThrow(
			"The model ran out of output budget before returning a score. Please try again.",
		);
	});

	it("truncates extremely large bug descriptions (>30000 chars) to protect LLM context windows", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		const massiveDescription = "A".repeat(35_000);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "bug-387",
			kind: "BUG",
			title: "QA Strategy Document Type Missing",
			description: massiveDescription,
			acceptanceCriteria: "Fix AC present",
			createdAt: new Date(),
			lastEditedAt: null,
			decisionLogEntries: [],
		});
		mocks.getAIModelWithMetadata.mockResolvedValue(MODEL_WITH_METADATA);
		mocks.generateObject.mockResolvedValue({
			object: {
				aiReadinessScore: 90,
				tierLabel: "Nearly Ready",
				rationale: "Detailed bug overview provided.",
				strengths: ["Detailed bug report"],
				gaps: [],
			},
		});

		const result = await evaluateAiReadiness({
			input: { projectId: "proj-1", storyId: "bug-387" },
			context: { user: { id: "user-1" }, session: {} },
		});

		expect(result.aiReadiness.aiReadinessScore).toBe(90);
		expect(mocks.generateObject).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: expect.stringContaining(
					"...[description truncated for evaluation]",
				),
			}),
		);
	});

	it("truncates extremely large acceptance criteria (>30000 chars) to protect LLM context windows", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		const massiveAC = "B".repeat(35_000);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-387",
			kind: "FEATURE",
			title: "Large AC Feature",
			description: "Normal description",
			acceptanceCriteria: massiveAC,
			createdAt: new Date(),
			lastEditedAt: null,
			decisionLogEntries: [],
		});
		mocks.getAIModelWithMetadata.mockResolvedValue(MODEL_WITH_METADATA);
		mocks.generateObject.mockResolvedValue({
			object: {
				aiReadinessScore: 85,
				tierLabel: "Nearly Ready",
				rationale: "Detailed acceptance criteria provided.",
				strengths: ["Detailed criteria"],
				gaps: [],
			},
		});

		const result = await evaluateAiReadiness({
			input: { projectId: "proj-1", storyId: "story-387" },
			context: { user: { id: "user-1" }, session: {} },
		});

		expect(result.aiReadiness.aiReadinessScore).toBe(85);
		expect(mocks.generateObject).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: expect.stringContaining(
					"...[acceptance criteria truncated for evaluation]",
				),
			}),
		);
	});

	it("applies the bug rubric without requiring feature-only sections", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "bug-rubric",
			kind: "BUG",
			title: "Save action fails",
			description: "Steps and observed behavior",
			acceptanceCriteria: "The save succeeds after the fix",
			createdAt: new Date(),
			lastEditedAt: null,
			decisionLogEntries: [],
		});
		mocks.getAIModelWithMetadata.mockResolvedValue(MODEL_WITH_METADATA);
		mocks.generateObject.mockResolvedValue({
			object: {
				aiReadinessScore: 80,
				rationale: "Actionable bug report.",
				strengths: [],
				gaps: [],
			},
		});

		await evaluateAiReadiness({
			input: { projectId: "proj-1", storyId: "bug-rubric" },
			context: { user: { id: "user-1" }, session: {} },
		});

		expect(mocks.generateObject).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: expect.stringMatching(
					/BUG READINESS RUBRIC:[\s\S]*Steps to Reproduce[\s\S]*Expected Result[\s\S]*Actual Result[\s\S]*does NOT require[\s\S]*feature Acceptance Criteria/,
				),
			}),
		);
	});

	it("applies the feature rubric without requiring bug-only sections", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "feature-rubric",
			kind: "FEATURE",
			title: "Export reports",
			description: "Users can export reports",
			acceptanceCriteria:
				"GIVEN a report WHEN exported THEN a file downloads",
			createdAt: new Date(),
			lastEditedAt: null,
			decisionLogEntries: [],
		});
		mocks.getAIModelWithMetadata.mockResolvedValue(MODEL_WITH_METADATA);
		mocks.generateObject.mockResolvedValue({
			object: {
				aiReadinessScore: 90,
				rationale: "Testable feature specification.",
				strengths: [],
				gaps: [],
			},
		});

		await evaluateAiReadiness({
			input: { projectId: "proj-1", storyId: "feature-rubric" },
			context: { user: { id: "user-1" }, session: {} },
		});

		expect(mocks.generateObject).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: expect.stringMatching(
					/FEATURE \/ USER STORY READINESS RUBRIC:[\s\S]*functional requirements[\s\S]*acceptance criteria[\s\S]*Do not require bug-only sections/,
				),
			}),
		);
	});

	it("explicitly excludes dev investigation items and engineering deferrals from gaps", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "dev-items",
			kind: "FEATURE",
			title: "Implementation investigation",
			description: "Dev Investigation Items: locate the existing service",
			acceptanceCriteria: "Behavior is testable",
			createdAt: new Date(),
			lastEditedAt: null,
			decisionLogEntries: [],
		});
		mocks.getAIModelWithMetadata.mockResolvedValue(MODEL_WITH_METADATA);
		mocks.generateObject.mockResolvedValue({
			object: {
				aiReadinessScore: 90,
				rationale: "Product behavior is clear.",
				strengths: [],
				gaps: [],
			},
		});

		await evaluateAiReadiness({
			input: { projectId: "proj-1", storyId: "dev-items" },
			context: { user: { id: "user-1" }, session: {} },
		});

		expect(mocks.generateObject).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: expect.stringMatching(
					/DEV INVESTIGATION ITEMS ARE NOT PRODUCT GAPS:[\s\S]*Do not deduct points[\s\S]*EXPLICIT DEFERRALS ARE NOT GAPS/,
				),
			}),
		);
	});

	it("separates engineering decision-log questions from product questions before prompting", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "mixed-questions",
			kind: "FEATURE",
			title: "Export reports",
			description: "Users can export reports",
			acceptanceCriteria: "Exports preserve report data",
			createdAt: new Date(),
			lastEditedAt: null,
			decisionLogEntries: [
				{
					status: "OPEN",
					questionId: "product-question",
					impactedSection: "Scope",
					topic: "Which report formats are supported?",
					summary: null,
				},
				{
					status: "OPEN",
					questionId: "engineering-question",
					impactedSection: "Dev Investigation Items",
					topic: "Which export service should be reused?",
					summary: null,
				},
			],
		});
		mocks.getAIModelWithMetadata.mockResolvedValue(MODEL_WITH_METADATA);
		mocks.generateObject.mockResolvedValue({
			object: {
				aiReadinessScore: 75,
				rationale: "One product decision remains open.",
				strengths: [],
				gaps: ["Supported report formats are undefined"],
			},
		});

		await evaluateAiReadiness({
			input: { projectId: "proj-1", storyId: "mixed-questions" },
			context: { user: { id: "user-1" }, session: {} },
		});

		const prompt = mocks.generateObject.mock.calls[0]?.[0]
			?.prompt as string;
		expect(prompt).toContain(
			"Unresolved Product Question Threads (1): Which report formats are supported?",
		);
		expect(prompt).toContain(
			"NON-SCOREABLE ENGINEERING CONTEXT — REFERENCE ONLY",
		);
		expect(prompt).toContain(
			"Engineering Investigation Threads (1): Which export service should be reused?",
		);
		expect(prompt).toContain(
			"Its contents must never lower the readiness score, appear in gaps",
		);
		expect(prompt).toContain(
			"Engineering Investigation Threads must not reduce the score",
		);
	});

	it("removes explicitly headed engineering sections from scoreable description", () => {
		const markdown =
			"# Feature\nProduct narrative\n\n## Dev Investigation Items\n- Locate the service\n### Notes\n- Check the adapter\n\n## Acceptance Criteria\n- Export succeeds";

		expect(stripEngineeringReadinessSections(markdown)).toBe(
			"# Feature\nProduct narrative\n\n## Acceptance Criteria\n- Export succeeds",
		);
	});

	it("retains explicitly headed engineering sections as reference context", () => {
		const markdown =
			"# Feature\nProduct narrative\n\n## Dev Investigation Items\n- Locate the service\n### Notes\n- Check the adapter\n\n## Acceptance Criteria\n- Export succeeds";

		expect(partitionReadinessSections(markdown)).toEqual({
			product:
				"# Feature\nProduct narrative\n\n## Acceptance Criteria\n- Export succeeds",
			engineering:
				"## Dev Investigation Items\n- Locate the service\n### Notes\n- Check the adapter",
		});
	});

	it("recognizes bold Dev Investigation section labels", () => {
		const markdown = `# Feature
Product narrative

## **Dev Investigation Items**
- Locate the service

## Acceptance Criteria
- Export succeeds

**Dev Notes**
- Confirm the adapter

**Release Notes**
Export is now available.`;

		expect(partitionReadinessSections(markdown)).toEqual({
			product: `# Feature
Product narrative

## Acceptance Criteria
- Export succeeds

**Release Notes**
Export is now available.`,
			engineering: `## **Dev Investigation Items**
- Locate the service

**Dev Notes**
- Confirm the adapter`,
		});
	});

	it("recovers product sections nested beneath an engineering heading", () => {
		const markdown = `## Dev Investigation Items
- Locate the service

### Acceptance Criteria
- Export succeeds`;

		expect(partitionReadinessSections(markdown)).toEqual({
			product: "### Acceptance Criteria\n- Export succeeds",
			engineering: "## Dev Investigation Items\n- Locate the service",
		});
	});

	it("recovers canonical parenthetical product headings beneath engineering context", () => {
		const markdown = `## Dev Notes
- Locate the service

### Acceptance Criteria (Fix Verification)
- Saving succeeds

### Non-Functional Requirements (only if relevant)
- Complete within two seconds`;

		expect(partitionReadinessSections(markdown)).toEqual({
			product: `### Acceptance Criteria (Fix Verification)
- Saving succeeds

### Non-Functional Requirements (only if relevant)
- Complete within two seconds`,
			engineering: "## Dev Notes\n- Locate the service",
		});
	});

	it("recovers canonical Bug and Feature sections with malformed nesting", () => {
		for (const heading of [
			"Business Rules",
			"User Flows",
			"Open Questions",
			"Assumptions",
			"Dependencies",
			"Impact Assessment",
			"Steps to Reproduce",
			"Expected Result",
			"Actual Result",
			"Environment",
			"Bug Metadata",
			"Triage Assessment",
		]) {
			const markdown = `## Dev Notes\n- Investigate code\n\n### ${heading}\n- Product content`;
			const result = partitionReadinessSections(markdown);

			expect(result.product, heading).toContain(`### ${heading}`);
			expect(result.engineering, heading).not.toContain(`### ${heading}`);
		}
	});

	it("keeps generic Implementation Notes and Details in scoreable product content", () => {
		const markdown = `## Implementation Notes
- Preserve the user-visible retry path.

## Implementation Details
- Admins must receive an error when saving fails.`;

		expect(partitionReadinessSections(markdown)).toEqual({
			product: markdown,
			engineering: "",
		});
	});

	it("does not tell the model to ignore generic Implementation Notes headings", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "implementation-notes",
			kind: "FEATURE",
			title: "Retry failed saves",
			description:
				"## Implementation Notes\nThe user must see a retry control after a failed save.",
			acceptanceCriteria: "The retry control repeats the save operation",
			createdAt: new Date(),
			lastEditedAt: null,
			decisionLogEntries: [],
		});
		mocks.getAIModelWithMetadata.mockResolvedValue(MODEL_WITH_METADATA);
		mocks.generateObject.mockResolvedValue({
			object: {
				aiReadinessScore: 90,
				rationale: "Retry behavior is testable.",
				strengths: [],
				gaps: [],
			},
		});

		await evaluateAiReadiness({
			input: { projectId: "proj-1", storyId: "implementation-notes" },
			context: { user: { id: "user-1" }, session: {} },
		});

		const prompt = mocks.generateObject.mock.calls[0]?.[0]
			?.prompt as string;
		expect(prompt).toContain(
			'A generic "Implementation Notes" or "Implementation Details" heading is not automatically engineering-only',
		);
		expect(prompt).toContain(
			"## Implementation Notes\nThe user must see a retry control",
		);
	});

	it("does not remove product sections that mention implementation in their content", () => {
		const markdown =
			"## Functional Requirements\n- Show implementation progress to the user\n\n## Acceptance Criteria\n- Progress is visible";

		expect(stripEngineeringReadinessSections(markdown)).toBe(markdown);
	});

	it("treats explicit scope boundaries and existing prerequisites as non-gaps", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "existing-and-out-of-scope",
			kind: "FEATURE",
			title: "Require role selection at login",
			description:
				"Role editing already exists in personal settings.\n\n## Out of Scope\n- Redesigning the role taxonomy.",
			acceptanceCriteria:
				"GIVEN no role WHEN login THEN require selection",
			createdAt: new Date(),
			lastEditedAt: null,
			decisionLogEntries: [],
		});
		mocks.getAIModelWithMetadata.mockResolvedValue(MODEL_WITH_METADATA);
		mocks.generateObject.mockResolvedValue({
			object: {
				aiReadinessScore: 95,
				rationale: "Feature behavior is clear and testable.",
				strengths: [],
				gaps: [],
			},
		});

		await evaluateAiReadiness({
			input: {
				projectId: "proj-1",
				storyId: "existing-and-out-of-scope",
			},
			context: { user: { id: "user-1" }, session: {} },
		});

		const prompt = mocks.generateObject.mock.calls[0]?.[0]
			?.prompt as string;
		expect(prompt).toContain("OUT-OF-SCOPE MEANS DO NOT SCORE");
		expect(prompt).toContain("EXISTING CAPABILITIES ARE SATISFIED CONTEXT");
		expect(prompt).toContain("READ THE WHOLE SPEC BEFORE CLAIMING A GAP");
		expect(prompt).toContain(
			"For each candidate PRODUCT gap, search the entire supplied spec",
		);
	});

	it("detects direct product contradictions without confusing intentional variants", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "contradictory-feature",
			kind: "FEATURE",
			title: "Assign project roles",
			description:
				"## Requirements\nUsers may select multiple roles.\n\n## Acceptance Criteria\nA user must select exactly one role.",
			acceptanceCriteria: "Role selection is saved",
			createdAt: new Date(),
			lastEditedAt: null,
			decisionLogEntries: [],
		});
		mocks.getAIModelWithMetadata.mockResolvedValue(MODEL_WITH_METADATA);
		mocks.generateObject.mockResolvedValue({
			object: {
				aiReadinessScore: 70,
				rationale: "Role cardinality requirements conflict.",
				strengths: [],
				gaps: [
					"Requirements allow multiple roles, while Acceptance Criteria require exactly one.",
				],
			},
		});

		await evaluateAiReadiness({
			input: { projectId: "proj-1", storyId: "contradictory-feature" },
			context: { user: { id: "user-1" }, session: {} },
		});

		const prompt = mocks.generateObject.mock.calls[0]?.[0]
			?.prompt as string;
		expect(prompt).toContain("DETECT PRODUCT CONTRADICTIONS");
		expect(prompt).toContain("DO NOT INVENT CONTRADICTIONS");
		expect(prompt).toContain(
			"two or more explicit, simultaneously applicable product requirements",
		);
		expect(prompt).toContain(
			"Current behavior versus explicitly desired future behavior is a change, not a contradiction",
		);
		expect(prompt).toContain(
			"Treat a confirmed contradiction as a PRODUCT gap",
		);
	});

	it("does not treat accepted fallback alternatives or invented UX enhancements as gaps", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "accepted-alternatives",
			kind: "FEATURE",
			title: "Apply type-specific AI Readiness rubrics",
			description: `## Key Decisions
For an unsupported type, either skip AI Readiness or show a message that type-specific readiness is not supported. Both outcomes are acceptable.

## Type Changes
If a work item's type changes, re-running AI Readiness applies the rubric for its current type.`,
			acceptanceCriteria: `1. GIVEN an unsupported type WHEN AI Readiness runs THEN scoring is skipped or an unsupported-type message is returned.
2. GIVEN a changed work-item type WHEN AI Readiness is re-run THEN the current type's rubric is applied.`,
			createdAt: new Date(),
			lastEditedAt: null,
			decisionLogEntries: [],
		});
		mocks.getAIModelWithMetadata.mockResolvedValue(MODEL_WITH_METADATA);
		mocks.generateObject.mockResolvedValue({
			object: {
				aiReadinessScore: 95,
				rationale:
					"Fallback and type-change outcomes are explicitly testable.",
				strengths: [],
				gaps: [],
			},
		});

		await evaluateAiReadiness({
			input: { projectId: "proj-1", storyId: "accepted-alternatives" },
			context: { user: { id: "user-1" }, session: {} },
		});

		const prompt = mocks.generateObject.mock.calls[0]?.[0]
			?.prompt as string;
		expect(prompt).toContain(
			"EXPLICITLY ACCEPTED ALTERNATIVES ARE RESOLVED",
		);
		expect(prompt).toContain(
			"either skip scoring or show an unsupported-type message",
		);
		expect(prompt).toContain("DO NOT INVENT REQUIREMENTS");
		expect(prompt).toContain(
			"Do not request additional UI indicators, messages, workflows, controls, or acceptance criteria",
		);
		expect(prompt).toContain(
			"A potential enhancement is not a readiness gap",
		);
	});

	it("does not classify ordinary product questions as engineering work", () => {
		expect(
			isEngineeringReadinessQuestion({
				impactedSection: "Functional Requirements",
				topic: "Should users see implementation progress?",
				summary: null,
			}),
		).toBe(false);
		expect(
			isEngineeringReadinessQuestion({
				impactedSection: null,
				topic: "Dev Investigation: locate the existing export service",
				summary: null,
			}),
		).toBe(true);
	});

	it("retries once when generateObject throws transient NoObjectGeneratedError schema parse error", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-retry",
			projectId: "proj-1",
			title: "Retry Story",
			description: "Desc",
			acceptanceCriteria: "AC",
			createdAt: new Date(),
			lastEditedAt: null,
			decisionLogEntries: [],
		});
		mocks.getAIModelWithMetadata.mockResolvedValue(MODEL_WITH_METADATA);

		const parseError = new NoObjectGeneratedError({
			message: "Failed to parse JSON schema",
			finishReason: "stop",
		});
		mocks.generateObject
			.mockRejectedValueOnce(parseError)
			.mockResolvedValueOnce({
				object: {
					aiReadinessScore: 80,
					rationale: "Good after retry.",
					strengths: ["Recovered"],
					gaps: [],
				},
			});

		const result = await evaluateAiReadiness({
			input: { projectId: "proj-1", storyId: "story-retry" },
			context: { user: { id: "user-1" }, session: {} },
		});

		expect(result.aiReadiness.aiReadinessScore).toBe(80);
		expect(result.aiReadiness.tierLabel).toBe("Nearly Ready");
		expect(mocks.generateObject).toHaveBeenCalledTimes(2);
	});
});
