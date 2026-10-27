import type { Mock } from "vitest";
import type { EpisodicMemory } from "../../prisma/generated/client";

/** In-memory SQL boundary for unit tests; the integration suite exercises locks. */
export function configureEpisodeClient(
	mocks: Record<string, Mock>,
	read: () => EpisodicMemory | null,
	write: (row: EpisodicMemory) => void,
) {
	const matches = (where: Record<string, unknown>) => {
		const row = read();
		return (
			row &&
			Object.entries(where).every(
				([key, value]) => row[key as keyof EpisodicMemory] === value,
			)
		);
	};
	mocks.create.mockImplementation(async ({ data }) => {
		const row = {
			recordedExecutionIds: [],
			turnSections: {},
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
		write(row);
		return { ...row };
	});
	mocks.update.mockImplementation(async ({ where, data }) => {
		if (!matches(where)) {
			throw Object.assign(new Error("Record not found"), {
				code: "P2025",
			});
		}
		const row = { ...read(), ...data } as EpisodicMemory;
		write(row);
		return { ...row };
	});
	mocks.insert.mockImplementation(async (_sql, ...values) => {
		if (read()) {
			return 0;
		}
		const [
			_id,
			userId,
			organizationId,
			projectId,
			workspaceId,
			conversationId,
			agentId,
			title,
			outcome,
			conversationStartedAt,
			qdrantPointId,
			qdrantCollection,
		] = values;
		await mocks.create({
			data: {
				userId,
				organizationId,
				projectId,
				workspaceId,
				conversationId,
				agentId,
				title,
				outcome,
				conversationStartedAt,
				qdrantPointId,
				qdrantCollection,
				summary: "",
				keyTopics: [],
				userIntents: [],
				toolsUsed: [],
				agentsUsed: [],
				turnCount: 0,
				messageCount: 0,
			},
		});
		return 1;
	});
	mocks.lock.mockImplementation(
		async (_sql, conversationId, userId, organizationId) =>
			matches({ conversationId, userId, organizationId })
				? [{ id: read()?.id }]
				: [],
	);
	mocks.findFirstOrThrow.mockImplementation(async ({ where }) => {
		if (!matches(where)) {
			throw new Error("Record not found");
		}
		return { ...read() };
	});
	let pending = Promise.resolve();
	mocks.transaction.mockImplementation((callback) => {
		const result = pending.then(() =>
			callback({
				episodicMemory: mocks,
				$executeRawUnsafe: async () => 0,
				$executeRaw: mocks.insert,
				$queryRaw: mocks.lock,
			}),
		);
		pending = result.catch(() => {});
		return result;
	});
}
