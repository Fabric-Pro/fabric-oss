/**
 * Tests for suggestSkillsProcedure
 *
 * Covers:
 * - Skill catalog caching (cache hit vs cache miss)
 * - Cache TTL expiration
 * - LLM-based suggestion parsing
 * - LLM fallback on error (returns empty)
 * - Empty catalog returns empty suggestions
 * - Suggestions limited to top 3 by confidence
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockListSkills,
	mockGenerateObject,
	mockGetAIModelWithMetadata,
	mockTrackUsage,
} = vi.hoisted(() => ({
	mockListSkills: vi.fn(),
	mockGenerateObject: vi.fn(),
	mockGetAIModelWithMetadata: vi.fn(),
	mockTrackUsage: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listSkills: (...args: unknown[]) => mockListSkills(...args),
	AI_PROVIDER_METADATA: {},
	GATEWAY_PROVIDERS: [],
	DB_GATEWAY_PROVIDERS: [],
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: (...args: unknown[]) =>
		mockGetAIModelWithMetadata(...args),
}));

vi.mock("ai", () => ({
	generateObject: (...args: unknown[]) => mockGenerateObject(...args),
	zodSchema: (schema: unknown) => schema,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			return { _handler: fn };
		},
	});

	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
		requirePermission: vi.fn(() => ({})),
		requireInputOrgPermission: vi.fn(() => ({})),
		requireProjectPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

const ctx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
};

const orgCtx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: "org-1" },
};

function makeSkill(id: string, name: string, description: string) {
	return {
		id,
		name,
		description,
		slug: name.toLowerCase().replace(/\s+/g, "-"),
	};
}

async function loadHandler() {
	const mod = await import("../suggest-skills");
	// biome-ignore lint/suspicious/noExplicitAny: test hatch — mocked procedure
	return (mod.suggestSkillsProcedure as any)._handler as (args: {
		input: {
			message: string;
			organizationId?: string | null;
			conversationId?: string;
		};
		context: typeof ctx;
	}) => Promise<{
		suggestions: Array<{
			skillId: string;
			name: string;
			reason: string;
			confidence: number;
		}>;
	}>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
});

describe("suggestSkillsProcedure — caching", () => {
	it("fetches skills from DB on cache miss", async () => {
		mockListSkills.mockResolvedValue({
			skills: [makeSkill("s1", "Debug", "Debug code issues")],
			total: 1,
		});
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: "fake-model",
			trackUsage: mockTrackUsage,
		});
		mockGenerateObject.mockResolvedValue({ object: { suggestions: [] } });

		const handler = await loadHandler();
		await handler({
			input: { message: "help me debug", organizationId: null },
			context: ctx,
		});

		expect(mockListSkills).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: null,
				isPublished: true,
				limit: 200,
				sortBy: "useCount",
				sortOrder: "desc",
			}),
		);
	});

	it("uses cached skills on subsequent calls (same tenant)", async () => {
		mockListSkills.mockResolvedValue({
			skills: [makeSkill("s1", "Debug", "Debug code issues")],
			total: 1,
		});
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: "fake-model",
			trackUsage: mockTrackUsage,
		});
		mockGenerateObject.mockResolvedValue({ object: { suggestions: [] } });

		const handler = await loadHandler();

		// First call — cache miss
		await handler({
			input: { message: "help me debug", organizationId: null },
			context: ctx,
		});

		expect(mockListSkills).toHaveBeenCalledTimes(1);

		// Second call — cache hit (same module instance)
		await handler({
			input: { message: "another debug", organizationId: null },
			context: ctx,
		});

		expect(mockListSkills).toHaveBeenCalledTimes(1); // still 1
	});

	it("separates cache by tenant (personal vs org)", async () => {
		mockListSkills.mockResolvedValue({ skills: [], total: 0 });
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: "fake-model",
			trackUsage: mockTrackUsage,
		});
		mockGenerateObject.mockResolvedValue({ object: { suggestions: [] } });

		const handler = await loadHandler();

		// Personal context
		await handler({
			input: { message: "help", organizationId: null },
			context: ctx,
		});

		// Org context
		await handler({
			input: { message: "help", organizationId: "org-1" },
			context: orgCtx,
		});

		expect(mockListSkills).toHaveBeenCalledTimes(2);
	});
});

describe("suggestSkillsProcedure — LLM suggestions", () => {
	it("returns suggestions that match the catalog", async () => {
		mockListSkills.mockResolvedValue({
			skills: [
				makeSkill("s1", "Debug", "Debug code issues"),
				makeSkill("s2", "Refactor", "Refactor code"),
				makeSkill("s3", "Test", "Write tests"),
			],
			total: 3,
		});
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: "fake-model",
			trackUsage: mockTrackUsage,
		});
		mockGenerateObject.mockResolvedValue({
			object: {
				suggestions: [
					{
						skillId: "s1",
						name: "Debug",
						reason: "Helps find bugs",
						confidence: 0.95,
					},
				],
			},
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { message: "my code is broken", organizationId: null },
			context: ctx,
		});

		expect(mockGenerateObject).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "fake-model",
				prompt: expect.stringContaining("my code is broken"),
			}),
		);
		expect(result.suggestions).toHaveLength(1);
		expect(result.suggestions[0].skillId).toBe("s1");
		expect(result.suggestions[0].confidence).toBe(0.95);
	});

	it("limits to top 3 suggestions by confidence", async () => {
		mockListSkills.mockResolvedValue({
			skills: [
				makeSkill("s1", "A", "Desc A"),
				makeSkill("s2", "B", "Desc B"),
				makeSkill("s3", "C", "Desc C"),
				makeSkill("s4", "D", "Desc D"),
			],
			total: 4,
		});
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: "fake-model",
			trackUsage: mockTrackUsage,
		});
		mockGenerateObject.mockResolvedValue({
			object: {
				suggestions: [
					{ skillId: "s1", name: "A", reason: "", confidence: 0.5 },
					{ skillId: "s2", name: "B", reason: "", confidence: 0.9 },
					{ skillId: "s3", name: "C", reason: "", confidence: 0.7 },
					{ skillId: "s4", name: "D", reason: "", confidence: 0.8 },
				],
			},
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { message: "test", organizationId: null },
			context: ctx,
		});

		expect(result.suggestions).toHaveLength(3);
		expect(result.suggestions[0].skillId).toBe("s2"); // 0.9
		expect(result.suggestions[1].skillId).toBe("s4"); // 0.8
		expect(result.suggestions[2].skillId).toBe("s3"); // 0.7
	});

	it("filters out suggestions for skills not in catalog", async () => {
		mockListSkills.mockResolvedValue({
			skills: [makeSkill("s1", "Debug", "Debug code issues")],
			total: 1,
		});
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: "fake-model",
			trackUsage: mockTrackUsage,
		});
		mockGenerateObject.mockResolvedValue({
			object: {
				suggestions: [
					{
						skillId: "s1",
						name: "Debug",
						reason: "",
						confidence: 0.9,
					},
					{
						skillId: "s99",
						name: "Ghost",
						reason: "",
						confidence: 0.9,
					},
				],
			},
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { message: "test", organizationId: null },
			context: ctx,
		});

		expect(result.suggestions).toHaveLength(1);
		expect(result.suggestions[0].skillId).toBe("s1");
	});
});

describe("suggestSkillsProcedure — fallback behavior", () => {
	it("returns empty suggestions when LLM throws", async () => {
		mockListSkills.mockResolvedValue({
			skills: [makeSkill("s1", "Debug", "Debug code issues")],
			total: 1,
		});
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: "fake-model",
			trackUsage: mockTrackUsage,
		});
		mockGenerateObject.mockRejectedValue(new Error("LLM timeout"));

		const handler = await loadHandler();
		const result = await handler({
			input: { message: "help", organizationId: null },
			context: ctx,
		});

		expect(result.suggestions).toEqual([]);
	});

	it("returns empty suggestions when catalog is empty", async () => {
		mockListSkills.mockResolvedValue({ skills: [], total: 0 });

		const handler = await loadHandler();
		const result = await handler({
			input: { message: "help", organizationId: null },
			context: ctx,
		});

		expect(mockGenerateObject).not.toHaveBeenCalled();
		expect(result.suggestions).toEqual([]);
	});
});
