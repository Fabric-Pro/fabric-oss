import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../prisma/generated/client";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const state = vi.hoisted(() => ({ client: null as PrismaClient | null }));
// Forward the production helper's global client to an isolated schema. The
// conditional update and winning-value read execute through real Prisma/Postgres.
vi.mock("../prisma/client", async () => {
	const { Prisma } = await import("../prisma/generated/client");
	return {
		Prisma,
		db: new Proxy(
			{},
			{
				get: (_target, key) => {
					if (!state.client) {
						throw new Error("fixture client is not ready");
					}
					return state.client[key as keyof PrismaClient];
				},
			},
		),
	};
});

import { materializeTaskDefaultsSnapshot } from "../prisma/queries/task-default-snapshots";

describe
	.skipIf(!hasReachableDatabaseUrl())
	.each(["organization", "user"] as const)(
	"snapshot materialization on a real %s connection",
	(source) => {
		it("keeps the first writer's value when a second writer still sees SQL NULL", async () => {
			const schema = `example_pin_${randomUUID().replaceAll("-", "")}`;
			const admin = new Client({
				connectionString: process.env.DATABASE_URL,
			});
			const first = new PrismaClient({
				adapter: new PrismaPg(
					{ connectionString: process.env.DATABASE_URL },
					{ schema },
				),
			});
			const second = new PrismaClient({
				adapter: new PrismaPg(
					{ connectionString: process.env.DATABASE_URL },
					{ schema },
				),
			});
			await admin.connect();
			try {
				await admin.query(`CREATE SCHEMA "${schema}"`);
				await admin.query(`SET search_path TO "${schema}"`);
				await admin.query(`
    CREATE TYPE "AIProvider" AS ENUM ('OPENAI_DIRECT');
    CREATE TYPE "AiTaskType" AS ENUM ('SIMPLE', 'COMPLEX', 'REASONING', 'CHAT', 'TOOL_CALLING', 'EVAL');
    CREATE TYPE "TaskComplexity" AS ENUM ('MEDIUM');
    CREATE TABLE ai_model (
     id TEXT PRIMARY KEY, "canonicalName" TEXT NOT NULL, "displayName" TEXT NOT NULL DEFAULT 'Example',
     description TEXT, family TEXT NOT NULL DEFAULT 'example', vendor TEXT NOT NULL DEFAULT 'Example',
     capabilities TEXT[] NOT NULL DEFAULT '{TEXT}', "contextWindow" INTEGER NOT NULL DEFAULT 10000,
     "maxOutputTokens" INTEGER, "speedTier" TEXT NOT NULL DEFAULT 'BALANCED',
     "qualityTier" TEXT NOT NULL DEFAULT 'STANDARD', "inputCostPer1M" DOUBLE PRECISION,
     "outputCostPer1M" DOUBLE PRECISION, "suitableForTasks" "AiTaskType"[] NOT NULL DEFAULT '{}',
     "isActive" BOOLEAN NOT NULL DEFAULT true, "deprecatedAt" TIMESTAMP, "replacementModelId" TEXT,
     "releaseDate" TIMESTAMP, metadata JSONB, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
     "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE TABLE ai_model_provider_mapping (
     id TEXT PRIMARY KEY, "modelId" TEXT REFERENCES ai_model(id), provider "AIProvider",
     "providerModelId" TEXT, "maxContextWindow" INTEGER, "supportedFeatures" TEXT[] DEFAULT '{}',
     "isAvailable" BOOLEAN DEFAULT true, "availabilityNote" TEXT, "inputCostPer1M" DOUBLE PRECISION,
     "outputCostPer1M" DOUBLE PRECISION, "createdAt" TIMESTAMP DEFAULT now(), "updatedAt" TIMESTAMP DEFAULT now()
    );
    CREATE TABLE ai_task_model_default (id TEXT PRIMARY KEY, provider "AIProvider", "taskType" "AiTaskType", complexity "TaskComplexity", priority INTEGER, "modelId" TEXT REFERENCES ai_model(id), "requiresToolCalling" BOOLEAN DEFAULT false, "minContextWindow" INTEGER, "createdAt" TIMESTAMP DEFAULT now(), "updatedAt" TIMESTAMP DEFAULT now());
    INSERT INTO ai_model (id, "canonicalName") VALUES ('example-model', 'example-first');
    INSERT INTO ai_task_model_default (id, provider, "taskType", complexity, priority, "modelId") VALUES ('example-default', 'OPENAI_DIRECT', 'CHAT', 'MEDIUM', 100, 'example-model');
    CREATE TABLE cloud_provider_config (id TEXT PRIMARY KEY, provider "AIProvider", task_defaults_snapshot JSONB);
    CREATE TABLE user_cloud_provider_config (LIKE cloud_provider_config INCLUDING ALL);
    INSERT INTO cloud_provider_config VALUES ('example-connection', 'OPENAI_DIRECT', NULL);
    INSERT INTO user_cloud_provider_config VALUES ('example-connection', 'OPENAI_DIRECT', NULL);
   `);
				const stale = {
					id: "example-connection",
					provider: "OPENAI_DIRECT" as const,
					taskDefaultsSnapshot: null,
				};
				state.client = first;
				const winner = await materializeTaskDefaultsSnapshot(
					stale,
					source,
				);
				expect(winner?.scoped).toEqual({
					SIMPLE: null,
					COMPLEX: null,
					REASONING: null,
					CHAT: "example-first",
					TOOL_CALLING: null,
					EVAL: null,
				});
				expect(winner?.unscoped).toEqual(winner?.scoped);
				await admin.query(
					"UPDATE ai_model SET \"canonicalName\" = 'example-second'",
				);
				state.client = second;
				expect(
					await materializeTaskDefaultsSnapshot(stale, source),
				).toEqual(winner);
				const table =
					source === "organization"
						? "cloud_provider_config"
						: "user_cloud_provider_config";
				expect(
					(
						await admin.query(
							`SELECT task_defaults_snapshot FROM "${table}"`,
						)
					).rows[0].task_defaults_snapshot,
				).toEqual(winner);
			} finally {
				state.client = null;
				await first.$disconnect();
				await second.$disconnect();
				await admin.query("RESET search_path");
				await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
				await admin.end();
			}
		});
	},
);
