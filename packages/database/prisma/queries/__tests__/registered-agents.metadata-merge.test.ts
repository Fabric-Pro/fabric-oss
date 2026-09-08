/**
 * Concurrency-safety for the `registered_agent.metadata` writers
 * (`packages/database/prisma/queries/registered-agents.ts`).
 *
 * `updateAgentCardCache` and `updateAgentEmbedding` used to do an unlocked
 * read-modify-write of the `metadata` JSON column: findUnique, spread the
 * object in JS, overwrite the whole column. The card cache is rewritten on
 * every successful health probe and embeddings are persisted fire-and-forget
 * from agent search, so two writers regularly overlapped and the loser's
 * keys vanished with no error anywhere.
 *
 * This suite has no Postgres, so it pins the SHAPE of the fix instead: every
 * writer must issue exactly one `$executeRaw` that merges with the jsonb `||`
 * operator and must never read the row first via the base client. The mocked
 * `findUnique` / `update` throw, so a regression to the read-then-write path
 * fails loudly rather than passing silently.
 *
 * Run: pnpm --filter @repo/database test prisma/queries/__tests__/registered-agents.metadata-merge.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeRaw, findUnique, update } = vi.hoisted(() => ({
	executeRaw: vi.fn(),
	findUnique: vi.fn(async () => {
		throw new Error(
			"db.registeredAgent.findUnique must not be called — metadata merges must be a single atomic UPDATE",
		);
	}),
	update: vi.fn(async () => {
		throw new Error(
			"db.registeredAgent.update must not be called — metadata merges must be a single atomic UPDATE",
		);
	}),
}));

vi.mock("../../client", async () => {
	// The real tagged-template helper so the assertions below can read the
	// generated SQL text and bound values; importing it opens no connection.
	const { Prisma } = await import("../../generated/client");
	return {
		Prisma,
		db: {
			registeredAgent: { findUnique, update },
			$executeRaw: executeRaw,
		},
	};
});

import {
	mergeRegisteredAgentMetadata,
	touchAgentCardCache,
	updateAgentCardCache,
	updateAgentEmbedding,
} from "../registered-agents";

type SqlCall = { sql: string; values: unknown[] };

function lastStatement(): SqlCall {
	expect(executeRaw).toHaveBeenCalledTimes(1);
	const [statement] = executeRaw.mock.calls[0] as [SqlCall];
	return statement;
}

function boundPatch(statement: SqlCall): Record<string, unknown> {
	const json = statement.values.find(
		(value): value is string =>
			typeof value === "string" && value.startsWith("{"),
	);
	expect(json).toBeDefined();
	return JSON.parse(json as string);
}

describe("registered_agent.metadata writers — single atomic jsonb merge", () => {
	beforeEach(() => {
		executeRaw.mockReset();
		executeRaw.mockResolvedValue(1);
		findUnique.mockClear();
		update.mockClear();
	});

	it("updateAgentCardCache merges agentCard keys with `||` and never reads the row first", async () => {
		const cachedAt = new Date("2026-09-08T10:00:00.000Z");
		await updateAgentCardCache("agent-1", { name: "Probe" }, cachedAt);

		const statement = lastStatement();
		expect(findUnique).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
		// `Prisma.Sql#sql` renders bound parameters as `?`; `#text` is the `$n` form.
		expect(statement.sql).toContain(
			"SET metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb",
		);
		expect(statement.sql).toContain('"updatedAt" = now()');
		expect(statement.sql).toContain('WHERE "agentId" = ?');
		expect(statement.values).toContain("agent-1");
		expect(boundPatch(statement)).toEqual({
			agentCard: { name: "Probe" },
			agentCardCachedAt: "2026-09-08T10:00:00.000Z",
		});
	});

	it("updateAgentEmbedding merges only the embedding keys, omitting embeddingModelId when not given", async () => {
		const generatedAt = new Date("2026-09-08T11:00:00.000Z");
		await updateAgentEmbedding("agent-2", [0.1, 0.2], generatedAt);

		const statement = lastStatement();
		expect(findUnique).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
		expect(statement.sql).toContain("|| ?::jsonb");
		expect(boundPatch(statement)).toEqual({
			descriptionEmbedding: [0.1, 0.2],
			embeddingGeneratedAt: "2026-09-08T11:00:00.000Z",
		});
	});

	it("updateAgentEmbedding includes embeddingModelId when given", async () => {
		await updateAgentEmbedding(
			"agent-2",
			[0.3],
			new Date("2026-09-08T11:00:00.000Z"),
			"openai/text-embedding-3-small",
		);

		expect(boundPatch(lastStatement())).toMatchObject({
			embeddingModelId: "openai/text-embedding-3-small",
		});
	});

	it("updateAgentEmbedding includes embeddingSourceHash only when given", async () => {
		await updateAgentEmbedding(
			"agent-2",
			[0.3],
			new Date("2026-09-08T11:00:00.000Z"),
		);
		expect(boundPatch(lastStatement())).not.toHaveProperty(
			"embeddingSourceHash",
		);

		executeRaw.mockClear();
		await updateAgentEmbedding(
			"agent-2",
			[0.3],
			new Date("2026-09-08T11:00:00.000Z"),
			"openai/text-embedding-3-small",
			"deadbeef",
		);
		expect(boundPatch(lastStatement())).toMatchObject({
			embeddingModelId: "openai/text-embedding-3-small",
			embeddingSourceHash: "deadbeef",
		});
	});

	it("touchAgentCardCache issues exactly one $executeRaw whose patch is only agentCardCachedAt", async () => {
		const cachedAt = new Date("2026-09-08T13:00:00.000Z");
		await touchAgentCardCache("agent-1", cachedAt);

		const statement = lastStatement();
		expect(findUnique).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
		expect(statement.sql).toContain(
			"SET metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb",
		);
		expect(statement.values).toContain("agent-1");
		expect(boundPatch(statement)).toEqual({
			agentCardCachedAt: "2026-09-08T13:00:00.000Z",
		});
	});

	it("mergeRegisteredAgentMetadata can target the row by primary key", async () => {
		await mergeRegisteredAgentMetadata(
			{ id: "row-9" },
			{ lastRefreshedAt: "2026-09-08T12:00:00.000Z" },
		);

		const statement = lastStatement();
		expect(statement.sql).toContain("WHERE id = ?");
		expect(statement.values).toContain("row-9");
		expect(boundPatch(statement)).toEqual({
			lastRefreshedAt: "2026-09-08T12:00:00.000Z",
		});
	});

	it("runs on the caller's transaction client when one is passed", async () => {
		const txExecuteRaw = vi.fn().mockResolvedValue(1);
		await mergeRegisteredAgentMetadata(
			{ id: "row-9" },
			{ lastRefreshedAt: "2026-09-08T12:00:00.000Z" },
			{ $executeRaw: txExecuteRaw } as unknown as Parameters<
				typeof mergeRegisteredAgentMetadata
			>[2],
		);

		expect(txExecuteRaw).toHaveBeenCalledTimes(1);
		expect(executeRaw).not.toHaveBeenCalled();
	});

	it("raises Prisma's P2025 when no row matched, so a vanished agent keeps the not-found shape", async () => {
		executeRaw.mockResolvedValue(0);
		const failure = await updateAgentCardCache(
			"agent-missing",
			{},
			new Date(),
		).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(Error);
		expect(failure).toMatchObject({
			code: "P2025",
			message: expect.stringContaining("agent-missing"),
		});
	});
});
