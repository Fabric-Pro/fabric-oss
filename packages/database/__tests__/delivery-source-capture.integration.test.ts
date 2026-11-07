import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "../prisma/generated/client";

const enabled = process.env.RUN_DB_INTEGRATION === "1";
const sourceTables = [
	"delivery_signal_watch",
	"delivery_signal_source_grant",
	"delivery_signal_observation",
	"delivery_signal_source_command",
	"delivery_signal_capture_page",
];
let admin: PrismaClient;
let restricted: PrismaClient;
let store: typeof import("../prisma/queries/delivery-source-capture");
const suffix = randomBytes(5).toString("hex");
const role = `example_signal_s2_rls_${suffix}`;
const owner = `example-owner-${suffix}`;
const other = `example-member-${suffix}`;
const guest = `example-guest-${suffix}`;
const org = `example-org-${suffix}`;
const otherOrg = `example-other-org-${suffix}`;
const project = `example-project-${suffix}`;
const otherProject = `example-other-project-${suffix}`;
const integrationId = `example-slack-${suffix}`;
const scope = { organizationId: org, userId: owner, projectId: project };
const encrypted = `${"a".repeat(64)}:${"b".repeat(32)}:${"c".repeat(32)}:dd`;
const payloadHash = "d".repeat(64);
let channel = 0;
async function newWatch() {
	return store.configureDeliverySourceWatch(scope, {
		integrationId,
		requestId: randomUUID(),
		payloadHash,
		retentionDays: 7,
		proof: {
			installationId: "TEXAMPLE01",
			containerId: `CEXAMPLE${String(++channel).padStart(2, "0")}`,
			humanUserId: "UEXAMPLE01",
			botId: "BEXAMPLE01",
			botUserId: "UEXAMPLE02",
			adapterVersion: "slack-root-v1",
			label: "#example-private",
			verifiedAt: new Date(),
		},
	});
}
async function pageFor(
	watch: Awaited<ReturnType<typeof newWatch>>,
	workflowId: string,
	pageIndex = 0,
): Promise<
	import("../prisma/queries/delivery-source-capture").CommitDeliverySourceCapturePageInput
> {
	const current = await admin.deliverySignalWatch.findUniqueOrThrow({
		where: { id: watch.id },
	});
	const integration = await admin.workflowIntegration.findUniqueOrThrow({
		where: { id: integrationId },
	});
	const now = new Date();
	const receiptKey = createHash("sha256").update(watch.id).digest("hex");
	const evidenceDigest = "e".repeat(64);
	return {
		watchId: watch.id,
		workflowId,
		pageIndex,
		configVersion: watch.version,
		grantRevision: watch.grantRevision,
		expectedCheckpointVersion: current.captureCheckpointVersion,
		expectedCredentialDigest: createHash("sha256")
			.update(integration.credentials)
			.digest("hex"),
		expectedIntegrationUpdatedAt: integration.updatedAt,
		windowStart: new Date(now.getTime() - 86_400_000),
		windowEnd: now,
		cursorCiphertext: encrypted,
		complete: false,
		coverage: "ROOT_MESSAGES_ONLY",
		observations: [
			{
				id: randomUUID(),
				externalItemId: "1794000000.000001",
				revisionKind: "DECIMAL",
				revisionValue: "1794000000.000001",
				receiptKey,
				evidenceDigest,
				variantKey: createHash("sha256")
					.update(
						JSON.stringify([
							1,
							receiptKey,
							"UPSERT",
							evidenceDigest,
						]),
					)
					.digest("hex"),
				ciphertext: encrypted,
				hasReplies: true,
				occurredAt: new Date(now.getTime() - 1000),
				expiresAt: new Date(now.getTime() + 6 * 86_400_000),
			},
		],
		result: { captured: 1, hasMore: true, coverage: "ROOT_MESSAGES_ONLY" },
	};
}
async function admit(watch: Awaited<ReturnType<typeof newWatch>>) {
	const requestId = randomUUID();
	const workflowId = `example-capture-${randomUUID()}`;
	await store.prepareDeliverySourceCaptureCommand(scope, {
		watchId: watch.id,
		requestId,
		payloadHash,
		workflowId,
		expectedVersion: watch.version,
		expectedLastRequestId: null,
		mode: "RECENT",
	});
	return workflowId;
}
async function tenant<T>(
	userId: string,
	organizationId: string,
	work: (tx: Prisma.TransactionClient) => Promise<T>,
) {
	return restricted.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT set_config('app.tenant_type','organization',true),set_config('app.tenant_id',${organizationId},true),set_config('app.user_id',${userId},true)`;
		return work(tx);
	});
}

describe.skipIf(!enabled)(
	"private capture actual restricted-role PostgreSQL",
	() => {
		beforeAll(async () => {
			const url = new URL(process.env.DIRECT_URL ?? "");
			if (
				!["localhost", "127.0.0.1"].includes(url.hostname) ||
				url.port !== "55463" ||
				!/^\/example_(?:signal_s2|source_history)_direct_[a-f0-9]{10}$/.test(
					url.pathname,
				)
			) {
				throw new Error(
					"Only the explicitly owned disposable S2 database is allowed",
				);
			}
			admin = new PrismaClient({
				adapter: new PrismaPg({ connectionString: url.toString() }),
			});
			await admin.$executeRawUnsafe(
				`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`,
			);
			await admin.$executeRawUnsafe(
				`GRANT USAGE ON SCHEMA public TO "${role}"`,
			);
			await admin.$executeRawUnsafe(
				`GRANT SELECT,INSERT,UPDATE,DELETE ON ${sourceTables.map((name) => `"${name}"`).join(",")} TO "${role}"`,
			);
			await admin.$executeRawUnsafe(
				`GRANT SELECT ON project,project_member,member,organization,"user",workflow_integration TO "${role}"`,
			);
			await admin.$executeRawUnsafe(
				`GRANT SELECT,INSERT ON audit_log TO "${role}"`,
			);
			// PostgreSQL requires one UPDATE column privilege for SELECT ... FOR SHARE.
			// RLS still applies; this does not grant credential updates.
			await admin.$executeRawUnsafe(
				`GRANT UPDATE("updatedAt") ON workflow_integration TO "${role}"`,
			);
			const now = new Date();
			await admin.user.createMany({
				data: [owner, other, guest].map((id, i) => ({
					id,
					name: `Example actor ${i}`,
					email: `example-${i}-${suffix}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				})),
			});
			await admin.organization.createMany({
				data: [org, otherOrg].map((id, i) => ({
					id,
					name: `Example organization ${i}`,
					createdAt: now,
				})),
			});
			await admin.member.createMany({
				data: [
					{
						id: randomUUID(),
						organizationId: org,
						userId: owner,
						role: "owner",
						createdAt: now,
					},
					{
						id: randomUUID(),
						organizationId: org,
						userId: other,
						role: "owner",
						createdAt: now,
					},
				],
			});
			await admin.project.createMany({
				data: [project, otherProject].map((id) => ({
					id,
					name: "Example capture project",
					organizationId: org,
					userId: owner,
					techStack: [],
					features: [],
					tags: [],
				})),
			});
			await admin.projectMember.create({
				data: {
					projectId: project,
					userId: guest,
					invitedBy: owner,
					role: "EDITOR",
					acceptedAt: now,
				},
			});
			await admin.workflowIntegration.create({
				data: {
					id: integrationId,
					userId: owner,
					organizationId: org,
					provider: "SLACK",
					name: "Example standalone Slack",
					credentials: encrypted,
				},
			});
			url.searchParams.set("options", `-c role=${role}`);
			restricted = new PrismaClient({
				adapter: new PrismaPg({ connectionString: url.toString() }),
			});
			vi.resetModules();
			vi.doMock("../prisma/client", () => ({ db: restricted, Prisma }));
			store = await import("../prisma/queries/delivery-source-capture");
		}, 30_000);
		afterAll(async () => {
			await restricted?.$disconnect();
			if (admin) {
				await admin.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
				await admin.$executeRawUnsafe(`DROP ROLE "${role}"`);
				await admin.$disconnect();
			}
		});
		it("executes the production store on a non-owner NOSUPERUSER NOBYPASSRLS role", async () => {
			const [actual] = await restricted.$queryRaw<
				Array<{ name: string; bypass: boolean; superuser: boolean }>
			>`SELECT current_user::text AS name,r.rolbypassrls AS bypass,r.rolsuper AS superuser FROM pg_roles r WHERE r.rolname=current_user`;
			expect(actual).toEqual({
				name: role,
				bypass: false,
				superuser: false,
			});
			const tables = await admin.$queryRaw<
				Array<{
					relname: string;
					relrowsecurity: boolean;
					relforcerowsecurity: boolean;
				}>
			>`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname LIKE 'delivery_signal_%'`;
			expect(
				tables.filter((row) => sourceTables.includes(row.relname)),
			).toHaveLength(5);
			expect(
				tables
					.filter((row) => sourceTables.includes(row.relname))
					.every(
						(row) => row.relrowsecurity && row.relforcerowsecurity,
					),
			).toBe(true);
		});
		it("creates an owner-scoped source and its atomic audit through real guards", async () => {
			const watch = await newWatch();
			expect(watch).toMatchObject({
				...scope,
				state: "ACTIVE",
				grantRevision: 1,
			});
			expect(
				await admin.auditLog.count({
					where: {
						resourceId: watch.id,
						action: "project.delivery_source.configured",
					},
				}),
			).toBe(1);
		});
		it("denies unscoped, other-user and other-organization raw reads despite broad table grants", async () => {
			const watch = await newWatch();
			const workflowId = await admit(watch);
			await store.commitDeliverySourceCapturePage(
				scope,
				await pageFor(watch, workflowId),
			);
			for (const table of sourceTables) {
				const count = async (tx: Prisma.TransactionClient) =>
					(
						await tx.$queryRawUnsafe<Array<{ n: number }>>(
							`SELECT count(*)::int AS n FROM "${table}"`,
						)
					)[0].n;
				expect(await count(restricted)).toBe(0);
				expect(await tenant(other, org, count)).toBe(0);
				expect(await tenant(owner, otherOrg, count)).toBe(0);
				expect(await tenant(owner, org, count)).toBeGreaterThan(0);
			}
		});
		it("refuses a forged actor row through RLS WITH CHECK", async () => {
			await expect(
				tenant(other, org, (tx) =>
					tx.deliverySignalWatch.create({
						data: {
							...scope,
							integrationId,
							installationId: "TEXAMPLE01",
							containerId: "CEXAMPLE99",
							label: "Example",
							verifiedAt: new Date(),
						},
					}),
				),
			).rejects.toThrow();
		});
		it("repeats live org membership and stops project guests", async () => {
			await expect(
				store.listOwnedDeliverySourceWatches({
					...scope,
					userId: guest,
				}),
			).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION" });
		});
		it("rejects foreign project ownership and soft deletion without leaking a private source", async () => {
			const watch = await newWatch();
			expect(
				await store.getOwnedDeliverySourceWatch(
					{ ...scope, projectId: otherProject },
					watch.id,
				),
			).toBeNull();
			await admin.project.update({
				where: { id: project },
				data: { deletedAt: new Date() },
			});
			try {
				await expect(
					store.listOwnedDeliverySourceWatches(scope),
				).rejects.toMatchObject({ code: "NOT_FOUND" });
			} finally {
				await admin.project.update({
					where: { id: project },
					data: { deletedAt: null },
				});
			}
		});
		it("commits one page atomically and replays only its prior result after checkpoint advancement", async () => {
			const watch = await newWatch();
			const workflowId = await admit(watch);
			const input = await pageFor(watch, workflowId);
			await expect(
				store.commitDeliverySourceCapturePage(scope, input),
			).resolves.toMatchObject({ captured: 1 });
			await expect(
				store.commitDeliverySourceCapturePage(scope, input),
			).resolves.toMatchObject({ captured: 1 });
			expect(
				await admin.deliverySignalObservation.count({
					where: { watchId: watch.id },
				}),
			).toBe(1);
			expect(
				await admin.deliverySignalCapturePage.count({
					where: { watchId: watch.id },
				}),
			).toBe(1);
			const saved = await admin.deliverySignalWatch.findUniqueOrThrow({
				where: { id: watch.id },
			});
			expect(saved.captureCheckpointVersion).toBe(
				input.expectedCheckpointVersion + 1,
			);
		});
		it("deduplicates identical evidence across pages and stores the actual new count", async () => {
			const watch = await newWatch();
			const workflowId = await admit(watch);
			const first = await pageFor(watch, workflowId);
			await store.commitDeliverySourceCapturePage(scope, first);
			const second = {
				...first,
				pageIndex: 1,
				expectedCheckpointVersion: first.expectedCheckpointVersion + 1,
				observations: first.observations.map((item) => ({
					...item,
					id: randomUUID(),
				})),
			};
			await expect(
				store.commitDeliverySourceCapturePage(scope, second),
			).resolves.toMatchObject({ captured: 0 });
			expect(
				await store.getDeliverySourcePageReceipt(scope, {
					watchId: watch.id,
					workflowId,
					pageIndex: 1,
				}),
			).toMatchObject({ captured: 0 });
		});
		it("preserves conflicting immutable variants at one upstream revision", async () => {
			const watch = await newWatch();
			const workflowId = await admit(watch);
			const input = await pageFor(watch, workflowId);
			const conflict = {
				...input.observations[0],
				id: randomUUID(),
				evidenceDigest: "f".repeat(64),
			};
			conflict.variantKey = createHash("sha256")
				.update(
					JSON.stringify([
						1,
						conflict.receiptKey,
						"UPSERT",
						conflict.evidenceDigest,
					]),
				)
				.digest("hex");
			await expect(
				store.commitDeliverySourceCapturePage(scope, {
					...input,
					observations: [...input.observations, conflict],
					result: { ...input.result, captured: 2 },
				}),
			).resolves.toMatchObject({ captured: 2 });
			const page = await store.listOwnedDeliverySourceObservations(
				scope,
				{ watchId: watch.id, limit: 20 },
			);
			expect(page.items).toHaveLength(2);
			expect(page.items.every((item) => item.hasConflict)).toBe(true);
		});
		it("honors a real project-role demotion over the owner's organization role", async () => {
			const watch = await newWatch();
			const demotion = await admin.projectMember.create({
				data: {
					projectId: project,
					userId: owner,
					invitedBy: owner,
					role: "VIEWER",
					acceptedAt: new Date(),
				},
			});
			try {
				await expect(admit(watch)).rejects.toMatchObject({
					code: "INSUFFICIENT_PERMISSION",
				});
			} finally {
				await admin.projectMember.delete({
					where: { id: demotion.id },
				});
			}
		});

		it("fences replacement credentials before committing evidence or a page receipt", async () => {
			const watch = await newWatch();
			const workflowId = await admit(watch);
			const input = await pageFor(watch, workflowId);
			await admin.workflowIntegration.update({
				where: { id: integrationId },
				data: { credentials: `${encrypted}ee` },
			});
			try {
				await expect(
					store.commitDeliverySourceCapturePage(scope, input),
				).rejects.toMatchObject({ code: "CONFIGURATION_CHANGED" });
				expect(
					await admin.deliverySignalObservation.count({
						where: { watchId: watch.id },
					}),
				).toBe(0);
				expect(
					await admin.deliverySignalCapturePage.count({
						where: { watchId: watch.id },
					}),
				).toBe(0);
			} finally {
				await admin.workflowIntegration.update({
					where: { id: integrationId },
					data: { credentials: encrypted },
				});
			}
		});
		it("fences a durable cancel intent before an uncommitted provider page effect", async () => {
			const watch = await newWatch();
			const workflowId = await admit(watch);
			const input = await pageFor(watch, workflowId);
			await store.prepareDeliverySourceCancelCommand(scope, {
				watchId: watch.id,
				workflowId,
				requestId: randomUUID(),
				payloadHash,
			});
			expect(
				await store.getOwnedDeliverySourceCaptureCancellation(scope, {
					watchId: watch.id,
					workflowId,
				}),
			).not.toBeNull();
			await expect(
				store.commitDeliverySourceCapturePage(scope, input),
			).rejects.toMatchObject({ code: "CONFIGURATION_CHANGED" });
			expect(
				await admin.deliverySignalObservation.count({
					where: { watchId: watch.id },
				}),
			).toBe(0);
			expect(
				await admin.deliverySignalCapturePage.count({
					where: { watchId: watch.id },
				}),
			).toBe(0);
		});

		it("keeps evidence immutable and rejects a cross-watch/cross-project grant tuple", async () => {
			const watch = await newWatch();
			const workflowId = await admit(watch);
			const input = await pageFor(watch, workflowId);
			await store.commitDeliverySourceCapturePage(scope, input);
			await expect(
				tenant(owner, org, (tx) =>
					tx.deliverySignalObservation.updateMany({
						where: { watchId: watch.id },
						data: { ciphertext: `${encrypted}ff` },
					}),
				),
			).rejects.toThrow();
			const row = await admin.deliverySignalObservation.findFirstOrThrow({
				where: { watchId: watch.id },
			});
			await expect(
				tenant(owner, org, (tx) =>
					tx.deliverySignalObservation.create({
						data: {
							...row,
							id: randomUUID(),
							projectId: otherProject,
						},
					}),
				),
			).rejects.toThrow();
		});
		it("allows prior receipts while paused, but blocks new page effects and purges on disconnect", async () => {
			const watch = await newWatch();
			const workflowId = await admit(watch);
			const input = await pageFor(watch, workflowId);
			await store.commitDeliverySourceCapturePage(scope, input);
			const paused = await store.changeDeliverySourceWatchState(scope, {
				watchId: watch.id,
				expectedVersion: watch.version,
				action: "PAUSE",
				requestId: randomUUID(),
				payloadHash,
			});
			expect(
				await store.getDeliverySourcePageReceipt(scope, {
					watchId: watch.id,
					workflowId,
					pageIndex: 0,
				}),
			).toMatchObject({ captured: 1 });
			await expect(
				store.commitDeliverySourceCapturePage(scope, {
					...input,
					pageIndex: 1,
				}),
			).rejects.toMatchObject({ code: "CONFIGURATION_CHANGED" });
			await store.changeDeliverySourceWatchState(scope, {
				watchId: watch.id,
				expectedVersion: paused.version,
				action: "DISCONNECT",
				requestId: randomUUID(),
				payloadHash,
			});
			expect(
				await admin.deliverySignalObservation.count({
					where: { watchId: watch.id },
				}),
			).toBe(0);
			expect(
				await admin.deliverySignalSourceGrant.count({
					where: { watchId: watch.id, revokedAt: null },
				}),
			).toBe(0);
		});
		it("enforces expiry before maintenance and never returns an expired cursor anchor", async () => {
			const watch = await newWatch();
			const workflowId = await admit(watch);
			await store.commitDeliverySourceCapturePage(
				scope,
				await pageFor(watch, workflowId),
			);
			const row = await admin.deliverySignalObservation.findFirstOrThrow({
				where: { watchId: watch.id },
			});
			const capturedAt = new Date(Date.now() - 86_400_000);
			const expired = await admin.deliverySignalObservation.create({
				data: {
					...row,
					id: randomUUID(),
					variantKey: "a".repeat(64),
					createdAt: capturedAt,
					expiresAt: new Date(Date.now() - 1000),
				},
			});
			expect(
				await store.getOwnedDeliverySourceObservation(scope, {
					watchId: watch.id,
					observationId: expired.id,
				}),
			).toBeNull();
			const page = await store.listOwnedDeliverySourceObservations(
				scope,
				{ watchId: watch.id, limit: 20 },
			);
			expect(page.items.map((item) => item.id)).not.toContain(expired.id);
			await expect(
				store.listOwnedDeliverySourceObservations(scope, {
					watchId: watch.id,
					limit: 20,
					cursor: { id: expired.id, capturedAt },
				}),
			).rejects.toMatchObject({ code: "INVALID_INPUT" });
		});
		it("stops a banned actor or removed live member even when source ownership remains", async () => {
			const watch = await newWatch();
			await admin.user.update({
				where: { id: owner },
				data: { banned: true, banExpires: null },
			});
			try {
				await expect(
					store.getOwnedDeliverySourceWatch(scope, watch.id),
				).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION" });
			} finally {
				await admin.user.update({
					where: { id: owner },
					data: { banned: false },
				});
			}
			const member = await admin.member.findUniqueOrThrow({
				where: {
					organizationId_userId: {
						organizationId: org,
						userId: owner,
					},
				},
			});
			await admin.member.delete({ where: { id: member.id } });
			try {
				await expect(
					store.getOwnedDeliverySourceWatch(scope, watch.id),
				).rejects.toThrow();
			} finally {
				await admin.member.create({ data: member });
			}
		});

		it("retains evidence and the old cancellation fence across a fresh capture admission", async () => {
			const watch = await newWatch();
			const previousWorkflowId = await admit(watch);
			const page = await pageFor(watch, previousWorkflowId);
			await store.commitDeliverySourceCapturePage(scope, page);
			const saved =
				await admin.deliverySignalObservation.findFirstOrThrow({
					where: { watchId: watch.id },
				});
			const current =
				await store.getLastOwnedDeliverySourceCaptureCommand(
					scope,
					watch.id,
				);
			expect(current?.workflowId).toBe(previousWorkflowId);
			if (!current) {
				throw new Error("Expected prior capture fixture");
			}
			await store.prepareDeliverySourceCancelCommand(scope, {
				watchId: watch.id,
				workflowId: previousWorkflowId,
				requestId: randomUUID(),
				payloadHash: "b".repeat(64),
			});
			const nextWorkflowId = `example-capture-recovery-${randomUUID()}`;
			const next = await store.prepareDeliverySourceCaptureCommand(
				scope,
				{
					watchId: watch.id,
					requestId: randomUUID(),
					workflowId: nextWorkflowId,
					expectedVersion: watch.version,
					expectedLastRequestId: current.requestId,
					mode: "RECENT",
					payloadHash: "c".repeat(64),
				},
			);
			expect(next.mayDispatch).toBe(true);
			expect(next.watch.lastWorkflowId).toBe(nextWorkflowId);
			expect(
				await store.getOwnedDeliverySourceCaptureCancellation(scope, {
					watchId: watch.id,
					workflowId: previousWorkflowId,
				}),
			).toMatchObject({
				workflowId: previousWorkflowId,
				operation: "CANCEL",
			});
			await expect(
				store.commitDeliverySourceCapturePage(scope, {
					...page,
					pageIndex: 1,
				}),
			).rejects.toMatchObject({ code: "CONFIGURATION_CHANGED" });
			expect(
				await admin.deliverySignalObservation.findUnique({
					where: { id: saved.id },
				}),
			).not.toBeNull();
			expect(
				await store.getOwnedDeliverySourceObservation(scope, {
					watchId: watch.id,
					observationId: saved.id,
				}),
			).toMatchObject({ id: saved.id });
		});

		it("persists selected history intent under forced owner RLS and rejects a changed retry", async () => {
			const watch = await newWatch();
			const start = new Date(Date.now() - 30 * 86400000);
			const end = new Date(Date.now() - 29 * 86400000);
			const input = {
				watchId: watch.id,
				requestId: randomUUID(),
				payloadHash: "a".repeat(64),
				workflowId: `example-history-${randomUUID()}`,
				expectedVersion: watch.version,
				expectedLastRequestId: null,
				mode: "BACKFILL" as const,
				window: { start: start.toISOString(), end: end.toISOString() },
			};
			const first = await store.prepareDeliverySourceCaptureCommand(
				scope,
				input,
			);
			expect(first.receipt).toMatchObject({
				captureMode: "BACKFILL",
				captureWindowStart: start,
				captureWindowEnd: end,
			});
			expect(
				(await store.prepareDeliverySourceCaptureCommand(scope, input))
					.receipt.id,
			).toBe(first.receipt.id);
			await expect(
				store.prepareDeliverySourceCaptureCommand(scope, {
					...input,
					payloadHash: "b".repeat(64),
					window: {
						...input.window,
						end: new Date(end.getTime() - 1000).toISOString(),
					},
				}),
			).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
			expect(
				await tenant(other, org, (tx) =>
					tx.deliverySignalSourceCommand.count({
						where: { id: first.receipt.id },
					}),
				),
			).toBe(0);
		});
		it("fences historical page dates and resumes exactly the selected window", async () => {
			const watch = await newWatch();
			const start = new Date(Date.now() - 30 * 86400000);
			const end = new Date(Date.now() - 29 * 86400000);
			const requestId = randomUUID();
			const workflowId = `example-history-${randomUUID()}`;
			await store.prepareDeliverySourceCaptureCommand(scope, {
				watchId: watch.id,
				requestId,
				payloadHash,
				workflowId,
				expectedVersion: watch.version,
				expectedLastRequestId: null,
				mode: "BACKFILL",
				window: { start: start.toISOString(), end: end.toISOString() },
			});
			const input = await pageFor(watch, workflowId);
			input.windowStart = start;
			input.windowEnd = end;
			input.observations[0].occurredAt = new Date(start.getTime() + 1000);
			await expect(
				store.commitDeliverySourceCapturePage(scope, {
					...input,
					windowEnd: new Date(end.getTime() - 1000),
				}),
			).rejects.toMatchObject({ code: "CONFIGURATION_CHANGED" });
			await expect(
				store.commitDeliverySourceCapturePage(scope, input),
			).resolves.toMatchObject({ captured: 1, hasMore: true });
			const continued = await store.prepareDeliverySourceCaptureCommand(
				scope,
				{
					watchId: watch.id,
					requestId: randomUUID(),
					payloadHash: "b".repeat(64),
					workflowId: `example-history-continued-${randomUUID()}`,
					expectedVersion: watch.version,
					expectedLastRequestId: requestId,
					mode: "CONTINUE",
				},
			);
			expect(continued.watch).toMatchObject({
				captureWindowStart: start,
				captureWindowEnd: end,
				captureComplete: false,
			});
		});
		it("requires the actual qualified worker identity for global maintenance", async () => {
			await expect(
				store.purgeExpiredDeliverySourceObservations({ batchSize: 50 }),
			).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION" });
		});

		it("purges expired evidence across owners only as the policy-qualified worker", async () => {
			// The cluster and database are explicitly disposable. Never change an
			// existing worker role, including its grants, attributes or password.
			const existing = await admin.$queryRaw<Array<{ rolname: string }>>`
			 SELECT rolname FROM pg_roles WHERE rolname='fabric_worker'`;
			expect(existing).toHaveLength(0);
			let worker: PrismaClient | undefined;
			let created = false;
			try {
				await admin.$executeRawUnsafe(
					"CREATE ROLE fabric_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT",
				);
				created = true;
				await admin.$executeRawUnsafe(
					"GRANT USAGE ON SCHEMA public TO fabric_worker",
				);
				await admin.$executeRawUnsafe(
					"GRANT SELECT,UPDATE,DELETE ON delivery_signal_observation TO fabric_worker",
				);
				const url = new URL(process.env.DIRECT_URL ?? "");
				url.searchParams.set("options", "-c role=fabric_worker");
				worker = new PrismaClient({
					adapter: new PrismaPg({ connectionString: url.toString() }),
				});
				vi.resetModules();
				vi.doMock("../prisma/client", () => ({ db: worker, Prisma }));
				const workerStore = await import(
					"../prisma/queries/delivery-source-capture"
				);
				const [identity] = await worker.$queryRaw<
					Array<{ name: string; bypass: boolean; superuser: boolean }>
				>`SELECT current_user::text AS name,r.rolbypassrls AS bypass,r.rolsuper AS superuser
				 FROM pg_roles r WHERE r.rolname=current_user`;
				expect(identity).toEqual({
					name: "fabric_worker",
					bypass: false,
					superuser: false,
				});
				await expect(
					workerStore.purgeExpiredDeliverySourceObservations({
						batchSize: 2,
					}),
				).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION" });
				await admin.$executeRawUnsafe(
					"CREATE POLICY worker_bypass ON delivery_signal_observation FOR ALL TO fabric_worker USING (true) WITH CHECK (true)",
				);

				const watch = await newWatch();
				const workflowId = await admit(watch);
				await store.commitDeliverySourceCapturePage(
					scope,
					await pageFor(watch, workflowId),
				);
				const fresh =
					await admin.deliverySignalObservation.findFirstOrThrow({
						where: { watchId: watch.id },
					});
				const expiredAt = new Date(Date.now() - 86_400_000);
				const oldCapture = new Date(Date.now() - 8 * 86_400_000);
				for (let i = 0; i < 3; i++) {
					await admin.deliverySignalObservation.create({
						data: {
							...fresh,
							id: randomUUID(),
							variantKey: createHash("sha256")
								.update(`expired-${i}`)
								.digest("hex"),
							expiresAt: expiredAt,
							createdAt: oldCapture,
						},
					});
				}
				const privateProject = await admin.project.create({
					data: {
						id: randomUUID(),
						name: "Example other capture",
						organizationId: otherOrg,
						userId: other,
						techStack: [],
						features: [],
						tags: [],
					},
				});
				const privateWatch = await admin.deliverySignalWatch.create({
					data: {
						organizationId: otherOrg,
						projectId: privateProject.id,
						userId: other,
						installationId: "TEXAMPLE02",
						containerId: "CEXAMPLE99",
						label: "#example-other",
						verifiedAt: new Date(),
					},
				});
				const privateGrant =
					await admin.deliverySignalSourceGrant.create({
						data: {
							watchId: privateWatch.id,
							organizationId: otherOrg,
							projectId: privateProject.id,
							userId: other,
							revision: 1,
							humanUserId: "UEXAMPLE03",
							botId: "BEXAMPLE02",
							botUserId: "UEXAMPLE04",
							adapterVersion: "slack-root-v1",
							verifiedAt: new Date(),
						},
					});
				const otherExpired =
					await admin.deliverySignalObservation.create({
						data: {
							...fresh,
							id: randomUUID(),
							watchId: privateWatch.id,
							grantId: privateGrant.id,
							organizationId: otherOrg,
							projectId: privateProject.id,
							userId: other,
							expiresAt: expiredAt,
							createdAt: oldCapture,
						},
					});
				const before = await admin.deliverySignalObservation.count({
					where: { expiresAt: { lte: new Date() } },
				});
				expect(before).toBeGreaterThanOrEqual(3);
				expect(
					await workerStore.purgeExpiredDeliverySourceObservations({
						batchSize: 2,
					}),
				).toBe(2);
				let deleted = 2;
				for (let batch = 0; batch < 10; batch++) {
					const count =
						await workerStore.purgeExpiredDeliverySourceObservations(
							{ batchSize: 500 },
						);
					deleted += count;
					if (count < 500) {
						break;
					}
				}
				expect(deleted).toBe(before);
				expect(
					await admin.deliverySignalObservation.findUnique({
						where: { id: otherExpired.id },
					}),
				).toBeNull();
				expect(
					await admin.deliverySignalObservation.findUnique({
						where: { id: fresh.id },
					}),
				).not.toBeNull();
				expect(
					await admin.deliverySignalObservation.count({
						where: { expiresAt: { lte: new Date() } },
					}),
				).toBe(0);
			} finally {
				await worker?.$disconnect();
				if (created) {
					await admin.$executeRawUnsafe(
						"DROP POLICY IF EXISTS worker_bypass ON delivery_signal_observation",
					);
					await admin.$executeRawUnsafe(
						"DROP OWNED BY fabric_worker",
					);
					await admin.$executeRawUnsafe("DROP ROLE fabric_worker");
				}
				vi.resetModules();
				vi.doMock("../prisma/client", () => ({
					db: restricted,
					Prisma,
				}));
			}
		}, 30_000);
	},
);
