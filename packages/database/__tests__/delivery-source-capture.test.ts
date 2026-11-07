import { createHash } from "node:crypto";
import { Permissions } from "@repo/permissions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	user: { findUnique: vi.fn() },
	project: { findFirst: vi.fn() },
	member: { findUnique: vi.fn() },
	watch: {
		findFirst: vi.fn(),
		findMany: vi.fn(),
		count: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
	},
	grant: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
	command: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
	page: { findFirst: vi.fn(), create: vi.fn() },
	observation: {
		findFirst: vi.fn(),
		findMany: vi.fn(),
		createMany: vi.fn(),
		deleteMany: vi.fn(),
		groupBy: vi.fn(),
	},
	integration: { findFirst: vi.fn(), findMany: vi.fn() },
	raw: vi.fn(),
	audit: vi.fn(),
	access: vi.fn(),
	visible: vi.fn(),
	canEdit: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {},
	Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" } },
}));
vi.mock("../src/tenant-db", () => ({
	withRLSContext: async (_db: unknown, callback: (tx: unknown) => unknown) =>
		callback({
			user: m.user,
			project: m.project,
			member: m.member,
			deliverySignalWatch: m.watch,
			deliverySignalSourceGrant: m.grant,
			deliverySignalSourceCommand: m.command,
			deliverySignalCapturePage: m.page,
			deliverySignalObservation: m.observation,
			workflowIntegration: m.integration,
			$queryRaw: m.raw,
			$executeRaw: m.raw,
		}),
}));
vi.mock("../prisma/queries/projects/projects", () => ({
	hasProjectAccess: m.visible,
	resolveProjectAccess: m.access,
	canEditProject: m.canEdit,
}));
vi.mock("../prisma/queries/audit-log", () => ({ recordAuditTx: m.audit }));

import {
	type CommitDeliverySourceCapturePageInput,
	changeDeliverySourceWatchState,
	commitDeliverySourceCapturePage,
	getDeliverySourcePageReceipt,
	getOwnedDeliverySlackIntegration,
	listOwnedDeliverySourceObservations,
	prepareDeliverySourceCaptureCommand,
} from "../prisma/queries/delivery-source-capture";

const scope = {
	organizationId: "example-org",
	projectId: "example-project",
	userId: "example-user",
};
const now = new Date("2026-11-07T10:00:00.000Z");
const proof = {
	installationId: "TEXAMPLE01",
	containerId: "CEXAMPLE01",
	humanUserId: "UEXAMPLE01",
	botId: "BEXAMPLE01",
	botUserId: "UEXAMPLE02",
	adapterVersion: "slack-root-v1",
	label: "#example",
	verifiedAt: now,
};
const watch = {
	id: "example-watch",
	...scope,
	integrationId: "example-integration",
	provider: "SLACK",
	...proof,
	version: 2,
	grantRevision: 1,
	state: "ACTIVE",
	retentionDays: 7,
	captureCheckpointVersion: 3,
	captureWindowStart: null,
	captureWindowEnd: null,
	captureCursorCiphertext: null,
	captureComplete: false,
	captureGrantRevision: null,
	lastRequestId: null,
	lastWorkflowId: "example-workflow",
};
const grant = {
	id: "example-grant",
	watchId: watch.id,
	...scope,
	...proof,
	revision: 1,
	audience: "ONLY_ME",
	revokedAt: null,
};
const encrypted = `${"a".repeat(64)}:${"b".repeat(32)}:${"c".repeat(32)}:dd`;
const digest = "e".repeat(64);
const receiptKey = "f".repeat(64);
const page = (): CommitDeliverySourceCapturePageInput => ({
	watchId: watch.id,
	workflowId: "example-workflow",
	pageIndex: 0,
	configVersion: 2,
	grantRevision: 1,
	expectedCheckpointVersion: 3,
	expectedCredentialDigest: createHash("sha256")
		.update(encrypted)
		.digest("hex"),
	expectedIntegrationUpdatedAt: now,
	windowStart: new Date(now.getTime() - 86_400_000),
	windowEnd: now,
	cursorCiphertext: null,
	complete: true,
	coverage: "ROOT_MESSAGES_ONLY",
	observations: [
		{
			id: "example-observation",
			externalItemId: "1794000000.000001",
			revisionKind: "DECIMAL",
			revisionValue: "1794000000.000001",
			receiptKey,
			variantKey: createHash("sha256")
				.update(JSON.stringify([1, receiptKey, "UPSERT", digest]))
				.digest("hex"),
			evidenceDigest: digest,
			ciphertext: encrypted,
			occurredAt: new Date(now.getTime() - 1000),
			expiresAt: new Date(now.getTime() + 7 * 86_400_000),
			hasReplies: true,
		},
	],
	result: { captured: 1, hasMore: false, coverage: "ROOT_MESSAGES_ONLY" },
});
beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(now);
	m.user.findUnique.mockResolvedValue({ banned: false, banExpires: null });
	m.project.findFirst.mockResolvedValue({
		id: scope.projectId,
		organization: { deletedAt: null },
	});
	m.member.findUnique.mockResolvedValue({ role: "owner" });
	m.access.mockResolvedValue({
		organizationId: scope.organizationId,
		permissions: Object.values(Permissions),
	});
	m.visible.mockResolvedValue(true);
	m.canEdit.mockResolvedValue(true);
	m.watch.findFirst.mockResolvedValue({ ...watch });
	m.watch.update.mockResolvedValue({ ...watch, version: 3 });
	m.grant.findFirst.mockResolvedValue({ ...grant });
	m.integration.findFirst.mockResolvedValue({
		id: "example-integration",
		credentials: encrypted,
		updatedAt: now,
	});
	m.observation.createMany.mockResolvedValue({ count: 1 });
	m.page.findFirst.mockResolvedValue(null);
	m.command.findFirst.mockResolvedValue(null);
	m.command.create.mockImplementation(async ({ data }) => ({
		...data,
		id: "example-command",
		createdAt: now,
	}));
	m.observation.findMany.mockResolvedValue([]);
	m.observation.groupBy.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe("owner-private capture persistence", () => {
	it("rejects blank/null tenant identities before issuing any query", async () => {
		await expect(
			Promise.resolve().then(() =>
				getOwnedDeliverySlackIntegration(
					{ ...scope, organizationId: " " },
					"example-integration",
				),
			),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		expect(m.project.findFirst).not.toHaveBeenCalled();
	});
	it("stops a banned actor even while current member/project rows remain", async () => {
		m.user.findUnique.mockResolvedValue({ banned: true, banExpires: null });
		await expect(
			getOwnedDeliverySlackIntegration(scope, "example-integration"),
		).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION" });
		expect(m.integration.findFirst).not.toHaveBeenCalled();
	});

	it("does not substitute org ownership for project visibility", async () => {
		m.visible.mockResolvedValue(false);
		await expect(
			getOwnedDeliverySlackIntegration(scope, "example-integration"),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.integration.findFirst).not.toHaveBeenCalled();
	});
	it("refuses a project guest without a live organization member row", async () => {
		m.member.findUnique.mockResolvedValue(null);
		await expect(
			getOwnedDeliverySlackIntegration(scope, "example-integration"),
		).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION" });
	});
	it("checks effective project permissions even for a current org owner", async () => {
		m.access.mockResolvedValue({
			organizationId: scope.organizationId,
			permissions: [],
		});
		await expect(
			getOwnedDeliverySlackIntegration(scope, "example-integration"),
		).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION" });
	});
	it("uses canEditProject as well as direct write permissions", async () => {
		m.canEdit.mockResolvedValue(false);
		await expect(
			changeDeliverySourceWatchState(scope, {
				watchId: watch.id,
				expectedVersion: 2,
				requestId: "11111111-1111-4111-8111-111111111111",
				payloadHash: digest,
				action: "PAUSE",
			}),
		).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION" });
		expect(m.watch.update).not.toHaveBeenCalled();
	});
	it("restricts credentials to exact owner/org, standalone active Slack and excludes OAuth app registrations", async () => {
		await getOwnedDeliverySlackIntegration(scope, "example-integration");
		expect(m.integration.findFirst.mock.calls[0][0].where).toEqual({
			id: "example-integration",
			organizationId: scope.organizationId,
			userId: scope.userId,
			provider: "SLACK",
			isActive: true,
			workflowId: null,
			name: { not: "SLACK_OAUTH_APP" },
		});
	});
	it("commits variants, receipt and checkpoint together under the scoped watch lock", async () => {
		const input = page();
		await expect(
			commitDeliverySourceCapturePage(scope, input),
		).resolves.toEqual(input.result);
		expect(m.raw).toHaveBeenCalled();
		expect(m.observation.createMany.mock.calls[0][0]).toMatchObject({
			skipDuplicates: true,
			data: [
				{
					...scope,
					watchId: watch.id,
					grantId: grant.id,
					ciphertext: encrypted,
					variantKey: input.observations[0].variantKey,
				},
			],
		});
		expect(m.watch.update.mock.calls[0][0].data).toMatchObject({
			captureCheckpointVersion: { increment: 1 },
			captureComplete: true,
			captureCursorCiphertext: null,
		});
		expect(m.page.create.mock.calls[0][0].data).toMatchObject({
			...scope,
			watchId: watch.id,
			workflowId: input.workflowId,
			pageIndex: 0,
			result: input.result,
		});
	});
	it("returns the committed effect receipt rather than advancing the next page on retry", async () => {
		m.watch.findFirst.mockResolvedValue({
			...watch,
			captureCheckpointVersion: 99,
		});
		m.page.findFirst.mockResolvedValue({
			result: { captured: 17, hasMore: true, coverage: "PARTIAL" },
		});
		await expect(
			commitDeliverySourceCapturePage(scope, page()),
		).resolves.toEqual({
			captured: 17,
			hasMore: true,
			coverage: "PARTIAL",
		});
		expect(m.observation.createMany).not.toHaveBeenCalled();
		expect(m.watch.update).not.toHaveBeenCalled();
	});
	it("fences stale checkpoint and revoked source-grant writes before storing evidence", async () => {
		await expect(
			commitDeliverySourceCapturePage(scope, {
				...page(),
				expectedCheckpointVersion: 1,
			}),
		).rejects.toMatchObject({ code: "CAPTURE_CONFLICT" });
		expect(m.observation.createMany).not.toHaveBeenCalled();
		m.grant.findFirst.mockResolvedValue(null);
		await expect(
			commitDeliverySourceCapturePage(scope, page()),
		).rejects.toMatchObject({ code: "CONFIGURATION_CHANGED" });
	});
	it("rejects plaintext, forged variant keys, excessive pages and expired payloads", async () => {
		const input = page();
		for (const invalid of [
			{ ...input, pageIndex: 5 },
			{
				...input,
				observations: [
					{
						...input.observations[0],
						ciphertext: "plaintext message",
					},
				],
			},
			{
				...input,
				observations: [
					{ ...input.observations[0], variantKey: digest },
				],
			},
			{
				...input,
				observations: [{ ...input.observations[0], expiresAt: now }],
			},
		]) {
			await expect(
				Promise.resolve().then(() =>
					commitDeliverySourceCapturePage(scope, invalid),
				),
			).rejects.toMatchObject({ code: "INVALID_INPUT" });
		}
		expect(m.observation.createMany).not.toHaveBeenCalled();
	});
	it("counts only newly inserted immutable variants and pins that count in the effect receipt", async () => {
		m.observation.createMany.mockResolvedValue({ count: 0 });
		await expect(
			commitDeliverySourceCapturePage(scope, page()),
		).resolves.toMatchObject({ captured: 0 });
		expect(m.page.create.mock.calls[0][0].data.result.captured).toBe(0);
	});
	it("refuses a replaced or reconfigured credential before any evidence/checkpoint write", async () => {
		for (const integration of [
			{
				id: "example-integration",
				credentials: `${encrypted}ff`,
				updatedAt: now,
			},
			{
				id: "example-integration",
				credentials: encrypted,
				updatedAt: new Date(now.getTime() + 1),
			},
		]) {
			m.integration.findFirst.mockResolvedValue(integration);
			await expect(
				commitDeliverySourceCapturePage(scope, page()),
			).rejects.toMatchObject({ code: "CONFIGURATION_CHANGED" });
		}
		expect(m.observation.createMany).not.toHaveBeenCalled();
		expect(m.watch.update).not.toHaveBeenCalled();
	});

	it("keeps source scope and expiry in the cursor anchor and metadata query", async () => {
		m.observation.findFirst.mockResolvedValue({ id: "example-anchor" });
		await listOwnedDeliverySourceObservations(scope, {
			watchId: watch.id,
			limit: 20,
			cursor: { id: "example-anchor", capturedAt: now },
		});
		expect(m.observation.findFirst.mock.calls[0][0].where).toMatchObject({
			...scope,
			watchId: watch.id,
			grantId: grant.id,
			expiresAt: { gt: now },
			ciphertext: { not: null },
			id: "example-anchor",
			createdAt: now,
		});
		expect(m.observation.findMany.mock.calls[0][0]).toMatchObject({
			take: 21,
			select: {
				id: true,
				createdAt: true,
				expiresAt: true,
				receiptKey: true,
			},
		});
	});
	it("replays original capture intent without changing timestamps or re-admitting a workflow", async () => {
		const input = {
			watchId: watch.id,
			requestId: "11111111-1111-4111-8111-111111111111",
			payloadHash: digest,
			workflowId: "example-workflow",
			expectedVersion: 2,
			mode: "RECENT" as const,
			expectedLastRequestId: null,
		};
		const receipt = {
			...scope,
			...input,
			expectedVersion: 2,
			captureMode: "RECENT",
			operation: "CAPTURE",
			createdAt: new Date(now.getTime() - 1000),
		};
		m.command.findFirst.mockResolvedValue(receipt);
		const result = await prepareDeliverySourceCaptureCommand(scope, input);
		expect(result).toMatchObject({
			mayDispatch: false,
			receipt: { createdAt: receipt.createdAt },
		});
		expect(m.command.create).not.toHaveBeenCalled();
		expect(m.watch.update).not.toHaveBeenCalled();
	});
	it("CAS-refuses a competing new capture request and does not bump configuration version on admission", async () => {
		const input = {
			watchId: watch.id,
			requestId: "11111111-1111-4111-8111-111111111111",
			payloadHash: digest,
			workflowId: "example-new-workflow",
			expectedVersion: 2,
			mode: "RECENT" as const,
			expectedLastRequestId: "example-old",
		};
		await expect(
			prepareDeliverySourceCaptureCommand(scope, input),
		).rejects.toMatchObject({ code: "CAPTURE_CONFLICT" });
		await prepareDeliverySourceCaptureCommand(scope, {
			...input,
			expectedLastRequestId: null,
		});
		expect(m.watch.update.mock.calls[0][0].data).not.toHaveProperty(
			"version",
		);
		expect(m.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "project.delivery_source.capture_requested",
				metadata: { version: 2, grantRevision: 1, mode: "RECENT" },
			}),
		);
	});
	it("an effect receipt remains private to a current non-revoked source grant", async () => {
		m.grant.findFirst.mockResolvedValue(null);
		await expect(
			getDeliverySourcePageReceipt(scope, {
				watchId: watch.id,
				workflowId: "example-workflow",
				pageIndex: 0,
			}),
		).rejects.toMatchObject({ code: "CONFIGURATION_CHANGED" });
		expect(m.page.findFirst).not.toHaveBeenCalled();
	});
});

describe("selected history persistence", () => {
	const window = {
		start: "2026-10-05T00:00:00.000Z",
		end: "2026-10-07T00:00:00.000Z",
	};
	const intent = {
		watchId: watch.id,
		requestId: "11111111-1111-4111-8111-111111111111",
		expectedVersion: watch.version,
		mode: "BACKFILL" as const,
		window,
		payloadHash: "a".repeat(64),
		workflowId: "example-history-workflow",
		expectedLastRequestId: null,
	};
	it("stores immutable selected dates and clears a previous checkpoint", async () => {
		await prepareDeliverySourceCaptureCommand(scope, intent);
		expect(m.command.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					captureMode: "BACKFILL",
					captureWindowStart: new Date(window.start),
					captureWindowEnd: new Date(window.end),
				}),
			}),
		);
		expect(m.watch.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					captureWindowStart: null,
					captureCursorCiphertext: null,
				}),
			}),
		);
	});
	it("refuses a history page that differs from admitted dates", async () => {
		m.command.findFirst.mockImplementation(async ({ where }) =>
			where.operation === "CAPTURE"
				? {
						captureMode: "BACKFILL",
						captureWindowStart: new Date(window.start),
						captureWindowEnd: new Date(window.end),
					}
				: null,
		);
		await expect(
			commitDeliverySourceCapturePage(scope, page()),
		).rejects.toMatchObject({ code: "CONFIGURATION_CHANGED" });
		expect(m.observation.createMany).not.toHaveBeenCalled();
	});
	it.each([
		undefined,
		{ start: window.end, end: window.start },
		{ start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z" },
	])("refuses invalid or too old history windows", async (selected) => {
		await expect(async () =>
			prepareDeliverySourceCaptureCommand(scope, {
				...intent,
				window: selected,
			}),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		expect(m.command.create).not.toHaveBeenCalled();
	});
});
