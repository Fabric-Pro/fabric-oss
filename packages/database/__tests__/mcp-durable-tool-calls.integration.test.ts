import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import {
	claimMcpDurableToolCall,
	completeMcpDurableToolCall,
	purgeExpiredMcpDurableToolCalls,
} from "../prisma/queries/mcp-durable-tool-calls";

const userOne = "example-durable-user-one";
const userTwo = "example-durable-user-two";
const orgOne = "example-durable-org-one";
const orgTwo = "example-durable-org-two";
const base = {
	organizationId: orgOne,
	userId: userOne,
	credentialKind: "ORGANIZATION_API_KEY",
	credentialId: "example-credential-one",
	projectBinding: "example-project-one",
	serverBinding: "platform",
	toolName: "fabric_get_project",
	idempotencyKey: "example-key",
	argsHash: "a".repeat(64),
};

describe.skipIf(
	!process.env.DATABASE_URL || process.env.RUN_DB_INTEGRATION !== "1",
)("MCP durable tool calls in Postgres", () => {
	beforeAll(async () => {
		await db.user.createMany({
			data: [
				{
					id: userOne,
					name: "Example One",
					email: "durable-one@example.com",
					emailVerified: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
				{
					id: userTwo,
					name: "Example Two",
					email: "durable-two@example.com",
					emailVerified: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			],
		});
		await db.organization.createMany({
			data: [
				{
					id: orgOne,
					name: "Example One",
					slug: orgOne,
					createdAt: new Date(),
				},
				{
					id: orgTwo,
					name: "Example Two",
					slug: orgTwo,
					createdAt: new Date(),
				},
			],
		});
	});

	beforeEach(async () => {
		await db.mcpDurableToolCall.deleteMany({
			where: { organizationId: { in: [orgOne, orgTwo] } },
		});
	});

	afterAll(async () => {
		await db.mcpDurableToolCall.deleteMany({
			where: { organizationId: { in: [orgOne, orgTwo] } },
		});
		await db.organization.deleteMany({
			where: { id: { in: [orgOne, orgTwo] } },
		});
		await db.user.deleteMany({ where: { id: { in: [userOne, userTwo] } } });
		await db.$disconnect();
	});

	it("claims, completes, and replays an unexpired result", async () => {
		const first = await claimMcpDurableToolCall(base);
		expect(first.kind).toBe("claimed");
		await completeMcpDurableToolCall({
			executionId: first.call.id,
			claimUpdatedAt: first.call.updatedAt,
			status: "COMPLETED",
			result: { content: [{ type: "text", text: "example" }] },
		});
		const replay = await claimMcpDurableToolCall(base);
		expect(replay.kind).toBe("replay");
		expect(replay.call.result).toEqual({
			content: [{ type: "text", text: "example" }],
		});
	});

	it("refuses a changed hash and a live RUNNING claim", async () => {
		await claimMcpDurableToolCall(base);
		expect(
			(
				await claimMcpDurableToolCall({
					...base,
					argsHash: "b".repeat(64),
				})
			).kind,
		).toBe("conflict");
		expect((await claimMcpDurableToolCall(base)).kind).toBe("in_progress");
	});

	it("reclaims FAILED, expired, and stale RUNNING rows", async () => {
		for (const [suffix, status, updatedAt, expiresAt] of [
			["failed", "FAILED", new Date(), new Date(Date.now() + 60_000)],
			["expired", "COMPLETED", new Date(), new Date(0)],
			["stale", "RUNNING", new Date(0), new Date(Date.now() + 60_000)],
		] as const) {
			await db.mcpDurableToolCall.create({
				data: {
					...base,
					idempotencyKey: suffix,
					status,
					updatedAt,
					expiresAt,
				},
			});
			const result = await claimMcpDurableToolCall({
				...base,
				idempotencyKey: suffix,
				argsHash: suffix === "expired" ? "b".repeat(64) : base.argsHash,
			});
			expect(result.kind).toBe("claimed");
			if (suffix === "expired") {
				expect(result.call.argsHash).toBe("b".repeat(64));
			}
		}
	});

	it("isolates the same key by user and organization", async () => {
		const claims = await Promise.all([
			claimMcpDurableToolCall(base),
			claimMcpDurableToolCall({ ...base, userId: userTwo }),
			claimMcpDurableToolCall({ ...base, organizationId: orgTwo }),
		]);
		expect(claims.map((claim) => claim.kind)).toEqual([
			"claimed",
			"claimed",
			"claimed",
		]);
	});

	it("allows exactly one concurrent first claim", async () => {
		const claims = await Promise.all(
			Array.from({ length: 8 }, () => claimMcpDurableToolCall(base)),
		);

		expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(
			1,
		);
		expect(
			claims.filter((claim) => claim.kind === "in_progress"),
		).toHaveLength(7);
	});

	it("allows exactly one concurrent reclaim of a stale running row", async () => {
		await db.mcpDurableToolCall.create({
			data: {
				...base,
				updatedAt: new Date(0),
				expiresAt: new Date(Date.now() + 60_000),
			},
		});
		const now = new Date();
		const claims = await Promise.all(
			Array.from({ length: 8 }, () =>
				claimMcpDurableToolCall({ ...base, now }),
			),
		);

		expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(
			1,
		);
		expect(
			claims.filter((claim) => claim.kind === "in_progress"),
		).toHaveLength(7);
	});

	it("refuses completion from a stale claim after another caller reclaims it", async () => {
		const original = await claimMcpDurableToolCall(base);
		expect(original.kind).toBe("claimed");
		await db.mcpDurableToolCall.update({
			where: { id: original.call.id },
			data: { updatedAt: new Date(0) },
		});

		const replacement = await claimMcpDurableToolCall({
			...base,
			now: new Date(),
		});
		expect(replacement.kind).toBe("claimed");
		await expect(
			completeMcpDurableToolCall({
				executionId: original.call.id,
				claimUpdatedAt: original.call.updatedAt,
				status: "COMPLETED",
				result: { content: [{ type: "text", text: "stale" }] },
			}),
		).rejects.toThrow("claim is no longer current");
	});

	it("purges expired receipts in a bounded cleanup", async () => {
		await db.mcpDurableToolCall.create({
			data: { ...base, expiresAt: new Date(0) },
		});
		expect(await purgeExpiredMcpDurableToolCalls()).toBe(1);
	});
});
