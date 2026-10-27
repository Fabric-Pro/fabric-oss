/** Memory queries on a real NOSUPERUSER/NOBYPASSRLS connection. */
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../prisma/generated/client";
import {
	createEpisodicMemory,
	deleteEpisodeByConversationId,
	deleteEpisodicMemory,
	getEpisodesPage,
	getOrchestratorMemoryPreferences,
	getRecentEpisodes,
	learnPattern,
	removeLearnedPattern,
	searchEpisodicMemories,
	updateEpisodeQdrantReference,
	updateOrchestratorMemoryPreferences,
} from "../prisma/queries/orchestrator-memory";
import {
	consolidateLearnedPatterns,
	getUserMemoryEffectiveness,
} from "../prisma/queries/orchestrator-memory-evaluation";
import { disposableTarget } from "../scripts/prisma-disposable.mjs";
import {
	createOrganizationContext,
	createPersonalContext,
	runWithTenantContext,
} from "../src/tenant-context";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

// Inject only the connection. Query logic, extension, transactions and RLS are real.
const connection = vi.hoisted(() => ({
	client: null as unknown as PrismaClient,
}));
vi.mock("../prisma/client", () => ({
	db: new Proxy(
		{},
		{
			get: (_target, prop) => {
				const value = Reflect.get(connection.client, prop);
				return typeof value === "function"
					? value.bind(connection.client)
					: value;
			},
		},
	),
}));
vi.mock("../src/tenant-db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/tenant-db")>();
	return {
		...actual,
		getTenantDb: () => actual.createTenantDbClient(connection.client),
	};
});

const suffix = randomUUID().replaceAll("-", "");
const role = `example_memory_${suffix}`;
const userId = `example-user-${suffix}`;
const otherUserId = `example-other-user-${suffix}`;
const orgIds = [`example-org-a-${suffix}`, `example-org-b-${suffix}`];
const enabled =
	process.env.RUN_DB_INTEGRATION === "1" && hasReachableDatabaseUrl();

describe.skipIf(!enabled)("Advisor memory query paths under RLS", () => {
	let root: PrismaClient;
	let roleCreated = false;
	const inOrg = <T>(org: string, fn: () => Promise<T>) =>
		runWithTenantContext(createOrganizationContext(org, userId), fn);
	const episodeInput = (key: string, organizationId: string | null) => ({
		userId,
		organizationId,
		conversationId: `example-conversation-${key}-${suffix}`,
		executionId: `example-execution-${key}-${suffix}`,
		title: "Example conversation",
		summary: "Example summary",
		keyTopics: ["example"],
		userIntents: [],
		outcome: "completed",
		messageCount: 2,
		turnCount: 1,
		toolsUsed: [],
		agentsUsed: [],
		conversationStartedAt: new Date(),
	});

	beforeAll(async () => {
		const target = disposableTarget("reset", {
			DIRECT_URL: process.env.DATABASE_URL,
		});
		root = new PrismaClient({
			adapter: new PrismaPg({
				connectionString: target,
			}),
		});
		await root.$executeRawUnsafe(
			`CREATE ROLE ${role} LOGIN PASSWORD '${suffix}' NOSUPERUSER NOBYPASSRLS`,
		);
		roleCreated = true;
		await root.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
		await root.$executeRawUnsafe(
			`GRANT SELECT,INSERT,UPDATE,DELETE ON episodic_memory,orchestrator_memory_preferences TO ${role}`,
		);
		const url = new URL(process.env.DATABASE_URL ?? "");
		url.username = role;
		url.password = suffix;
		connection.client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: url.toString() }),
		});
		expect(
			await connection.client
				.$queryRaw`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
		).toEqual([{ rolsuper: false, rolbypassrls: false }]);
		for (const id of [userId, otherUserId]) {
			await root.user.create({
				data: {
					id,
					name: "Example user",
					email: `${id}@example.com`,
					emailVerified: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
		}
		for (const id of orgIds) {
			await root.organization.create({
				data: {
					id,
					name: "Example organization",
					createdAt: new Date(),
				},
			});
		}
	});

	afterAll(async () => {
		await connection.client?.$disconnect();
		if (root) {
			try {
				await root.user.deleteMany({
					where: { id: { in: [userId, otherUserId] } },
				});
				await root.organization.deleteMany({
					where: { id: { in: orgIds } },
				});
				if (roleCreated) {
					await root.$executeRawUnsafe(`DROP OWNED BY ${role}`);
					await root.$executeRawUnsafe(`DROP ROLE ${role}`);
				}
			} finally {
				await root.$disconnect();
			}
		}
	});

	it("settings preferences and learned-pattern writes work in organization context", async () => {
		await inOrg(orgIds[0], async () => {
			await updateOrchestratorMemoryPreferences(userId, orgIds[0], {
				responseStyle: "concise",
			});
			await learnPattern(userId, orgIds[0], "Use examples");
			expect(
				await getOrchestratorMemoryPreferences(userId, orgIds[0]),
			).toMatchObject({
				responseStyle: "concise",
				preferences: { learnedPatterns: ["Use examples"] },
			});
			await updateOrchestratorMemoryPreferences(userId, orgIds[0], {
				preferences: {
					learnedPatterns: ["Use examples", "Use examples"],
				},
			});
			expect(await consolidateLearnedPatterns(userId, orgIds[0])).toEqual(
				{
					originalCount: 2,
					consolidatedCount: 1,
				},
			);
			expect(
				await getUserMemoryEffectiveness(userId, orgIds[0]),
			).toMatchObject({
				metrics: {
					preferencesSet: true,
					learnedPatternsCount: 1,
					episodeCount: 0,
				},
			});
			await removeLearnedPattern(userId, orgIds[0], "Use examples");
			expect(
				(await getOrchestratorMemoryPreferences(userId, orgIds[0]))
					.preferences.learnedPatterns,
			).toEqual([]);
		});
	});

	it("records a turn, hydrates the panel, updates its vector reference and deletes it", async () => {
		await inOrg(orgIds[0], async () => {
			const episode = await createEpisodicMemory(
				episodeInput("panel", orgIds[0]),
			);
			await updateEpisodeQdrantReference(
				episode.id,
				"example-point",
				"example-collection",
			);
			expect(
				(await getRecentEpisodes(userId, orgIds[0])).map(
					(row) => row.id,
				),
			).toEqual([episode.id]);
			expect(
				(
					await searchEpisodicMemories({
						userId,
						organizationId: orgIds[0],
						keyTopics: ["example"],
					})
				).map((row) => row.id),
			).toEqual([episode.id]);
			expect(
				await deleteEpisodicMemory(episode.id, userId, orgIds[0]),
			).toBe(true);
			expect(await getRecentEpisodes(userId, orgIds[0])).toEqual([]);
		});
	});

	it("supports the organization-less preference and episode arms", async () => {
		await runWithTenantContext(createPersonalContext(userId), async () => {
			await updateOrchestratorMemoryPreferences(userId, null, {
				responseStyle: "detailed",
			});
			expect(
				(await getOrchestratorMemoryPreferences(userId, null))
					.responseStyle,
			).toBe("detailed");
			const episode = await createEpisodicMemory(
				episodeInput("personal", null),
			);
			expect(
				(await getRecentEpisodes(userId, null)).map((row) => row.id),
			).toEqual([episode.id]);
			expect(await deleteEpisodicMemory(episode.id, userId, null)).toBe(
				true,
			);
		});
	});

	it("conversation deletion and inserts retain the requesting organization", async () => {
		const input = episodeInput("deletion", orgIds[1]);
		const episode = await inOrg(orgIds[1], () =>
			createEpisodicMemory(input),
		);
		await inOrg(orgIds[0], () =>
			deleteEpisodeByConversationId(input.conversationId),
		);
		expect(
			await root.episodicMemory.findUnique({ where: { id: episode.id } }),
		).not.toBeNull();
		await expect(
			inOrg(orgIds[0], () =>
				createEpisodicMemory(episodeInput("forbidden", orgIds[1])),
			),
		).rejects.toThrow(/row-level security/);
		await inOrg(orgIds[1], () =>
			deleteEpisodeByConversationId(input.conversationId),
		);
		expect(
			await root.episodicMemory.findUnique({ where: { id: episode.id } }),
		).toBeNull();
	});

	it("pages settings history and counts only the requesting user's organization rows", async () => {
		const ownIds: string[] = [];
		for (const [key, owner, org, endedAt] of [
			["page-first", userId, orgIds[0], "2026-10-03"],
			["page-second", userId, orgIds[0], "2026-10-02"],
			["page-third", userId, orgIds[0], "2026-10-01"],
			["page-colleague", otherUserId, orgIds[0], "2026-10-05"],
			["page-other-org", userId, orgIds[1], "2026-10-04"],
		]) {
			const { executionId: _executionId, ...data } = episodeInput(
				key,
				org,
			);
			const row = await root.episodicMemory.create({
				data: {
					...data,
					userId: owner,
					conversationEndedAt: new Date(endedAt),
				},
			});
			if (owner === userId && org === orgIds[0]) {
				ownIds.push(row.id);
			}
		}
		await inOrg(orgIds[0], async () => {
			const first = await getEpisodesPage(userId, orgIds[0], 2, 0);
			expect(first.episodes.map((row) => row.id)).toEqual(
				ownIds.slice(0, 2),
			);
			expect(first.total).toBe(3);
			const second = await getEpisodesPage(userId, orgIds[0], 2, 2);
			expect(second.episodes.map((row) => row.id)).toEqual(
				ownIds.slice(2),
			);
			expect(second.total).toBe(3);
		});
	});
});
