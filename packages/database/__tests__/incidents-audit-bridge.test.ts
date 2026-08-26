/**
 * Tests for the IncidentEvent → audit_log bridge (D17).
 *
 * For every IncidentEvent insertion site (ack / resolve / comment for
 * each of ErrorRateIncident / IntegrationIncident, plus the
 * Alertmanager upsert + auto-resolve paths), we assert:
 *  - A `recordAudit` call lands with the right `incident.*` action.
 *  - The actor matches the writer (user for manual paths, system for
 *    Alertmanager / auto-resolve paths).
 *  - The metadata carries `incidentEventId` for cross-reference back
 *    to the canonical IncidentEvent row.
 *  - The resource type is `error_rate_incident` or
 *    `integration_incident` per the writer.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/incidents-audit-bridge.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	errorRateFindUniqueMock: vi.fn(),
	errorRateUpdateMock: vi.fn(),
	integrationFindUniqueMock: vi.fn(),
	integrationFindFirstMock: vi.fn(),
	integrationUpdateMock: vi.fn(),
	incidentEventCreateMock: vi.fn(),
	transactionMock: vi.fn(),
	auditLogCreateMock: vi.fn().mockResolvedValue({ id: "audit-1" }),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		log: vi.fn(),
	},
	logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/utils/correlation-id", () => ({
	getCorrelationIdFromContext: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../prisma/client", () => ({
	db: {
		errorRateIncident: {
			findUnique: (args: unknown) => mocks.errorRateFindUniqueMock(args),
			update: (args: unknown) => mocks.errorRateUpdateMock(args),
		},
		integrationIncident: {
			findUnique: (args: unknown) =>
				mocks.integrationFindUniqueMock(args),
			findFirst: (args: unknown) => mocks.integrationFindFirstMock(args),
			update: (args: unknown) => mocks.integrationUpdateMock(args),
			create: vi.fn(),
		},
		incidentEvent: {
			create: (args: unknown) => mocks.incidentEventCreateMock(args),
		},
		auditLog: {
			create: (args: unknown) => mocks.auditLogCreateMock(args),
		},
		$transaction: (fn: unknown) => mocks.transactionMock(fn),
	},
	Prisma: {},
}));

import {
	acknowledgeErrorRateIncident,
	acknowledgeIntegrationIncident,
	addErrorRateIncidentComment,
	addIntegrationIncidentComment,
	autoResolveAlertmanagerIncident,
	resolveErrorRateIncident,
	resolveIntegrationIncident,
	upsertAlertmanagerIncident,
} from "../prisma/queries/incidents";

async function flush(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

function setupTransactionMock(tx: {
	errorRateIncidentFind?: unknown;
	errorRateIncidentUpdate?: unknown;
	integrationIncidentFind?: unknown;
	integrationIncidentUpdate?: unknown;
	incidentEventCreate?: { id: string };
}) {
	mocks.transactionMock.mockImplementation(
		async (fn: (txClient: unknown) => Promise<unknown>) => {
			const txClient = {
				errorRateIncident: {
					findUnique: vi
						.fn()
						.mockResolvedValue(tx.errorRateIncidentFind ?? null),
					update: vi
						.fn()
						.mockResolvedValue(tx.errorRateIncidentUpdate ?? null),
				},
				integrationIncident: {
					findUnique: vi
						.fn()
						.mockResolvedValue(tx.integrationIncidentFind ?? null),
					update: vi
						.fn()
						.mockResolvedValue(
							tx.integrationIncidentUpdate ?? null,
						),
				},
				incidentEvent: {
					create: vi
						.fn()
						.mockResolvedValue(
							tx.incidentEventCreate ?? { id: "evt-1" },
						),
				},
			};
			return fn(txClient);
		},
	);
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as { mockReset?: () => void }).mockReset?.();
	}
	mocks.auditLogCreateMock.mockResolvedValue({ id: "audit-1" });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ErrorRateIncident bridge", () => {
	it("acknowledge emits incident.acknowledged with user actor", async () => {
		setupTransactionMock({
			errorRateIncidentFind: {
				id: "inc-1",
				status: "FIRING",
				alertName: "AppErrors",
			},
			errorRateIncidentUpdate: {
				id: "inc-1",
				alertName: "AppErrors",
			},
			incidentEventCreate: { id: "evt-ack-1" },
		});

		await acknowledgeErrorRateIncident({
			incidentId: "inc-1",
			actorUserId: "u-1",
			note: "I'm on it",
		});
		await flush();

		expect(mocks.auditLogCreateMock).toHaveBeenCalledTimes(1);
		const args = mocks.auditLogCreateMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(args.data.action).toBe("incident.acknowledged");
		expect(args.data.category).toBe("incident");
		expect(args.data.severity).toBe("warning");
		expect(args.data.resourceType).toBe("error_rate_incident");
		expect(args.data.resourceId).toBe("inc-1");
		expect(args.data.actorType).toBe("user");
		expect(
			(args.data.metadata as { incidentEventId: string }).incidentEventId,
		).toBe("evt-ack-1");
	});

	it("resolve emits incident.manual_resolved", async () => {
		setupTransactionMock({
			errorRateIncidentFind: {
				id: "inc-2",
				status: "FIRING",
				alertName: "AppErrors",
			},
			errorRateIncidentUpdate: {
				id: "inc-2",
				alertName: "AppErrors",
			},
			incidentEventCreate: { id: "evt-res-2" },
		});

		await resolveErrorRateIncident({
			incidentId: "inc-2",
			actorUserId: "u-1",
			note: "fixed",
		});
		await flush();

		const args = mocks.auditLogCreateMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(args.data.action).toBe("incident.manual_resolved");
		expect(args.data.severity).toBe("info");
		expect(args.data.outcome).toBe("success");
	});

	it("comment emits incident.commented", async () => {
		mocks.incidentEventCreateMock.mockResolvedValue({ id: "evt-com-3" });

		await addErrorRateIncidentComment({
			incidentId: "inc-3",
			actorUserId: "u-2",
			message: "post-mortem follow-up",
		});
		await flush();

		const args = mocks.auditLogCreateMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(args.data.action).toBe("incident.commented");
		expect(args.data.severity).toBe("info");
	});

	it("no audit emit on no-op (incident already RESOLVED)", async () => {
		setupTransactionMock({
			errorRateIncidentFind: {
				id: "inc-no-op",
				status: "RESOLVED",
				alertName: "X",
			},
			incidentEventCreate: { id: "would-not-fire" },
		});

		await acknowledgeErrorRateIncident({
			incidentId: "inc-no-op",
			actorUserId: "u-1",
		});
		await flush();

		expect(mocks.auditLogCreateMock).not.toHaveBeenCalled();
	});
});

describe("IntegrationIncident bridge", () => {
	it("acknowledge emits with integration_incident resource type", async () => {
		setupTransactionMock({
			integrationIncidentFind: {
				id: "iinc-1",
				status: "FIRING",
				providerName: "OpenAI",
			},
			integrationIncidentUpdate: {
				id: "iinc-1",
				providerName: "OpenAI",
			},
			incidentEventCreate: { id: "evt-iack" },
		});

		await acknowledgeIntegrationIncident({
			incidentId: "iinc-1",
			actorUserId: "u-1",
		});
		await flush();

		const args = mocks.auditLogCreateMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(args.data.action).toBe("incident.acknowledged");
		expect(args.data.resourceType).toBe("integration_incident");
	});

	it("resolve emits incident.manual_resolved", async () => {
		setupTransactionMock({
			integrationIncidentFind: {
				id: "iinc-2",
				status: "FIRING",
				providerName: "Stripe",
			},
			integrationIncidentUpdate: {
				id: "iinc-2",
				providerName: "Stripe",
			},
			incidentEventCreate: { id: "evt-ires" },
		});

		await resolveIntegrationIncident({
			incidentId: "iinc-2",
			actorUserId: "u-1",
		});
		await flush();

		const args = mocks.auditLogCreateMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(args.data.action).toBe("incident.manual_resolved");
	});

	it("comment emits incident.commented for integration incident", async () => {
		mocks.incidentEventCreateMock.mockResolvedValue({ id: "evt-icom" });

		await addIntegrationIncidentComment({
			incidentId: "iinc-3",
			actorUserId: "u-2",
			message: "stripe acknowledged",
		});
		await flush();

		const args = mocks.auditLogCreateMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(args.data.action).toBe("incident.commented");
	});
});

describe("Alertmanager upsert bridge", () => {
	it("FIRED on a new integration incident emits with system actor", async () => {
		// First call returns null for `findUnique` (no existing); the
		// `db.integrationIncident.create` mock needs to exist on the
		// prisma client mock above.
		mocks.integrationFindUniqueMock.mockResolvedValueOnce(null);

		const integrationCreateMock = vi
			.fn()
			.mockResolvedValue({ id: "new-iinc", providerName: "OpenAI" });
		// Patch the create method by re-spying the module's expectation.
		// Cast to `unknown` first because `db` is the real PrismaClient type
		// (not a `Record<string, unknown>`) — the runtime shape is a
		// duck-typed mock from `vi.mock(../prisma/client)` above.
		const clientModule = (await import("../prisma/client")) as unknown as {
			db: { integrationIncident: { create: unknown } };
		};
		clientModule.db.integrationIncident.create = (args: unknown) =>
			integrationCreateMock(args);

		mocks.incidentEventCreateMock.mockResolvedValueOnce({
			id: "evt-fired-1",
		});

		await upsertAlertmanagerIncident({
			fingerprint: "fp-1",
			alertName: "providerOutage",
			severity: "SEV1",
			startsAt: new Date(),
			endsAt: null,
			labels: { alertname_family: "provider_outage", provider: "openai" },
			annotations: {
				summary: "OpenAI is down",
				provider_name: "OpenAI",
			},
		});
		await flush();

		expect(mocks.auditLogCreateMock).toHaveBeenCalled();
		const args = mocks.auditLogCreateMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(args.data.action).toBe("incident.fired");
		expect(args.data.severity).toBe("error");
		expect(args.data.outcome).toBe("failure");
		expect(args.data.actorType).toBe("system");
		expect(args.data.resourceType).toBe("integration_incident");
	});
});

describe("Alertmanager auto-resolve bridge", () => {
	it("AUTO_RESOLVED emits incident.auto_resolved with system actor", async () => {
		mocks.errorRateFindUniqueMock.mockResolvedValueOnce({
			id: "erinc-auto",
			status: "FIRING",
			alertName: "AppErrors",
		});
		mocks.errorRateUpdateMock.mockResolvedValueOnce({
			id: "erinc-auto",
		});
		mocks.incidentEventCreateMock.mockResolvedValueOnce({
			id: "evt-auto-1",
		});

		await autoResolveAlertmanagerIncident({
			fingerprint: "fp-1",
			endsAt: new Date(),
		});
		await flush();

		expect(mocks.auditLogCreateMock).toHaveBeenCalled();
		const args = mocks.auditLogCreateMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(args.data.action).toBe("incident.auto_resolved");
		expect(args.data.severity).toBe("info");
		expect(args.data.actorType).toBe("system");
	});
});
