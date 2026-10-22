import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../prisma/generated/client";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const state = vi.hoisted(() => ({
	clients: [] as PrismaClient[],
	next: 0,
	beforeLock: async (_index: number) => {},
	afterLock: async (_index: number) => {},
}));
// The handlers import `@repo/database`, which resolves to this package's
// index.ts; inside this package the bare specifier does not, so mock the file.
vi.mock("../../ai/lib/dynamic-model-selector", () => ({
	selectModelDynamic: vi.fn(async () => ({
		modelId: "example-embedding",
		canonicalName: "example-embedding",
		displayName: "Example embedding",
	})),
}));
vi.mock("../index", async () => ({
	organizationDefaultProviderWhere: (
		await import("../prisma/queries/ai-gateway")
	).organizationDefaultProviderWhere,
	readProviderRowCredentials: (await import("../prisma/queries/ai-gateway"))
		.readProviderRowCredentials,
	getOrganizationDefaultProvider: async (organizationId: string) =>
		(
			await state.clients[0].cloudProviderConfig.findFirst({
				where: { organizationId, isDefault: true, enabled: true },
			})
		)?.provider ?? null,
	getSystemAiProviderApiKey: async ({
		organizationId,
	}: {
		organizationId: string;
	}) => {
		const { organizationDefaultProviderWhere, readProviderRowCredentials } =
			await import("../prisma/queries/ai-gateway");
		const row = await state.clients[0].cloudProviderConfig.findFirst({
			where: organizationDefaultProviderWhere(organizationId),
		});
		return row && readProviderRowCredentials(row).hasCredentials
			? {
					provider: row.provider,
					source: "organization",
					configId: row.id,
				}
			: { provider: null, source: null, configId: null };
	},
	getAiProviderApiKeyByProvider: async ({
		organizationId,
		provider,
	}: {
		organizationId: string;
		provider: string;
	}) => {
		const row = await state.clients[0].cloudProviderConfig.findFirst({
			where: {
				organizationId,
				provider: provider as never,
				enabled: true,
			},
		});
		return row
			? { provider: row.provider, source: "organization" }
			: { provider: null, source: "none" };
	},
	lockTenantProviderConnections: (
		await import("../prisma/queries/provider-write-locks")
	).lockTenantProviderConnections,
	taskDefaultsSnapshotMutation: (
		await import("../prisma/queries/task-default-snapshots")
	).taskDefaultsSnapshotMutation,
	db: {
		cloudProviderConfig: {
			findFirst: async (
				args: Parameters<
					PrismaClient["cloudProviderConfig"]["findFirst"]
				>[0],
			) => state.clients[0].cloudProviderConfig.findFirst(args),
			findMany: async ({
				where,
			}: {
				where: { organizationId: string };
			}) => state.clients[0].cloudProviderConfig.findMany({ where }),
		},
		$transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
			const index = state.next++;
			return state.clients[index].$transaction(
				async (tx) =>
					callback(
						new Proxy(tx, {
							get(target, key) {
								if (key === "$queryRaw") {
									return async (
										sql: TemplateStringsArray,
										...values: unknown[]
									) => {
										await state.beforeLock(index);
										const result = await target.$queryRaw(
											sql,
											...values,
										);
										await state.afterLock(index);
										return result;
									};
								}

								return Reflect.get(target, key);
							},
						}),
					),
				{ timeout: 15_000, maxWait: 5_000 },
			);
		},
	},
	getEmbeddingProviderConfig: async () => ({ provider: null }),
	getProviderMetadata: () => ({}),
	getProviderDisplayName: (provider: string) => provider,
	LLM_PROVIDER_PURPOSE_FILTER: { purpose: { not: "EMBEDDINGS_ONLY" } },
	ALL_EMBEDDING_CAPABLE_PROVIDERS: [],
	canProviderSupportEmbeddings: () => true,
}));
vi.mock("@repo/utils", () => ({ encryptApiKey: (value: string) => value }));
vi.mock("../../api/lib/audit", () => ({ recordAuditFromRequest: vi.fn() }));
vi.mock("../../api/modules/organizations/lib/membership", () => ({
	requireOrgMembership: async () => ({ role: "owner" }),
}));
vi.mock("../../api/modules/ai-config/lib/embedding-model-guard", () => ({
	assertEmbeddingPreferenceFitsVectorStore: vi.fn(),
}));
vi.mock("../../api/orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const method of ["use", "route", "input", "output"]) {
		chain[method] = () => chain;
	}
	chain.handler = (handler: unknown) => ({ _handler: handler });
	return {
		tenantProtectedProcedure: chain,
		resolveOrganizationId: (
			_input: unknown,
			session: { activeOrganizationId: string },
		) => session.activeOrganizationId,
		requirePermission: vi.fn(),
		requireInputOrgPermission: vi.fn(),
		Permissions: {},
	};
});

import {
	deleteUserProviderProcedure,
	setDefaultProviderProcedure,
} from "../../api/modules/ai-config/procedures/providers/upsert";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const call = (procedure: unknown, provider: string, organizationId: string) =>
	(procedure as { _handler: (args: unknown) => Promise<unknown> })._handler({
		input: { provider },
		context: {
			user: { id: "example-admin" },
			session: { activeOrganizationId: organizationId },
		},
	});

// Requires a migrated database. Like the other integration tests, fixtures
// live in the real tables under a synthetic organization that is deleted
// (cascading to its connections and preferences) when the test ends. Real
// Prisma transactions execute the production handlers and lock helper.
describe.skipIf(!hasReachableDatabaseUrl())(
	"provider write lock order on Postgres",
	() => {
		it.each(["delete", "setDefault"] as const)(
			"concurrent delete and default switch serialize with %s taking the first lock",
			async (first) => {
				const organizationId = `example-org-lock-${randomUUID()}`;
				const appName = `example_provider_lock_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
				const admin = new Client({
					connectionString: process.env.DATABASE_URL,
				});
				const acquired = deferred();
				const attempted = deferred();
				const release = deferred();
				const running: Promise<unknown>[] = [];
				await admin.connect();
				try {
					await admin.query(
						`INSERT INTO organization (id, name, "createdAt") VALUES ($1, 'Example Org', now())`,
						[organizationId],
					);
					await admin.query(
						`INSERT INTO cloud_provider_config (id, "organizationId", provider, encrypted_api_key, config, "isDefault", "updatedAt") VALUES ($2, $1, 'OPENAI_DIRECT', 'example-encrypted', '{}'::jsonb, true, now()), ($3, $1, 'ANTHROPIC_DIRECT', 'example-encrypted', '{}'::jsonb, false, now())`,
						[
							organizationId,
							`a-${organizationId}`,
							`z-${organizationId}`,
						],
					);
					await admin.query(
						`INSERT INTO organization_model_preference (id, "organizationId", "taskType", provider, "modelId", "updatedAt") VALUES ($2, $1, 'CHAT', 'OPENAI_DIRECT', NULL, now())`,
						[organizationId, `pref-${organizationId}`],
					);
					state.clients = [0, 1].map(
						(index) =>
							new PrismaClient({
								adapter: new PrismaPg({
									connectionString: process.env.DATABASE_URL,
									application_name: `${appName}_${index}`,
								}),
							}),
					);
					state.next = 0;
					state.beforeLock = async (index) => {
						if (index === 1) {
							attempted.resolve();
						}
					};
					state.afterLock = async (index) => {
						if (index === 0) {
							acquired.resolve();
							await release.promise;
						}
					};
					const deleting = () =>
						call(
							deleteUserProviderProcedure,
							"OPENAI_DIRECT",
							organizationId,
						);
					const switching = () =>
						call(
							setDefaultProviderProcedure,
							"ANTHROPIC_DIRECT",
							organizationId,
						);
					const firstRun =
						first === "delete" ? deleting() : switching();
					running.push(firstRun);
					await Promise.race([
						acquired.promise,
						firstRun.then(() => {
							throw new Error(
								"first transaction finished before its lock barrier",
							);
						}),
					]);
					const secondRun =
						first === "delete" ? switching() : deleting();
					running.push(secondRun);
					await Promise.race([
						attempted.promise,
						secondRun.then(() => {
							throw new Error(
								"second transaction finished before attempting its lock",
							);
						}),
					]);
					let secondWaitingOnLock = false;
					const deadline = Date.now() + 5_000;
					while (Date.now() < deadline) {
						const activity = await admin.query(
							"SELECT wait_event_type FROM pg_stat_activity WHERE application_name = $1 AND state = 'active'",
							[`${appName}_1`],
						);
						if (
							activity.rows.some(
								(row) => row.wait_event_type === "Lock",
							)
						) {
							secondWaitingOnLock = true;
							break;
						}
						await new Promise((done) => setTimeout(done, 10));
					}
					expect(secondWaitingOnLock).toBe(true);
					release.resolve();
					// A switch whose pre-read lost the race must conflict; deadlocks and
					// pool timeouts still fail this assertion.
					const results = await Promise.allSettled(running);

					expect(results).toEqual([
						expect.objectContaining({ status: "fulfilled" }),
						first === "delete"
							? expect.objectContaining({
									status: "rejected",
									reason: expect.objectContaining({
										code: "CONFLICT",
									}),
								})
							: expect.objectContaining({ status: "fulfilled" }),
					]);
					expect(
						(
							await admin.query(
								'SELECT provider, "isDefault" FROM cloud_provider_config WHERE "organizationId" = $1',
								[organizationId],
							)
						).rows,
					).toEqual([
						{ provider: "ANTHROPIC_DIRECT", isDefault: true },
					]);
					expect(
						(
							await admin.query(
								'SELECT id FROM organization_model_preference WHERE "organizationId" = $1',
								[organizationId],
							)
						).rows,
					).toEqual([]);
				} finally {
					release.resolve();
					await Promise.allSettled(running);
					await Promise.allSettled(
						state.clients.map((client) => client.$disconnect()),
					);
					state.clients = [];
					await admin.query(
						"DELETE FROM organization WHERE id = $1",
						[organizationId],
					);
					await admin.end();
				}
			},
		);
	},
);
