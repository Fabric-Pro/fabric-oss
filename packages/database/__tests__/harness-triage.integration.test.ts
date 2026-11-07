import { randomBytes, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "../prisma/generated/client";

const enabled = process.env.RUN_DB_INTEGRATION === "1";
const suffix = randomBytes(5).toString("hex");
const role = `example_triage_rls_${suffix}`;
const organizationId = `example-triage-org-${suffix}`;
const userId = `example-triage-owner-${suffix}`;
const other = `example-triage-other-${suffix}`;
const projectId = `example-triage-project-${suffix}`;
const integrationId = `example-triage-source-${suffix}`;
const scope = { organizationId, projectId, userId };
const encrypted = `${"a".repeat(64)}:${"b".repeat(32)}:${"c".repeat(32)}:dd`;
let admin: PrismaClient;
let restricted: PrismaClient;
let store: typeof import("../prisma/queries/harness-triage");
let sources: typeof import("../prisma/queries/delivery-source-capture");

async function admit(watchId = "example-watch") {
	const now = new Date();
	return store.admitHarnessTriageRun(scope, {
		id: randomUUID(),
		requestId: randomUUID(),
		inputHash: "a".repeat(64),
		goalCiphertext: encrypted,
		credential: { kind: "SESSION" },
		evidence: [
			{
				observationId: "example-observation",
				watchId,
				grantId: "example-grant",
				grantRevision: 1,
				evidenceDigest: "b".repeat(64),
			},
		],
		model: { example: true },
		workflowId: `example-triage-${randomUUID()}`,
		maxTokens: 10000,
		maxMicroUsd: BigInt(1000),
		periodStart: new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
		),
		expiresAt: new Date(now.getTime() + 60000),
	});
}
const reserve = (id: string, ordinal = 1) =>
	store.reserveHarnessTriageCall(scope, {
		runId: id,
		callId: `${id}:model:${ordinal}`,
		ordinal,
		requestDigest: "c".repeat(64),
		reservedTokens: 100,
		reservedMicroUsd: 10,
		monthlyTokens: 2000000,
		monthlyMicroUsd: 1000000,
	});
async function sourceWatch() {
	await admin.workflowIntegration.update({
		where: { id: integrationId },
		data: { isActive: true, credentials: encrypted },
	});
	return sources.configureDeliverySourceWatch(scope, {
		integrationId,
		requestId: randomUUID(),
		payloadHash: "d".repeat(64),
		retentionDays: 7,
		proof: {
			installationId: "TEXAMPLE01",
			containerId: `CEXAMPLE${randomBytes(4).toString("hex").toUpperCase()}`,
			humanUserId: "UEXAMPLE01",
			botId: "BEXAMPLE01",
			botUserId: "UEXAMPLE02",
			adapterVersion: "slack-root-v1",
			label: "#example-private",
			verifiedAt: new Date(),
		},
	});
}
async function completed(watchId: string, finish = true) {
	const run = await admit(watchId);
	await store.finishHarnessTriageRun(scope, run.id, "RUNNING");
	await reserve(run.id);
	await store.dispatchHarnessTriageCall(
		scope,
		run.id,
		`${run.id}:model:1`,
		"c".repeat(64),
	);
	await store.recordHarnessTriageResponse(
		scope,
		run.id,
		`${run.id}:model:1`,
		encrypted,
	);
	await store.transitionHarnessTriageCall(
		scope,
		run.id,
		`${run.id}:model:1`,
		"SETTLED",
		{ tokens: 50, microUsd: 5 },
	);
	if (finish) {
		await store.finishHarnessTriageRun(
			scope,
			run.id,
			"COMPLETED",
			encrypted,
		);
	}
	return run;
}
async function sourceMutation(
	work: (tx: Prisma.TransactionClient) => Promise<unknown>,
) {
	return restricted.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT set_config('app.tenant_type','organization',true),set_config('app.tenant_id',${organizationId},true),set_config('app.user_id',${userId},true)`;
		return work(tx);
	});
}

describe.skipIf(!enabled)("private triage restricted-role PostgreSQL", () => {
	beforeAll(async () => {
		const url = new URL(process.env.DIRECT_URL ?? "");
		if (
			!["127.0.0.1", "localhost"].includes(url.hostname) ||
			url.port !== "55463" ||
			!/^\/example_(?:harness_triage|signal_s2)_direct_[a-f0-9]{10}$/.test(
				url.pathname,
			)
		) {
			throw Error(
				"Only an explicitly owned disposable local triage database is allowed",
			);
		}
		admin = new PrismaClient({
			adapter: new PrismaPg({ connectionString: url.href }),
		});
		await admin.$executeRawUnsafe(
			`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`,
		);
		await admin.$executeRawUnsafe(
			`GRANT USAGE ON SCHEMA public TO "${role}"`,
		);
		await admin.$executeRawUnsafe(
			`GRANT SELECT,INSERT,UPDATE,DELETE ON harness_triage_run,harness_triage_call,harness_triage_budget,delivery_signal_watch,delivery_signal_source_grant,delivery_signal_observation,delivery_signal_source_command,delivery_signal_capture_page TO "${role}"`,
		);
		await admin.$executeRawUnsafe(
			`GRANT SELECT ON project,project_member,member,organization,"user",workflow_integration TO "${role}"`,
		);
		await admin.$executeRawUnsafe(
			`GRANT UPDATE("updatedAt","isActive",credentials) ON workflow_integration TO "${role}"`,
		);
		await admin.$executeRawUnsafe(
			`GRANT SELECT,INSERT ON audit_log TO "${role}"`,
		);
		const now = new Date();
		await admin.user.createMany({
			data: [userId, other].map((id, i) => ({
				id,
				name: "Example triage actor",
				email: `example-triage-${i}-${suffix}@example.com`,
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			})),
		});
		await admin.organization.create({
			data: {
				id: organizationId,
				name: "Example triage organization",
				createdAt: now,
			},
		});
		await admin.member.createMany({
			data: [userId, other].map((id) => ({
				id: randomUUID(),
				organizationId,
				userId: id,
				role: "owner",
				createdAt: now,
			})),
		});
		await admin.project.create({
			data: {
				id: projectId,
				userId,
				organizationId,
				name: "Example triage project",
				features: [],
				techStack: [],
				tags: [],
			},
		});
		await admin.projectMember.create({
			data: {
				projectId,
				userId: other,
				invitedBy: userId,
				role: "EDITOR",
				acceptedAt: now,
			},
		});
		await admin.workflowIntegration.create({
			data: {
				id: integrationId,
				organizationId,
				userId,
				provider: "SLACK",
				name: "Example private source",
				credentials: encrypted,
			},
		});
		url.searchParams.set("options", `-c role=${role}`);
		restricted = new PrismaClient({
			adapter: new PrismaPg({ connectionString: url.href }),
		});
		vi.resetModules();
		vi.doMock("../prisma/client", () => ({ db: restricted, Prisma }));
		store = await import("../prisma/queries/harness-triage");
		sources = await import("../prisma/queries/delivery-source-capture");
	}, 30000);
	afterAll(async () => {
		await restricted?.$disconnect();
		if (admin) {
			await admin.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
			await admin.$executeRawUnsafe(`DROP ROLE "${role}"`);
			await admin.$disconnect();
		}
	});
	it("runs with neither superuser nor RLS bypass authority", async () => {
		const [actual] = await restricted.$queryRaw<
			Array<{ rolsuper: boolean; rolbypassrls: boolean }>
		>`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
		expect(actual).toEqual({ rolsuper: false, rolbypassrls: false });
	});
	it("admits exactly one concurrent send and fences physical dispatch", async () => {
		const run = await admit();
		await store.finishHarnessTriageRun(scope, run.id, "RUNNING");
		const admissions = await Promise.all(
			Array.from({ length: 4 }, () => reserve(run.id)),
		);
		expect(
			admissions.filter((x) => x?.dispatch === "SEND_ONCE"),
		).toHaveLength(1);
		expect(
			(
				await Promise.all([
					store.dispatchHarnessTriageCall(
						scope,
						run.id,
						`${run.id}:model:1`,
						"c".repeat(64),
					),
					store.dispatchHarnessTriageCall(
						scope,
						run.id,
						`${run.id}:model:1`,
						"c".repeat(64),
					),
				])
			).sort(),
		).toEqual([false, true]);
	});
	it("replays only settled matching calls and never downgrades settled accounting", async () => {
		const run = await completed("example-watch", false);
		expect((await reserve(run.id))?.dispatch).toBe("REPLAY");
		await store.transitionHarnessTriageCall(
			scope,
			run.id,
			`${run.id}:model:1`,
			"UNKNOWN",
		);
		expect(
			(await store.getHarnessTriageRun(scope, run.id))?.measuredTokens,
		).toBe(BigInt(50));
		expect(
			await store.getHarnessTriageRun(
				{ ...scope, userId: other },
				run.id,
			),
		).toBeNull();
	});
	it("cancels without releasing dispatched spend, but releases known-unsent reservations", async () => {
		const run = await admit();
		await store.finishHarnessTriageRun(scope, run.id, "RUNNING");
		await reserve(run.id);
		await store.dispatchHarnessTriageCall(
			scope,
			run.id,
			`${run.id}:model:1`,
			"c".repeat(64),
		);
		await reserve(run.id, 2);
		await store.cancelHarnessTriageRun(scope, run.id);
		expect(await store.getHarnessTriageRun(scope, run.id)).toMatchObject({
			status: "CANCELLED",
			failureCode: "OUTCOME_UNKNOWN",
			outstandingTokens: BigInt(100),
		});
		expect(
			await store.countUncertainHarnessTriageCalls(scope, run.id),
		).toBe(1);
		expect(await reserve(run.id, 1)).toBeNull();
	});
	it.each(["deactivate", "rotate", "disconnect"])(
		"%s purges derived bodies under forced RLS and preserves measured spend",
		async (operation) => {
			const watch = await sourceWatch();
			const run = await completed(watch.id);
			if (operation === "deactivate") {
				await sourceMutation((tx) =>
					tx.workflowIntegration.update({
						where: { id: integrationId },
						data: { isActive: false },
					}),
				);
			} else if (operation === "rotate") {
				await sourceMutation((tx) =>
					tx.workflowIntegration.update({
						where: { id: integrationId },
						data: { credentials: `${encrypted}ff` },
					}),
				);
			} else {
				await sourceMutation((tx) =>
					tx.deliverySignalWatch.update({
						where: { id: watch.id },
						data: { state: "DISCONNECTED" },
					}),
				);
			}
			expect(
				await store.getHarnessTriageRun(scope, run.id),
			).toMatchObject({
				goalCiphertext: "",
				resultCiphertext: null,
				measuredTokens: BigInt(50),
			});
			expect(
				await admin.harnessTriageCall.count({
					where: { runId: run.id, responseCiphertext: { not: null } },
				}),
			).toBe(0);
		},
	);
	it("refuses global expiry scans on an unqualified app role", async () => {
		expect(await store.isHarnessTriageRetentionWorkerQualified()).toBe(
			false,
		);
		await expect(store.listExpiredHarnessTriageContent()).rejects.toThrow();
	});
});
