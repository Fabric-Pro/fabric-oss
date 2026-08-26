/**
 * Tests for ComponentIncident query helpers.
 *
 * Coverage:
 *   - listComponentIncidents: filter forwarding (status / severity / componentKey),
 *     cursor pagination shape.
 *   - upsertComponentIncident: idempotent — existing FIRING incident is reused
 *     without creating a duplicate; severity escalation updates the existing row;
 *     net-new fingerprint creates a new row + FIRED IncidentEvent.
 *   - closeComponentIncident: idempotent — already-RESOLVED returns existing row;
 *     auto-resolve and manual-resolve write different IncidentEvent types.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const componentFindManyMock = vi.fn();
const componentFindFirstMock = vi.fn();
const componentFindUniqueMock = vi.fn();
const componentCreateMock = vi.fn();
const componentUpdateMock = vi.fn();
const eventCreateMock = vi.fn();
const txMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		componentIncident: {
			findMany: (args: unknown) => componentFindManyMock(args),
			findFirst: (args: unknown) => componentFindFirstMock(args),
			findUnique: (args: unknown) => componentFindUniqueMock(args),
			create: (args: unknown) => componentCreateMock(args),
			update: (args: unknown) => componentUpdateMock(args),
		},
		incidentEvent: {
			create: (args: unknown) => eventCreateMock(args),
		},
		$transaction: (fn: unknown) => txMock(fn),
	},
}));

import {
	closeComponentIncident,
	listComponentIncidents,
	upsertComponentIncident,
} from "../prisma/queries/component-incidents";

beforeEach(() => {
	componentFindManyMock.mockReset();
	componentFindFirstMock.mockReset();
	componentFindUniqueMock.mockReset();
	componentCreateMock.mockReset();
	componentUpdateMock.mockReset();
	eventCreateMock.mockReset();
	txMock.mockReset();

	componentFindManyMock.mockResolvedValue([]);
	componentFindFirstMock.mockResolvedValue(null);
	componentFindUniqueMock.mockResolvedValue(null);
	componentCreateMock.mockResolvedValue({
		id: "ci-new-1",
		status: "FIRING",
		severity: "SEV2",
	});
	eventCreateMock.mockResolvedValue({ id: "ev-1" });
	// Default $transaction implementation: just run the callback with the
	// same `tx` shape as `db`.
	txMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
		fn({
			componentIncident: {
				findUnique: (args: unknown) => componentFindUniqueMock(args),
				update: (args: unknown) => componentUpdateMock(args),
			},
			incidentEvent: {
				create: (args: unknown) => eventCreateMock(args),
			},
		}),
	);
});

describe("listComponentIncidents — filtering + pagination", () => {
	it("forwards status / severity / componentKey filters to the where clause", async () => {
		await listComponentIncidents({
			status: "FIRING",
			severity: "SEV1",
			componentKey: "temporal-worker",
		});

		const args = componentFindManyMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
		};
		expect(args.where).toMatchObject({
			status: "FIRING",
			severity: "SEV1",
			componentKey: "temporal-worker",
		});
	});

	it("returns paginated shape with nextCursor", async () => {
		componentFindManyMock.mockResolvedValueOnce([
			{ id: "ci-1" },
			{ id: "ci-2" },
		]);
		const result = await listComponentIncidents({ limit: 1 });
		expect(result.items).toHaveLength(1);
		expect(result.nextCursor).toBe("ci-1");
	});
});

describe("upsertComponentIncident — idempotency", () => {
	it("reuses an existing FIRING incident for the same componentKey", async () => {
		componentFindFirstMock.mockResolvedValue({
			id: "ci-existing",
			status: "FIRING",
			severity: "SEV2",
		});

		const result = await upsertComponentIncident({
			componentKey: "temporal-worker",
			componentName: "Temporal Worker",
			severity: "SEV2",
			summary: "stall",
		});

		expect(result).toEqual({
			incidentId: "ci-existing",
			wasNew: false,
		});
		expect(componentCreateMock).not.toHaveBeenCalled();
	});

	it("escalates severity when the new fire is higher (SEV-1) than the existing row (SEV-2)", async () => {
		componentFindFirstMock.mockResolvedValue({
			id: "ci-existing",
			status: "FIRING",
			severity: "SEV2",
		});

		await upsertComponentIncident({
			componentKey: "temporal-worker",
			componentName: "Temporal Worker",
			severity: "SEV1",
			summary: "escalated",
		});

		expect(componentUpdateMock).toHaveBeenCalledWith({
			where: { id: "ci-existing" },
			data: { severity: "SEV1", summary: "escalated" },
		});
	});

	it("does NOT downgrade severity when the new fire is lower (SEV-3) than existing (SEV-2)", async () => {
		componentFindFirstMock.mockResolvedValue({
			id: "ci-existing",
			status: "FIRING",
			severity: "SEV2",
		});

		await upsertComponentIncident({
			componentKey: "temporal-worker",
			componentName: "Temporal Worker",
			severity: "SEV3",
			summary: "lower",
		});

		expect(componentUpdateMock).not.toHaveBeenCalled();
	});

	it("creates a new incident + FIRED event when no active incident matches", async () => {
		componentFindFirstMock.mockResolvedValue(null);
		componentCreateMock.mockResolvedValue({ id: "ci-new" });

		const result = await upsertComponentIncident({
			componentKey: "rag-indexer",
			componentName: "RAG Indexer",
			severity: "SEV2",
			summary: "queue backed up",
		});

		expect(result).toEqual({ incidentId: "ci-new", wasNew: true });
		expect(eventCreateMock).toHaveBeenCalledWith({
			data: {
				componentIncidentId: "ci-new",
				eventType: "FIRED",
			},
		});
	});

	it("resolves an existing incident by fingerprint when one is FIRING", async () => {
		componentFindUniqueMock.mockResolvedValue({
			id: "ci-by-fingerprint",
			status: "FIRING",
			severity: "SEV2",
		});

		const result = await upsertComponentIncident({
			componentKey: "temporal-worker",
			componentName: "Temporal Worker",
			severity: "SEV2",
			alertmanagerFingerprint: "fp-1",
		});

		expect(result.incidentId).toBe("ci-by-fingerprint");
		expect(result.wasNew).toBe(false);
		expect(componentCreateMock).not.toHaveBeenCalled();
	});
});

describe("closeComponentIncident — lifecycle", () => {
	it("is a no-op when the incident is already RESOLVED", async () => {
		componentFindUniqueMock.mockResolvedValue({
			id: "ci-1",
			status: "RESOLVED",
		});
		const result = await closeComponentIncident({ incidentId: "ci-1" });
		expect(result).toMatchObject({ status: "RESOLVED" });
		expect(componentUpdateMock).not.toHaveBeenCalled();
		expect(eventCreateMock).not.toHaveBeenCalled();
	});

	it("writes AUTO_RESOLVED event when autoResolved=true", async () => {
		componentFindUniqueMock.mockResolvedValue({
			id: "ci-1",
			status: "FIRING",
		});
		componentUpdateMock.mockResolvedValue({
			id: "ci-1",
			status: "RESOLVED",
		});

		await closeComponentIncident({
			incidentId: "ci-1",
			autoResolved: true,
		});

		expect(eventCreateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					componentIncidentId: "ci-1",
					eventType: "AUTO_RESOLVED",
				}),
			}),
		);
	});

	it("writes MANUAL_RESOLVED event when autoResolved=false (default)", async () => {
		componentFindUniqueMock.mockResolvedValue({
			id: "ci-1",
			status: "FIRING",
		});
		componentUpdateMock.mockResolvedValue({
			id: "ci-1",
			status: "RESOLVED",
		});

		await closeComponentIncident({
			incidentId: "ci-1",
			actorUserId: "u-1",
		});

		expect(eventCreateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					componentIncidentId: "ci-1",
					eventType: "MANUAL_RESOLVED",
					actorUserId: "u-1",
				}),
			}),
		);
	});
});
