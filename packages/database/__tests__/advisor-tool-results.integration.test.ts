import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import {
	AdvisorResultReadTimeoutError,
	advisorToolResultStorage,
} from "../prisma/queries/advisor-tool-results";
import { isOrganizationMember } from "../prisma/queries/verify-organization-membership";

const scope = {
	userId: "example-store-user",
	organizationId: "example-store-org",
	conversationId: "example-store-conversation",
	turnId: "example-store-turn",
};
const write = (
	sourceKey = "example-execution:0",
	text = "example result",
	attempt = 1,
) =>
	advisorToolResultStorage.write({
		...scope,
		attempt,
		sourceKey,
		toolName: "code_tree",
		text,
	});

describe.skipIf(process.env.RUN_DB_INTEGRATION !== "1")(
	"Advisor result storage in PostgreSQL",
	() => {
		beforeAll(async () => {
			await db.user.create({
				data: {
					id: scope.userId,
					name: "Example",
					email: "store@example.com",
					emailVerified: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
			await db.organization.create({
				data: {
					id: scope.organizationId,
					name: "Example",
					slug: scope.organizationId,
					createdAt: new Date(),
				},
			});
			await db.agentConversation.create({
				data: {
					id: scope.conversationId,
					userId: scope.userId,
					organizationId: scope.organizationId,
					agentId: "orchestrator",
				},
			});
			await db.conversationTurn.create({
				data: {
					id: scope.turnId,
					generation: 1,
					userId: scope.userId,
					organizationId: scope.organizationId,
					conversationId: scope.conversationId,
					executionId: "example-store-execution",
					clientRequestKey: "example-store-request",
					status: "ACTIVE",
				},
			});
		});
		beforeEach(async () => {
			await db.advisorToolResult.deleteMany({
				where: { conversationId: scope.conversationId },
			});
		});
		afterAll(async () => {
			await db.advisorToolResult.deleteMany({
				where: { conversationId: scope.conversationId },
			});
			await db.agentConversation.deleteMany({
				where: { id: scope.conversationId },
			});
			await db.conversationTurn.deleteMany({
				where: { id: scope.turnId },
			});
			await db.organization.deleteMany({
				where: { id: scope.organizationId },
			});
			await db.user.deleteMany({ where: { id: scope.userId } });
			await db.$disconnect();
		});
		const readScope = () => ({
			...scope,
			beforeTurnGeneration: 2,
		});
		it("lists only thirty newest rows with stored byte sizes and bounded stored heads", async () => {
			const text = `${"x".repeat(199)}😀é${"y".repeat(1000)}`;
			await db.advisorToolResult.createMany({
				data: Array.from({ length: 35 }, (_, i) => ({
					...scope,
					id: `example-list-${i}`,
					sourceKey: `list-${i}`,
					attempt: 1,
					toolName: "code_tree",
					sizeBytes: Buffer.byteLength(text),
					content: { v: 1, text },
					createdAt: new Date(i * 1000),
					expiresAt: new Date(Date.now() + 60_000),
				})),
			});
			const rows = await advisorToolResultStorage.list(readScope());
			expect(rows.map((r) => r.id)).toEqual(
				Array.from({ length: 30 }, (_, i) => `example-list-${34 - i}`),
			);
			for (const row of rows) {
				expect(row).toMatchObject({
					toolName: "code_tree",
					sizeBytes: Buffer.byteLength(text),
					excerpt: Array.from(text).slice(0, 200).join(""),
					valid: true,
				});
			}
			// Omitted rows remain addressable with the same scope.
			expect(
				await advisorToolResultStorage.read({
					...readScope(),
					id: "example-list-0",
				}),
			).toEqual({ toolName: "code_tree", content: { v: 1, text } });
		});
		it.each(["userId", "organizationId", "conversationId"] as const)(
			"scopes both reader queries by %s",
			async (field) => {
				await write();
				const row = await db.advisorToolResult.findFirstOrThrow();
				const input = { ...readScope(), [field]: "example-other" };
				expect(await advisorToolResultStorage.list(input)).toEqual([]);
				expect(
					await advisorToolResultStorage.read({
						...input,
						id: row.id,
					}),
				).toBeNull();
			},
		);
		it("denies expired rows in both queries", async () => {
			await write();
			const row = await db.advisorToolResult.findFirstOrThrow();
			await db.advisorToolResult.update({
				where: { id: row.id },
				data: { expiresAt: new Date(0) },
			});
			expect(await advisorToolResultStorage.list(readScope())).toEqual(
				[],
			);
			expect(
				await advisorToolResultStorage.read({
					...readScope(),
					id: row.id,
				}),
			).toBeNull();
		});
		it("excludes the current turn and turns newer than the current turn", async () => {
			await write();
			const row = await db.advisorToolResult.findFirstOrThrow();
			const otherTurn = await db.conversationTurn.create({
				data: {
					userId: scope.userId,
					organizationId: scope.organizationId,
					conversationId: scope.conversationId,
					clientRequestKey: "example-earlier-key",
					generation: 0,
					status: "COMPLETED",
				},
			});
			try {
				for (const beforeTurnGeneration of [1, 0]) {
					const input = { ...scope, beforeTurnGeneration };
					expect(await advisorToolResultStorage.list(input)).toEqual(
						[],
					);
					expect(
						await advisorToolResultStorage.read({
							...input,
							id: row.id,
						}),
					).toBeNull();
				}
			} finally {
				await db.conversationTurn.delete({
					where: { id: otherTurn.id },
				});
			}
		});
		it("takes discovery and page content from the same persisted attempt", async () => {
			await write(undefined, "workflow saw this first", 1);
			await write(undefined, "stored later 😀 attempt", 2);
			const [row] = await advisorToolResultStorage.list(readScope());
			expect(row.excerpt).toBe("stored later 😀 attempt");
			expect(row.sizeBytes).toBe(
				Buffer.byteLength("stored later 😀 attempt"),
			);
			expect(
				await advisorToolResultStorage.read({
					...readScope(),
					id: row.id,
				}),
			).toEqual({
				toolName: "code_tree",
				content: { v: 1, text: row.excerpt },
			});
		});
		it.each([
			{ v: 2, text: "example" },
			{ v: 1, text: 4 },
		])(
			"marks unreadable content %j instead of pretending it is valid text",
			async (content) => {
				await write();
				await db.advisorToolResult.updateMany({
					data: { content },
				});
				expect(
					(await advisorToolResultStorage.list(readScope()))[0].valid,
				).toBe(false);
			},
		);
		it("returns no row for an unknown stored id", async () => {
			await write();
			expect(
				await advisorToolResultStorage.read({
					...readScope(),
					id: "example-unknown",
				}),
			).toBeNull();
		});
		it("bounds a reader waiting for an exclusive table lock", async () => {
			let ready!: () => void;
			let release!: () => void;
			const locked = new Promise<void>((r) => {
				ready = r;
			});
			const held = new Promise<void>((r) => {
				release = r;
			});
			const blocker = db.$transaction(async (tx) => {
				await tx.$executeRawUnsafe(
					"LOCK TABLE advisor_tool_result IN ACCESS EXCLUSIVE MODE",
				);
				ready();
				await held;
			});
			await locked;
			try {
				const start = Date.now();
				await expect(
					advisorToolResultStorage.list(readScope()),
				).rejects.toBeInstanceOf(AdvisorResultReadTimeoutError);
				await expect(
					advisorToolResultStorage.read({
						...readScope(),
						id: "example-row",
					}),
				).rejects.toBeInstanceOf(AdvisorResultReadTimeoutError);
				expect(Date.now() - start).toBeLessThan(2000);
			} finally {
				release();
				await blocker;
			}
		});

		it.each(["agent_conversation", "member", "conversation_turn"])(
			"bounds authorization reads blocked on %s inside the read transaction",
			async (table) => {
				let ready!: () => void;
				let release!: () => void;
				const locked = new Promise<void>((resolve) => {
					ready = resolve;
				});
				const held = new Promise<void>((resolve) => {
					release = resolve;
				});
				const blocker = db.$transaction(async (tx) => {
					await tx.$executeRawUnsafe(
						`LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`,
					);
					ready();
					await held;
				});
				await locked;
				try {
					const started = Date.now();
					await expect(
						advisorToolResultStorage.readTransaction(
							"list",
							async (tx) => {
								await tx.agentConversation.findFirst({
									where: {
										id: scope.conversationId,
										userId: scope.userId,
										organizationId: scope.organizationId,
									},
									select: { id: true },
								});
								await isOrganizationMember(
									scope.userId,
									scope.organizationId,
									tx,
								);
								await tx.conversationTurn.findFirst({
									where: {
										id: scope.turnId,
										userId: scope.userId,
										organizationId: scope.organizationId,
									},
									select: { generation: true },
								});
							},
						),
					).rejects.toBeInstanceOf(AdvisorResultReadTimeoutError);
					expect(Date.now() - started).toBeLessThan(600);
				} finally {
					release();
					await blocker;
				}
			},
		);
		it.each(["list", "page"] as const)(
			"bounds a running %s statement on the database server",
			async (kind) => {
				const started = Date.now();
				await expect(
					advisorToolResultStorage.readTransaction(
						kind,
						(tx) => tx.$queryRaw`SELECT pg_sleep(2)`,
					),
				).rejects.toBeInstanceOf(AdvisorResultReadTimeoutError);
				expect(Date.now() - started).toBeLessThan(
					kind === "list" ? 600 : 1450,
				);
			},
		);
		it.each(["list", "page"] as const)(
			"bounds a stalled %s authorization callback by the transaction lifetime",
			async (kind) => {
				const started = Date.now();
				await expect(
					advisorToolResultStorage.readTransaction(
						kind,
						async () => new Promise(() => {}),
					),
				).rejects.toBeInstanceOf(AdvisorResultReadTimeoutError);
				expect(Date.now() - started).toBeLessThan(
					kind === "list" ? 600 : 1450,
				);
			},
		);
		it("reads a one-MiB stored row under the page budget", async () => {
			const text = "x".repeat(1024 * 1024);
			await write("example-max-page", text);
			const [entry] = await advisorToolResultStorage.list(readScope());
			const started = Date.now();
			expect(
				await advisorToolResultStorage.read({
					...readScope(),
					id: entry.id,
				}),
			).toEqual({ toolName: "code_tree", content: { v: 1, text } });
			expect(Date.now() - started).toBeLessThan(1450);
		});

		it("stores the owner snapshot, UTF-8 size and v1 envelope for exactly two days", async () => {
			expect(await write(undefined, "é😀")).toBe("stored");
			const rows = await db.advisorToolResult.findMany();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				...scope,
				toolName: "code_tree",
				sizeBytes: 6,
				content: { v: 1, text: "é😀" },
			});
			expect(
				rows[0].expiresAt.getTime() - rows[0].createdAt.getTime(),
			).toBe(2 * 24 * 60 * 60 * 1000);
			expect(Object.keys(rows[0]).sort()).toEqual(
				[
					"id",
					"userId",
					"organizationId",
					"conversationId",
					"turnId",
					"sourceKey",
					"attempt",
					"toolName",
					"sizeBytes",
					"content",
					"createdAt",
					"expiresAt",
				].sort(),
			);
		});
		it("keeps one unchanged row when the same attempt is written twice", async () => {
			expect(await write()).toBe("stored");
			const before = await db.advisorToolResult.findFirstOrThrow();
			expect(await write(undefined, "changed retry output")).toBe(
				"duplicate",
			);
			expect(await db.advisorToolResult.count()).toBe(1);
			expect(
				(await db.advisorToolResult.findFirstOrThrow()).content,
			).toEqual({ v: 1, text: "example result" });
			expect(await db.advisorToolResult.findFirstOrThrow()).toEqual(
				before,
			);
		});
		it.each([
			"userId",
			"organizationId",
			"conversationId",
			"turnId",
		] as const)("rejects a mismatching %s", async (field) => {
			expect(
				await advisorToolResultStorage.write({
					...scope,
					attempt: 1,
					[field]: "example-other",
					sourceKey: "other",
					toolName: "code_tree",
					text: "private",
				}),
			).toBe("scope_mismatch");
			expect(await db.advisorToolResult.count()).toBe(0);
		});
		it("binds the turn to this conversation, even when the owner and organization match", async () => {
			const other = await db.agentConversation.create({
				data: {
					userId: scope.userId,
					organizationId: scope.organizationId,
					agentId: "orchestrator",
				},
			});
			try {
				expect(
					await advisorToolResultStorage.write({
						...scope,
						attempt: 1,
						conversationId: other.id,
						sourceKey: "wrong-conversation",
						toolName: "code_tree",
						text: "private",
					}),
				).toBe("scope_mismatch");
				expect(await db.advisorToolResult.count()).toBe(0);
			} finally {
				await db.agentConversation.delete({ where: { id: other.id } });
			}
		});
		it("accepts one MiB and rejects even one extra UTF-8 byte", async () => {
			expect(await write("boundary", "a".repeat(1024 * 1024))).toBe(
				"stored",
			);
			expect(
				await write("oversize", `${"a".repeat(1024 * 1024 - 1)}é`),
			).toBe("row_limit");
			expect(await db.advisorToolResult.count()).toBe(1);
		});
		it("serializes competing writes at the 16 MiB cap and ignores expired content", async () => {
			const text = "x".repeat(1024 * 1024);
			for (let i = 0; i < 15; i++) {
				expect(await write(`seed-${i}`, text)).toBe("stored");
			}
			expect(
				(
					await Promise.all([
						write("race-a", text),
						write("race-b", text),
					])
				).sort(),
			).toEqual(["conversation_limit", "stored"]);
			expect(await db.advisorToolResult.count()).toBe(16);
			await db.advisorToolResult.updateMany({
				data: { expiresAt: new Date(0) },
			});
			expect(await write("after-expiry", text)).toBe("stored");
		});
		it("times out a contested conversation lock without leaving a row", async () => {
			let release!: () => void;
			let ready!: () => void;
			const held = new Promise<void>((r) => {
				release = r;
			});
			const locked = new Promise<void>((r) => {
				ready = r;
			});
			const blocker = db.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT id FROM agent_conversation WHERE id=${scope.conversationId} FOR UPDATE`;
				ready();
				await held;
			});
			await locked;
			const start = Date.now();
			try {
				await expect(write()).rejects.toThrow();
				expect(Date.now() - start).toBeLessThan(2000);
				expect(await db.advisorToolResult.count()).toBe(0);
			} finally {
				release();
				await blocker;
			}
		});
		it("deletes only expired rows in bounded, repeatable batches", async () => {
			await write("live");
			await db.advisorToolResult.createMany({
				data: Array.from({ length: 5001 }, (_, i) => ({
					...scope,
					sourceKey: `expired-${i}`,
					attempt: 1,
					toolName: "code_tree",
					sizeBytes: 1,
					content: { v: 1, text: "x" },
					expiresAt: new Date(0),
				})),
			});
			expect(await advisorToolResultStorage.deleteExpired()).toBe(5000);
			expect(await advisorToolResultStorage.deleteExpired()).toBe(1);
			expect(await advisorToolResultStorage.deleteExpired()).toBe(0);
			expect(
				(await db.advisorToolResult.findMany()).map((r) => r.sourceKey),
			).toEqual(["live"]);
		});
		it("cascades conversation deletion", async () => {
			await write();
			await db
				.$transaction(async (tx) => {
					await tx.agentConversation.delete({
						where: { id: scope.conversationId },
					});
					expect(await tx.advisorToolResult.count()).toBe(0);
					throw new Error("example rollback");
				})
				.catch((e) => {
					expect(e.message).toBe("example rollback");
				});
			expect(await db.advisorToolResult.count()).toBe(1);
		});
		it("enforces owner-only RLS for organization, other owner, other tenant and null context", async () => {
			await write();
			await db.$executeRawUnsafe(
				"CREATE ROLE example_advisor_store_reader NOLOGIN NOSUPERUSER NOBYPASSRLS",
			);
			try {
				await db.$executeRawUnsafe(
					"GRANT USAGE ON SCHEMA public TO example_advisor_store_reader",
				);
				await db.$executeRawUnsafe(
					"GRANT SELECT ON advisor_tool_result TO example_advisor_store_reader",
				);
				for (const [userId, organizationId, tenantType, expected] of [
					[scope.userId, scope.organizationId, "organization", 1],
					[
						"example-other-user",
						scope.organizationId,
						"organization",
						0,
					],
					[scope.userId, "example-other-org", "organization", 0],
					[scope.userId, "", "user", 0],
				] as const) {
					await db.$transaction(async (tx) => {
						await tx.$executeRawUnsafe(
							"SET LOCAL ROLE example_advisor_store_reader",
						);
						await tx.$queryRaw`SELECT set_config('app.user_id',${userId},true),set_config('app.tenant_id',${organizationId},true),set_config('app.tenant_type',${tenantType},true)`;
						expect(await tx.advisorToolResult.count()).toBe(
							expected,
						);
					});
				}
			} finally {
				await db.$executeRawUnsafe(
					"REVOKE SELECT ON advisor_tool_result FROM example_advisor_store_reader",
				);
				await db.$executeRawUnsafe(
					"REVOKE USAGE ON SCHEMA public FROM example_advisor_store_reader",
				);
				await db.$executeRawUnsafe(
					"DROP ROLE example_advisor_store_reader",
				);
			}
		});

		it("bounds pool acquisition when other work holds all ten connections", async () => {
			let release!: () => void;
			let ready!: () => void;
			let acquired = 0;
			const held = new Promise<void>((r) => {
				release = r;
			});
			const allReady = new Promise<void>((r) => {
				ready = r;
			});
			const blockers = Array.from({ length: 10 }, () =>
				db.$transaction(
					async (tx) => {
						await tx.$queryRaw`SELECT 1`;
						if (++acquired === 10) {
							ready();
						}
						await held;
					},
					{ timeout: 5000 },
				),
			);
			await allReady;
			const start = Date.now();
			try {
				await expect(write()).rejects.toThrow();
				expect(Date.now() - start).toBeLessThan(2000);
			} finally {
				release();
				await Promise.all(blockers);
			}
			expect(await db.advisorToolResult.count()).toBe(0);
		});
		it("enforces the unique logical-call key at the database boundary", async () => {
			await write();
			const row = await db.advisorToolResult.findFirstOrThrow();
			await expect(
				db.advisorToolResult.create({
					data: {
						...row,
						content: { v: 1, text: "example result" },
						id: "example-duplicate-row",
					},
				}),
			).rejects.toThrow();
		});
		it.each(["userId", "organizationId"] as const)(
			"constrains copied %s to the parent turn",
			async (field) => {
				await write();
				const row = await db.advisorToolResult.findFirstOrThrow();
				await expect(
					db.advisorToolResult.create({
						data: {
							...row,
							content: { v: 1, text: "example result" },
							id: "example-mismatch-row",
							sourceKey: "example-other-key",
							[field]: "example-other",
						},
					}),
				).rejects.toThrow();
			},
		);
		it("higher activity attempts replace content, size and expiry on the same row", async () => {
			await write(undefined, "first", 1);
			const first = await db.advisorToolResult.findFirstOrThrow();
			await db.advisorToolResult.update({
				where: { id: first.id },
				data: { expiresAt: new Date(0) },
			});
			const before = Date.now();
			expect(await write(undefined, "é😀", 2)).toBe("stored");
			const row = await db.advisorToolResult.findFirstOrThrow();
			expect(await db.advisorToolResult.count()).toBe(1);
			expect(row).toMatchObject({
				id: first.id,
				createdAt: first.createdAt,
				attempt: 2,
				sizeBytes: 6,
				content: { v: 1, text: "é😀" },
			});
			expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(
				before + 2 * 24 * 60 * 60 * 1000,
			);
			expect(row.expiresAt.getTime()).toBeLessThanOrEqual(
				Date.now() + 2 * 24 * 60 * 60 * 1000,
			);
		});
		it("does not let a lower abandoned attempt arriving later replace a higher one", async () => {
			await write(undefined, "newer result", 2);
			const before = await db.advisorToolResult.findFirstOrThrow();
			expect(await write(undefined, "late old result", 1)).toBe(
				"duplicate",
			);
			expect(await db.advisorToolResult.findFirstOrThrow()).toEqual(
				before,
			);
		});
		it("accounts for growth and shrinkage when replacing content at the conversation cap", async () => {
			const mib = "x".repeat(1024 * 1024);
			const half = mib.slice(0, 512 * 1024);
			for (let i = 0; i < 15; i++) {
				expect(await write(`seed-${i}`, mib)).toBe("stored");
			}
			await write("replace", half, 1);
			expect(await write("replace", mib, 2)).toBe("stored");
			expect(await write("replace", half, 3)).toBe("stored");
			expect(await write("freed-capacity", half)).toBe("stored");
			expect(await write("over-cap", "x")).toBe("conversation_limit");
			expect(
				(
					await db.advisorToolResult.aggregate({
						_sum: { sizeBytes: true },
					})
				)._sum.sizeBytes,
			).toBe(16 * 1024 * 1024);
		});
		it("does not reclaim expired content twice when a higher attempt replaces it", async () => {
			const mib = "x".repeat(1024 * 1024);
			for (let i = 0; i < 15; i++) {
				await write(`seed-${i}`, mib);
			}
			await write("replace", mib);
			await db.advisorToolResult.updateMany({
				where: { sourceKey: "replace" },
				data: { expiresAt: new Date(0) },
			});
			await write("fills-cap", mib);
			expect(await write("replace", "x", 2)).toBe("conversation_limit");
			expect(
				(
					await db.advisorToolResult.findFirstOrThrow({
						where: { sourceKey: "replace" },
					})
				).attempt,
			).toBe(1);
		});
		it("rechecks expiry after waiting behind an attempt that refreshes the row", async () => {
			await write();
			await db.advisorToolResult.updateMany({
				data: { expiresAt: new Date(0) },
			});
			let ready!: () => void;
			let release!: () => void;
			const locked = new Promise<void>((r) => {
				ready = r;
			});
			const held = new Promise<void>((r) => {
				release = r;
			});
			const refreshed = db.$transaction(
				async (tx) => {
					await tx.advisorToolResult.updateMany({
						data: {
							attempt: 2,
							expiresAt: new Date(
								Date.now() + 2 * 24 * 60 * 60 * 1000,
							),
						},
					});
					ready();
					await held;
				},
				{ timeout: 5000 },
			);
			await locked;
			const purge = advisorToolResultStorage.deleteExpired();
			try {
				const deadline = Date.now() + 2000;
				let waiting = false;
				while (Date.now() < deadline) {
					const [state] = await db.$queryRaw<
						{ waiting: boolean }[]
					>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%DELETE FROM "advisor_tool_result"%') AS waiting`;
					if (state.waiting) {
						waiting = true;
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				expect(waiting).toBe(true);
			} finally {
				release();
				await refreshed;
			}
			expect(await purge).toBe(0);
			expect(await db.advisorToolResult.count()).toBe(1);
		});
	},
);
