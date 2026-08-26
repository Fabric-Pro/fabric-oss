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
