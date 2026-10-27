/** Real-Postgres proof that the tenant extension's query receives its RLS GUCs. */
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../prisma/generated/client";
import {
	createOrganizationContext,
	runWithTenantContext,
} from "../src/tenant-context";
import { createTenantDbClient } from "../src/tenant-db";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const suffix = randomUUID();
const role = `fabric_rls_tenant_${suffix.replaceAll("-", "")}`;
const password = randomUUID();
const userId = `example-user-${suffix}`;
const orgIds = [`example-org-a-${suffix}`, `example-org-b-${suffix}`];
const chatIds = [`example-chat-a-${suffix}`, `example-chat-b-${suffix}`];
const enabled =
	process.env.RUN_DB_INTEGRATION === "1" && hasReachableDatabaseUrl();

// Connect AS a restricted LOGIN: SET LOCAL ROLE in an outer interactive
// transaction cannot wrap the extension's own transaction.
describe.skipIf(!enabled)("tenant-db transaction-local RLS context", () => {
	let root: PrismaClient;
	let restricted: PrismaClient;
	let tenantDb: ReturnType<typeof createTenantDbClient>;
	let roleCreated = false;
	let appTenantDb: ReturnType<typeof createTenantDbClient>;
	const inTenant = <T>(fn: () => PromiseLike<T>): Promise<T> =>
		runWithTenantContext(
			createOrganizationContext(orgIds[0], userId),
			async () => await fn(),
		);

	beforeAll(async () => {
		root = new PrismaClient({
			adapter: new PrismaPg({
				connectionString: process.env.DATABASE_URL,
			}),
		});
		const rootRoles = await root.$queryRaw<
			{ bypass: boolean }[]
		>`SELECT rolsuper OR rolbypassrls AS bypass
		  FROM pg_roles WHERE rolname = current_user`;
		expect(rootRoles).toEqual([{ bypass: true }]);
		// Identifiers/password are generated locally from UUIDs, never user input.
		await root.$executeRawUnsafe(
			`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`,
		);
		roleCreated = true;
		await root.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
		await root.$executeRawUnsafe(
			`GRANT SELECT, INSERT, UPDATE, DELETE ON ai_chat, chat_document TO ${role}`,
		);
		for (const fn of [
			"current_tenant_type",
			"current_tenant_id",
			"current_user_id",
		]) {
			await root.$executeRawUnsafe(
				`GRANT EXECUTE ON FUNCTION ${fn}() TO ${role}`,
			);
		}
		const url = new URL(process.env.DATABASE_URL ?? "");
		url.username = role;
		url.password = password;
		restricted = new PrismaClient({
			adapter: new PrismaPg({ connectionString: url.toString() }),
		});
		tenantDb = createTenantDbClient(restricted);
		appTenantDb = createTenantDbClient(root);

		const roles = await restricted.$queryRaw<
			{ who: string; rolsuper: boolean; rolbypassrls: boolean }[]
		>`SELECT current_user::text AS who, rolsuper, rolbypassrls
		  FROM pg_roles WHERE rolname = current_user`;
		expect(roles).toEqual([
			{ who: role, rolsuper: false, rolbypassrls: false },
		]);
		// Fail rather than falsely pass if policies were not applied, or if
		// this role owns the table (another way to evade ordinary RLS).
		const tables = await restricted.$queryRaw<
			{ enabled: boolean; owner: boolean; policy: boolean }[]
		>`SELECT c.relrowsecurity AS enabled, c.relowner = r.oid AS owner,
		  EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
		          AND p.polname = 'tenant_isolation') AS policy
		  FROM pg_class c JOIN pg_roles r ON r.rolname = current_user
		  WHERE c.oid = 'public.ai_chat'::regclass`;
		expect(tables).toEqual([{ enabled: true, owner: false, policy: true }]);

		await root.user.create({
			data: {
				id: userId,
				name: "Example user",
				email: `dev-${suffix}@example.com`,
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		for (const [index, id] of orgIds.entries()) {
			await root.organization.create({
				data: {
					id,
					name: "Example organization",
					createdAt: new Date(),
				},
			});
			await root.aiChat.create({
				data: { id: chatIds[index], userId, organizationId: id },
			});
		}
	});

	afterAll(async () => {
		if (root) {
			try {
				await restricted?.$disconnect();
				await root.aiChat.deleteMany({ where: { userId } });
				await root.organization.deleteMany({
					where: { id: { in: orgIds } },
				});
				await root.user.deleteMany({ where: { id: userId } });
			} finally {
				try {
					if (roleCreated) {
						try {
							await root.$executeRawUnsafe(
								`DROP OWNED BY ${role}`,
							);
						} finally {
							await root.$executeRawUnsafe(`DROP ROLE ${role}`);
						}
					}
				} finally {
					await root.$disconnect();
				}
			}
		}
	});

	it.each(["findUnique", "findUniqueOrThrow"] as const)(
		"%s by id returns the tenant's own row under RLS",
		async (operation) => {
			const row = await inTenant(() =>
				tenantDb.aiChat[operation]({ where: { id: chatIds[0] } }),
			);
			expect(row?.id).toBe(chatIds[0]);
		},
	);

	it("update by id succeeds under RLS", async () => {
		const row = await inTenant(() =>
			tenantDb.aiChat.update({
				where: { id: chatIds[0] },
				data: { title: "Example own update" },
			}),
		);
		expect(row.title).toBe("Example own update");
		expect(
			(await root.aiChat.findUniqueOrThrow({ where: { id: chatIds[0] } }))
				.title,
		).toBe("Example own update");
	});

	it("delete by id succeeds under RLS", async () => {
		const id = `example-delete-${suffix}`;
		await root.aiChat.create({
			data: { id, userId, organizationId: orgIds[0] },
		});
		const row = await inTenant(() =>
			tenantDb.aiChat.delete({ where: { id } }),
		);
		expect(row.id).toBe(id);
		expect(await root.aiChat.findUnique({ where: { id } })).toBeNull();
	});

	it.each(["findUnique", "findUniqueOrThrow", "update", "delete"] as const)(
		"%s application filter blocks the other tenant with RLS bypassed",
		async (operation) => {
			const where = { id: chatIds[1] };
			const before = await root.aiChat.findUniqueOrThrow({ where });
			const result = inTenant(() => {
				switch (operation) {
					case "findUnique":
						return appTenantDb.aiChat.findUnique({ where });
					case "findUniqueOrThrow":
						return appTenantDb.aiChat.findUniqueOrThrow({ where });
					case "update":
						return appTenantDb.aiChat.update({
							where,
							data: { title: "Example forbidden update" },
						});
					case "delete":
						return appTenantDb.aiChat.delete({ where });
				}
			});
			if (operation === "findUnique") {
				await expect(result).resolves.toBeNull();
			} else {
				await expect(result).rejects.toMatchObject({ code: "P2025" });
			}
			expect(await root.aiChat.findUniqueOrThrow({ where })).toEqual(
				before,
			);
		},
	);

	it("returns the tenant's own row with RLS enforced", async () => {
		const rows = await inTenant(() =>
			tenantDb.aiChat.findMany({ where: { id: chatIds[0] } }),
		);
		expect(rows.map((row) => row.id)).toEqual([chatIds[0]]);
	});

	it("application tenant filter restricts the result to the current organization", async () => {
		const rows = await inTenant(() =>
			tenantDb.aiChat.findMany({ where: { id: { in: chatIds } } }),
		);
		expect(rows.map((row) => row.id)).toEqual([chatIds[0]]);
	});

	it("creates a row allowed by WITH CHECK", async () => {
		const row = await inTenant(() =>
			tenantDb.aiChat.create({
				data: { userId, organizationId: orgIds[0] },
			}),
		);
		expect(row.organizationId).toBe(orgIds[0]);
		expect(
			await root.aiChat.findUnique({ where: { id: row.id } }),
		).not.toBeNull();
	});

	it("rejects a create for the other tenant under WITH CHECK", async () => {
		await expect(
			inTenant(() =>
				tenantDb.aiChat.create({
					data: { userId, organizationId: orgIds[1] },
				}),
			),
		).rejects.toThrow(/row-level security/i);
	});

	it("resets tenant_id on pooled connections after tenant queries", async () => {
		await inTenant(() =>
			tenantDb.aiChat.findMany({ where: { id: chatIds[0] } }),
		);
		const settings = await Promise.all(
			Array.from(
				{ length: 8 },
				() =>
					restricted.$queryRaw<
						{ v: string | null }[]
					>`SELECT current_setting('app.tenant_id', true) AS v`,
			),
		);
		for (const rows of settings) {
			expect(rows).toHaveLength(1);
			expect(["", null]).toContain(rows[0].v);
		}
	});

	it.each(["callback", "array"] as const)(
		"rejects public %s transactions before executing work",
		async (form) => {
			// Runtime check for JavaScript callers; the TS surface omits this API.
			const runtime = tenantDb as unknown as Pick<
				PrismaClient,
				"$transaction"
			>;
			let callbackRan = false;
			const id = `example-rejected-${form}-${suffix}`;
			await expect(
				inTenant(async () =>
					form === "callback"
						? runtime.$transaction(async (tx) => {
								callbackRan = true;
								await tx.aiChat.create({
									data: {
										id,
										userId,
										organizationId: orgIds[0],
									},
								});
							})
						: runtime.$transaction([
								tenantDb.aiChat.create({
									data: {
										id,
										userId,
										organizationId: orgIds[0],
									},
								}),
							]),
				),
			).rejects.toThrow("use withRLSContext(db, tx => …)");
			expect(callbackRan).toBe(false);
			expect(await root.aiChat.findUnique({ where: { id } })).toBeNull();
		},
	);

	it("supports upsert and createMany through the guarded client", async () => {
		const id = `example-upsert-${suffix}`;
		const first = await inTenant(() =>
			tenantDb.aiChat.upsert({
				where: { id },
				create: {
					id,
					userId,
					organizationId: orgIds[0],
					title: "Example initial",
				},
				update: { title: "Example updated" },
			}),
		);
		expect(first.title).toBe("Example initial");
		const second = await inTenant(() =>
			tenantDb.aiChat.upsert({
				where: { id },
				create: { id, userId, organizationId: orgIds[0] },
				update: { title: "Example updated" },
			}),
		);
		expect(second.title).toBe("Example updated");
		const ids = [`example-bulk-a-${suffix}`, `example-bulk-b-${suffix}`];
		const batch = await inTenant(() =>
			tenantDb.aiChat.createMany({
				data: ids.map((id) => ({
					id,
					userId,
					organizationId: orgIds[0],
				})),
			}),
		);
		expect(batch.count).toBe(2);
		expect(await root.aiChat.count({ where: { id: { in: ids } } })).toBe(2);
	});

	it("supports a nested document create through the guarded client", async () => {
		const row = await inTenant(() =>
			tenantDb.aiChat.create({
				data: {
					userId,
					organizationId: orgIds[0],
					chatDocuments: {
						create: {
							userId,
							organizationId: orgIds[0],
							filename: "example.txt",
							s3Path: `example-documents/${suffix}/example.txt`,
							mimeType: "text/plain",
							size: 7,
						},
					},
				},
				include: { chatDocuments: true },
			}),
		);
		expect(row.chatDocuments).toHaveLength(1);
		expect(row.chatDocuments[0].filename).toBe("example.txt");
		expect(
			await root.chatDocument.count({ where: { chatId: row.id } }),
		).toBe(1);
	});
});
