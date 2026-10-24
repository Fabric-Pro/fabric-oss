import { randomUUID } from "node:crypto";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { z } from "zod";
import { db, Prisma } from "../../../../database/prisma/client";
import { createParlumeToolRuntime } from "../parlume-actions";

vi.mock("@repo/database", async () => {
	const { db } = await import("../../../../database/prisma/client");
	const { recordAuditTx } = await import(
		"../../../../database/prisma/queries/audit-log"
	);
	return {
		db,
		recordAuditTx,
		hasProjectAccess: async () => true,
		canEditProject: async () => true,
	};
});
vi.mock("../parlume-voice", () => ({
	readParlumeVoiceState: async () => ({
		current: true,
		muted: false,
		chatAvailable: true,
	}),
}));

const prefix = `parlume-claim-${randomUUID()}`;
const userId = `${prefix}-user`;
const organizationId = `${prefix}-org`;
const projectId = `${prefix}-project`;
const sessionId = `${prefix}-session`;
const turnId = `${prefix}-turn`;
const context = {
	turnId,
	sessionId,
	projectId,
	organizationId,
	userId,
	speakerId: "speaker",
	speakerName: "Requester",
	requestText: "create a ticket",
	agentRevision: "revision",
	voiceGeneration: 1,
	toolsReadOnly: false,
};
const source = { configId: "connection", originalName: "create_ticket" };
const execute = vi.fn(async () => ({ success: true }));
const definition = { inputSchema: z.object({ title: z.string() }), execute };

async function clearFixtureAudit() {
	await db.$transaction([
		db.$executeRaw`SET LOCAL app.audit_allow_delete = 'on'`,
		db.auditLog.deleteMany({ where: { projectId } }),
	]);
}

describe.skipIf(process.env.RUN_DB_INTEGRATION !== "1")(
	"Parlume PostgreSQL execution claims",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
			INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
			VALUES (${userId}, ${"Parlume fixture"}, ${`${prefix}@example.com`}, true, false, ${now}, ${now})
		`);
			await db.$executeRaw(Prisma.sql`
			INSERT INTO "organization" (id, name, slug, "createdAt")
			VALUES (${organizationId}, ${"Parlume fixture"}, ${prefix}, ${now})
		`);
			await db.project.create({
				data: {
					id: projectId,
					name: "Parlume fixture",
					userId,
					organizationId,
					techStack: [],
					features: [],
					tags: [],
				},
			});
			await db.parlumeMeetingSession.create({
				data: {
					id: sessionId,
					projectId,
					organizationId,
					userId,
					agentKind: "FABRIC_AGENT",
					streamTokenDigest: "synthetic",
					status: "ACTIVE",
					toolsReadOnly: false,
				},
			});
			await db.parlumeMeetingTurn.create({
				data: {
					id: turnId,
					sessionId,
					projectId,
					organizationId,
					userId,
					dedupeKey: turnId,
					requestText: "Create a ticket",
					voiceGeneration: 1,
				},
			});
		});
		beforeEach(async () => {
			execute.mockClear();
			await db.parlumeAction.deleteMany({ where: { sessionId } });
			await clearFixtureAudit();
			await db.parlumeMeetingSession.update({
				where: { id: sessionId },
				data: { activeTurnId: turnId, voiceGeneration: 1 },
			});
		});
		const invoke = () =>
			createParlumeToolRuntime(context).invoke({
				name: "create_ticket",
				...definition,
				source,
				args: { title: "Exact requested title" },
				delegates: false,
				execute: () => execute(),
			});

		it("dispatches and audits once under concurrent identical calls", async () => {
			await Promise.all(Array.from({ length: 4 }, invoke));
			expect(execute).toHaveBeenCalledTimes(1);
			expect(
				await db.auditLog.count({
					where: {
						projectId,
						action: "project.parlume.action_confirmed",
					},
				}),
			).toBe(1);
			expect(
				await db.parlumeAction.findMany({ where: { sessionId } }),
			).toMatchObject([
				{
					status: "COMPLETED",
					speakerId: "speaker",
					arguments: { title: "Exact requested title" },
				},
			]);
		});

		it("cannot dispatch after a committed interruption advances the session", async () => {
			await db.parlumeMeetingSession.update({
				where: { id: sessionId },
				data: { activeTurnId: null, voiceGeneration: 2 },
			});
			await invoke();
			expect(execute).not.toHaveBeenCalled();
			expect(await db.auditLog.count({ where: { projectId } })).toBe(0);
			expect(await db.parlumeAction.count({ where: { sessionId } })).toBe(
				0,
			);
		});

		afterAll(async () => {
			await clearFixtureAudit();
			await db.project.deleteMany({ where: { id: projectId } });
			await db.organization.deleteMany({ where: { id: organizationId } });
			await db.user.deleteMany({ where: { id: userId } });
			await db.$disconnect();
		});
	},
);
