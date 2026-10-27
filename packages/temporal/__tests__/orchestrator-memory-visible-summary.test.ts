import { beforeEach, expect, it, vi } from "vitest";
import { configureEpisodeClient } from "../../database/__tests__/_helpers/episodic-memory-client";
import type { EpisodicMemory } from "../../database/prisma/generated/client";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	upsert: vi.fn(),
	update: vi.fn(),
	insert: vi.fn(),
	lock: vi.fn(),
	findFirstOrThrow: vi.fn(),
	transaction: vi.fn(),
	embed: vi.fn(),
	recordInput: vi.fn(),
	store: vi.fn(),
}));
vi.mock("../../database/prisma/client", () => ({
	db: { episodicMemory: mocks, $transaction: mocks.transaction },
}));
vi.mock("@repo/database", async () => {
	const queries = await import(
		"../../database/prisma/queries/orchestrator-memory"
	);
	return {
		...queries,
		createEpisodicMemory: (
			...args: Parameters<typeof queries.createEpisodicMemory>
		) => {
			mocks.recordInput(...args);
			return queries.createEpisodicMemory(...args);
		},
		updateEpisodeQdrantReference: vi.fn(),
	};
});
vi.mock("@repo/ai", () => ({
	embed: mocks.embed,
	getAIEmbeddingModel: vi.fn(async () => ({})),
}));
vi.mock("@repo/rag/lib/vector-store", () => ({
	storeEpisodeEmbedding: mocks.store,
	deleteEpisodeEmbedding: vi.fn(),
	searchSimilarEpisodes: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createEpisodeFromExecutionActivity } from "../src/activities/orchestrator-memory";

let row: EpisodicMemory | null;
beforeEach(() => {
	vi.resetAllMocks();
	row = null;
	configureEpisodeClient(
		mocks,
		() => row,
		(value) => {
			row = value;
		},
	);
	mocks.embed.mockResolvedValue({ embedding: [0.1] });
	mocks.store.mockResolvedValue({
		success: true,
		pointId: "point-example",
		collectionName: "example-episodes",
	});
});

it("embeds the real stored plain summary without structural execution metadata", async () => {
	const executionId = "execution-private-example";
	const startedAt = new Date("2026-10-01");
	const result = await createEpisodeFromExecutionActivity({
		userId: "user-example",
		organizationId: "example-org",
		conversationId: "conversation-example",
		executionId,
		taskDescription: "Compare the five newest features and pick two",
		steps: [],
		toolsUsed: [],
		agentsUsed: [],
		outcome: "success",
		conversationStartedAt: startedAt,
	});
	expect(result.created).toBe(true);
	const text = mocks.embed.mock.calls[0][0].value;
	expect(text).toContain(row?.summary);
	expect(text).not.toContain(executionId);
	expect(text).not.toContain(String(startedAt.getTime()));
	expect(mocks.store.mock.calls[0][0].episode.summary).toBe(row?.summary);
});

it.each(["title", "body"])(
	"passes a well-formed %s through the activity truncation boundary",
	async (boundary) => {
		const prefix = "Compare the five newest features ";
		const taskDescription =
			boundary === "title"
				? `${prefix + "x".repeat(199 - prefix.length)}😀 trailing`
				: `${"x".repeat(1999 - "Task: ".length)}😀 trailing`;
		const raw =
			boundary === "title"
				? taskDescription.slice(0, 200)
				: `Task: ${taskDescription}`.slice(0, 2000);
		expect(raw).toMatch(/[\uD800-\uDFFF]/u);
		const result = await createEpisodeFromExecutionActivity({
			userId: "user-example",
			organizationId: "example-org",
			conversationId: "conversation-example",
			executionId: "execution-unicode-example",
			taskDescription,
			steps: [],
			toolsUsed: [],
			agentsUsed: [],
			outcome: "success",
			conversationStartedAt: new Date("2026-10-01"),
		});
		expect(result.created).toBe(true);
		const written = mocks.recordInput.mock.calls[0][0];
		expect(written.title).not.toMatch(/[\uD800-\uDFFF]/u);
		expect(written.summary).not.toMatch(/[\uD800-\uDFFF]/u);
		expect(written.title.length).toBeLessThanOrEqual(200);
		expect(written.summary.length).toBeLessThanOrEqual(2000);
		expect(row?.summary).not.toMatch(/[\uD800-\uDFFF]/u);
		function check(value: unknown): void {
			if (typeof value === "string") {
				expect(value).not.toMatch(/[\uD800-\uDFFF]/u);
			} else if (value && typeof value === "object") {
				Object.values(value).forEach(check);
			}
		}
		check(row?.turnSections);
	},
);
