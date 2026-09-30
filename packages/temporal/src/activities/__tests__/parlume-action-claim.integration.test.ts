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
import {
	createParlumeToolRuntime,
	prepareParlumeDecision,
} from "../parlume-actions";

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
	verifyParlumeVoiceGeneration: async () => true,
}));

const prefix = `parlume-claim-${randomUUID()}`;
const userId = `${prefix}-user`;
const organizationId = `${prefix}-org`;
const projectId = `${prefix}-project`;
const sessionId = `${prefix}-session`;
const turnId = `${prefix}-proposal`;
const confirmationTurnId = `${prefix}-confirmation`;
const context = {
	turnId,
	sessionId,
	projectId,
	organizationId,
	userId,
	speakerId: "speaker",
	speakerName: "Requester",
	agentRevision: "revision",
	voiceGeneration: 1,
	toolsReadOnly: false,
};
const source = { configId: "connection", originalName: "create_ticket" };
const execute = vi.fn(async () => ({ success: true }));
const definition = { inputSchema: z.object({ title: z.string() }), execute };
const tools = { create_ticket: definition };
const sources = { create_ticket: source };

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
			await db.parlumeMeetingTurn.createMany({
				data: [turnId, confirmationTurnId].map((id) => ({
					id,
					sessionId,
					projectId,
					organizationId,
					userId,
					dedupeKey: id,
					requestText: id === turnId ? "Create a ticket" : "confirm",
					voiceGeneration: 1,
				})),
			});
		});
		beforeEach(async () => {
			execute.mockClear();
			await db.parlumeAction.deleteMany({ where: { sessionId } });
			await clearFixtureAudit();
			await db.parlumeMeetingSession.update({
				where: { id: sessionId },
				data: { activeTurnId: confirmationTurnId, voiceGeneration: 1 },
			});
			await createParlumeToolRuntime(context).invoke({
				name: "create_ticket",
				...definition,
				source,
				args: { title: "Exact approved title" },
				delegates: false,
				execute,
			});
			await db.parlumeAction.updateMany({
				where: { sessionId },
				data: {
					status: "AWAITING_CONFIRMATION",
					presentedAt: new Date(),
				},
			});
		});
		const prepare = () =>
			prepareParlumeDecision(
				{ ...context, turnId: confirmationTurnId },
				"confirm",
			);

		it("dispatches and audits once under concurrent confirmations", async () => {
			const decisions = await Promise.all(
				Array.from({ length: 4 }, prepare),
			);
			await Promise.all(
				decisions.map((decision) =>
					decision.runtime?.prepared?.(tools, sources),
				),
			);
			expect(execute).toHaveBeenCalledTimes(1);
			expect(execute).toHaveBeenCalledWith(
				{ title: "Exact approved title" },
				expect.anything(),
			);
			expect(
				await db.auditLog.count({
					where: {
						projectId,
						action: "project.parlume.action_confirmed",
					},
				}),
			).toBe(1);
			expect(
				await db.parlumeAction.findFirst({ where: { sessionId } }),
			).toMatchObject({ status: "COMPLETED", confirmationTurnId });
		});

		it("cannot dispatch after a committed interruption advances the session", async () => {
			const decision = await prepare();
			await db.parlumeMeetingSession.update({
				where: { id: sessionId },
				data: { activeTurnId: null, voiceGeneration: 2 },
			});
			await decision.runtime?.prepared?.(tools, sources);
			expect(execute).not.toHaveBeenCalled();
			expect(await db.auditLog.count({ where: { projectId } })).toBe(0);
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
