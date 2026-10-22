import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EpisodicMemory } from "../prisma/generated/client";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	upsert: vi.fn(),
	update: vi.fn(),
}));
vi.mock("../prisma/client", () => ({ db: { episodicMemory: mocks } }));
vi.mock("../prisma/queries/projects/projects", () => ({
	hasProjectAccess: vi.fn(),
}));
vi.mock("../prisma/queries/workspaces/workspaces", () => ({
	hasWorkspaceAccess: vi.fn(),
}));

import {
	type CreateEpisodeInput,
	createEpisodicMemory,
} from "../prisma/queries/orchestrator-memory";

const input: CreateEpisodeInput = {
	userId: "user-example-1",
	organizationId: "example-org",
	conversationId: "conversation-example",
	title: "First turn",
	summary: "First summary",
	keyTopics: ["planning"],
	userIntents: ["plan"],
	outcome: "ongoing",
	messageCount: 2,
	turnCount: 1,
	toolsUsed: [],
	agentsUsed: [],
	conversationStartedAt: new Date("2026-10-01"),
};
let row: EpisodicMemory | null;
type OwnerWhere = {
	conversationId: string;
	userId?: string;
	organizationId?: string | null;
};
function matches(where: OwnerWhere) {
	return (
		row &&
		Object.entries(where).every(
			([key, value]) => row?.[key as keyof EpisodicMemory] === value,
		)
	);
}
beforeEach(() => {
	vi.resetAllMocks();
	row = null;
	mocks.create.mockImplementation(async ({ data }) => {
		row = {
			projectId: null,
			workspaceId: null,
			agentId: null,
			conversationEndedAt: null,
			qdrantPointId: null,
			qdrantCollection: null,
			...data,
			id: "episode-example",
			createdAt: new Date("2026-10-01"),
		};
		return { ...row };
	});
	mocks.update.mockImplementation(
		async ({
			where,
			data,
		}: {
			where: OwnerWhere;
			data: Partial<EpisodicMemory>;
		}) => {
			if (!matches(where)) {
				throw Object.assign(new Error("Record not found"), {
					code: "P2025",
				});
			}
			row = { ...(row as EpisodicMemory), ...data };
			return { ...row };
		},
	);
	// Model native ON CONFLICT: a rejected owner filter returns no row.
	mocks.upsert.mockImplementation(async ({ where, create, update }) =>
		!row
			? mocks.create({ data: create })
			: matches(where)
				? mocks.update({ where, data: update })
				: null,
	);
});

describe("conversation episode upsert", () => {
	it("replaces turn fields, retains original timestamps and vector reference, and is idempotent", async () => {
		const first = await createEpisodicMemory({
			...input,
			qdrantPointId: "point-example",
			qdrantCollection: "example-episodes",
		});
		const createdAt = row?.createdAt;
		const next = {
			...input,
			title: "Latest turn",
			summary: "Latest summary",
			keyTopics: ["debugging"],
			userIntents: ["fix"],
			outcome: "success",
			messageCount: 4,
			turnCount: 2,
			toolsUsed: ["example-tool"],
			agentsUsed: ["example-agent"],
			projectId: "example-project",
			workspaceId: "example-workspace",
			agentId: "example-agent",
			conversationStartedAt: new Date("2026-10-02"),
			conversationEndedAt: new Date("2026-10-03"),
		};
		const second = await createEpisodicMemory(next);
		expect(second.id).toBe(first.id);
		expect(row).toMatchObject({
			...next,
			id: first.id,
			conversationStartedAt: input.conversationStartedAt,
		});
		expect(row).toMatchObject({
			createdAt,
			qdrantPointId: "point-example",
			qdrantCollection: "example-episodes",
		});
		const snapshot = structuredClone(row);
		await createEpisodicMemory(next);
		expect(row).toEqual(snapshot);
		await createEpisodicMemory(input);
		expect(row).toMatchObject({
			projectId: null,
			workspaceId: null,
			agentId: null,
			conversationEndedAt: null,
		});
	});
	it.each([
		{ userId: "user-example-2" },
		{ organizationId: "example-other-org" },
		{ organizationId: null },
	])("rejects another owner without changing the row (%j)", async (owner) => {
		await createEpisodicMemory(input);
		const snapshot = structuredClone(row);
		await expect(
			createEpisodicMemory({
				...input,
				...owner,
				title: "Forbidden replacement",
			}),
		).rejects.toThrow("owner mismatch");
		expect(row).toEqual(snapshot);
	});
	it("rejects moving a null organization into an organization", async () => {
		await createEpisodicMemory({ ...input, organizationId: null });
		const snapshot = structuredClone(row);
		await expect(createEpisodicMemory(input)).rejects.toThrow(
			"owner mismatch",
		);
		expect(row).toEqual(snapshot);
	});
});
