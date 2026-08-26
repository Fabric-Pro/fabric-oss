import { beforeEach, describe, expect, it, vi } from "vitest";

const tiCreate = vi.fn();
const tiUpdate = vi.fn();
const tiUpdateMany = vi.fn();
const tiFindMany = vi.fn();
const tiFindUnique = vi.fn(); // NEW
const tiAggregate = vi.fn(); // NEW
const tieFindFirst = vi.fn();
const rtUpdate = vi.fn();

type MockDb = {
	templateInstance: {
		create: (...a: unknown[]) => unknown;
		update: (...a: unknown[]) => unknown;
		updateMany: (...a: unknown[]) => unknown;
		findMany: (...a: unknown[]) => unknown;
		findUnique: (...a: unknown[]) => unknown;
		aggregate: (...a: unknown[]) => unknown;
	};
	templateInstanceExecution: { findFirst: (...a: unknown[]) => unknown };
	reportTemplate: { update: (...a: unknown[]) => unknown };
	$transaction: (fn: (tx: MockDb) => unknown) => unknown;
};

vi.mock("../client", () => {
	const templateInstance = {
		create: (...a: unknown[]) => tiCreate(...a),
		update: (...a: unknown[]) => tiUpdate(...a),
		updateMany: (...a: unknown[]) => tiUpdateMany(...a),
		findMany: (...a: unknown[]) => tiFindMany(...a),
		findUnique: (...a: unknown[]) => tiFindUnique(...a),
		aggregate: (...a: unknown[]) => tiAggregate(...a),
	};
	const db: MockDb = {
		templateInstance,
		templateInstanceExecution: {
			findFirst: (...a: unknown[]) => tieFindFirst(...a),
		},
		reportTemplate: { update: (...a: unknown[]) => rtUpdate(...a) },
		// createNewVersion runs inside db.$transaction(async (tx) => …); pass the SAME mocks as tx.
		$transaction: (fn: (tx: MockDb) => unknown) => fn(db),
	};
	return { db };
});

import { Prisma } from "../generated/client";
import {
	claimAndAdvanceScheduledInstance,
	createTemplateInstance,
	findExecutionByWorkflowId,
	getInstanceScheduleMode,
	getScheduledInstances,
	listInstancesNeedingNextRunAt,
	listInstancesNeedingScheduleInheritance,
	restoreReportInstanceVersion,
	updateReportTemplate,
	updateTemplateInstance,
} from "./reports";

beforeEach(() => vi.clearAllMocks());

describe("claimAndAdvanceScheduledInstance (CAS)", () => {
	it("returns true when exactly one row matched the expected nextRunAt", async () => {
		tiUpdateMany.mockResolvedValue({ count: 1 });
		const due = new Date("2026-06-24T09:00:00Z");
		const next = new Date("2026-06-25T09:00:00Z");
		await expect(
			claimAndAdvanceScheduledInstance("i1", due, next),
		).resolves.toBe(true);
		expect(tiUpdateMany).toHaveBeenCalledWith({
			where: { id: "i1", nextRunAt: due },
			data: { nextRunAt: next },
		});
	});

	it("returns false when the expected nextRunAt no longer matches (concurrent edit)", async () => {
		tiUpdateMany.mockResolvedValue({ count: 0 });
		await expect(
			claimAndAdvanceScheduledInstance("i1", new Date(), new Date()),
		).resolves.toBe(false);
	});
});

describe("findExecutionByWorkflowId", () => {
	it("queries by workflowId", async () => {
		tieFindFirst.mockResolvedValue({
			id: "e1",
			instanceId: "i1",
			status: "PENDING",
		});
		const r = await findExecutionByWorkflowId("scheduled-report-i1-123");
		expect(r?.id).toBe("e1");
		expect(tieFindFirst).toHaveBeenCalledWith({
			where: { workflowId: "scheduled-report-i1-123" },
			select: { id: true, instanceId: true, status: true },
		});
	});
});

describe("createTemplateInstance scheduleMode", () => {
	it("stamps scheduleMode from the param (CUSTOM)", async () => {
		tiCreate.mockResolvedValue({ id: "i1" });
		await createTemplateInstance({
			templateId: "t1",
			userId: "u1",
			name: "X",
			connections: {},
			schedule: { frequency: "daily" } as never,
			scheduleMode: "CUSTOM",
		});
		const arg = tiCreate.mock.calls[0][0] as {
			data: { scheduleMode: string };
		};
		expect(arg.data.scheduleMode).toBe("CUSTOM");
	});
	it("defaults scheduleMode to INHERITED when omitted", async () => {
		tiCreate.mockResolvedValue({ id: "i1" });
		await createTemplateInstance({
			templateId: "t1",
			userId: "u1",
			name: "X",
			connections: {},
		});
		const arg = tiCreate.mock.calls[0][0] as {
			data: { scheduleMode: string };
		};
		expect(arg.data.scheduleMode).toBe("INHERITED");
	});
});

describe("createTemplateInstance schedule normalization", () => {
	it("normalizes a provided schedule and sets nextRunAt = anchorAt", async () => {
		tiCreate.mockResolvedValue({ id: "i1" });
		await createTemplateInstance({
			templateId: "t1",
			userId: "u1",
			organizationId: undefined,
			name: "X",
			connections: {},
			schedule: { frequency: "daily" } as never,
		});
		const arg = tiCreate.mock.calls[0][0] as {
			data: { schedule: { anchorAt: string }; nextRunAt: Date };
		};
		expect(arg.data.schedule).toMatchObject({
			frequency: "daily",
			anchorAt: expect.any(String),
		});
		expect(arg.data.nextRunAt).toEqual(
			new Date(arg.data.schedule.anchorAt),
		);
	});

	it("leaves nextRunAt unset when no schedule is provided", async () => {
		tiCreate.mockResolvedValue({ id: "i1" });
		await createTemplateInstance({
			templateId: "t1",
			userId: "u1",
			name: "X",
			connections: {},
		});
		const arg = tiCreate.mock.calls[0][0] as {
			data: { nextRunAt?: Date | null };
		};
		expect(arg.data.nextRunAt ?? null).toBeNull();
	});
});

describe("getScheduledInstances (Codex C1: only ACTIVE versions)", () => {
	it("filters on status ACTIVE so archived/superseded versions are never swept", async () => {
		tiFindMany.mockResolvedValue([]);
		const now = new Date("2026-06-24T09:00:00Z");
		await getScheduledInstances(now);
		const arg = tiFindMany.mock.calls[0][0] as {
			where: Record<string, unknown>;
		};
		expect(arg.where.status).toBe("ACTIVE");
		expect(arg.where.isActive).toBe(true);
		expect(arg.where.nextRunAt).toEqual({ lte: now });
		expect(arg.where.scheduleMode).toEqual({ not: "OFF" });
	});
});

describe("listInstancesNeedingNextRunAt (Part 2: OFF excluded)", () => {
	it("filters out OFF instances so a paused report's nextRunAt is never recomputed", async () => {
		tiFindMany.mockResolvedValue([]);
		await listInstancesNeedingNextRunAt(100);
		const arg = tiFindMany.mock.calls[0][0] as {
			where: Record<string, unknown>;
		};
		expect(arg.where.status).toBe("ACTIVE");
		expect(arg.where.isActive).toBe(true);
		expect(arg.where.nextRunAt).toBeNull();
		// dual exclusion of a paused report: a retain-on-OFF row
		// has a non-null schedule + null nextRunAt, so `schedule: {not: DbNull}` alone does NOT
		// exclude it — the `scheduleMode != OFF` predicate is load-bearing here.
		expect(arg.where.schedule).toEqual({ not: Prisma.DbNull });
		expect(arg.where.scheduleMode).toEqual({ not: "OFF" });
	});
});

describe("listInstancesNeedingScheduleInheritance (Part 2: INHERITED only)", () => {
	it("only re-seeds INHERITED instances and only when schedule is unset", async () => {
		tiFindMany.mockResolvedValue([]);
		await listInstancesNeedingScheduleInheritance(100);
		const arg = tiFindMany.mock.calls[0][0] as {
			where: Record<string, unknown>;
		};
		// A null-schedule OFF row matches `schedule equals DbNull` but is excluded by the
		// `scheduleMode: "INHERITED"` gate — this is the case that proves §6.3's gate is
		// load-bearing. A non-null-schedule INHERITED row is excluded here (schedule
		// not DbNull) and is instead handled by §6.2's backfill.
		expect(arg.where.schedule).toEqual({ equals: Prisma.DbNull });
		expect(arg.where.scheduleMode).toBe("INHERITED");
	});
});

describe("updateReportTemplate schedule clear (Codex P3)", () => {
	it("translates an explicit schedule:null to Prisma.DbNull (SQL NULL, not JSON null)", async () => {
		rtUpdate.mockResolvedValue({ id: "t1" });
		await updateReportTemplate({ id: "t1", schedule: null });
		const arg = rtUpdate.mock.calls[0][0] as {
			data: { schedule: unknown };
		};
		expect(arg.data.schedule).toBe(Prisma.DbNull);
	});

	it("leaves schedule untouched when the key is omitted", async () => {
		rtUpdate.mockResolvedValue({ id: "t1" });
		await updateReportTemplate({ id: "t1", name: "renamed" });
		const arg = rtUpdate.mock.calls[0][0] as {
			data: { schedule?: unknown };
		};
		expect("schedule" in arg.data).toBe(false);
	});
});

describe("listInstancesNeedingScheduleInheritance (owner-scoped, D3)", () => {
	it("inherits only from owner-owned templates and never from SYSTEM/public ones", async () => {
		tiFindMany.mockResolvedValue([
			// owner-owned USER template → inherit
			{
				id: "i1",
				userId: "u1",
				organizationId: null,
				template: {
					schedule: { frequency: "weekly" },
					scope: "USER",
					userId: "u1",
					organizationId: null,
				},
			},
			// public/SYSTEM template owned by someone else → must be excluded
			{
				id: "i2",
				userId: "u2",
				organizationId: null,
				template: {
					schedule: { frequency: "weekly" },
					scope: "SYSTEM",
					userId: null,
					organizationId: null,
				},
			},
			// USER template owned by a DIFFERENT user → excluded (cross-tenant)
			{
				id: "i3",
				userId: "u3",
				organizationId: null,
				template: {
					schedule: { frequency: "weekly" },
					scope: "USER",
					userId: "uX",
					organizationId: null,
				},
			},
			// ORG template matching the instance org → inherit
			{
				id: "i4",
				userId: "u4",
				organizationId: "o9",
				template: {
					schedule: { frequency: "weekly" },
					scope: "ORGANIZATION",
					userId: null,
					organizationId: "o9",
				},
			},
		]);
		const rows = await listInstancesNeedingScheduleInheritance(100);
		expect(rows.map((r) => r.id).sort()).toEqual(["i1", "i4"]);
	});
});

describe("updateTemplateInstance scheduleUpdate (Part 2)", () => {
	const current = {
		id: "i1",
		templateId: "t1",
		userId: "u1",
		organizationId: null,
		sId: "s1",
		version: 1,
		name: "X",
		description: null,
		heroEmojis: [],
		connections: {},
		parameterDefaults: null,
		fabricConfig: null,
		schedule: {
			frequency: "weekly",
			dayOfWeek: 1,
			hour: 9,
			minute: 0,
			timezone: "UTC",
			anchorAt: "2026-06-29T09:00:00.000Z",
		},
		nextRunAt: new Date("2026-06-29T09:00:00.000Z"),
		lastRunAt: null,
		isActive: true,
		scheduleMode: "CUSTOM",
		template: {
			schedule: { frequency: "daily" },
			scope: "USER",
			userId: "u1",
			organizationId: null,
		},
	};
	beforeEach(() => {
		tiFindUnique.mockResolvedValue(current);
		tiUpdate.mockResolvedValue({ ...current });
	});

	it("off: sets scheduleMode OFF, retains schedule, nulls nextRunAt", async () => {
		await updateTemplateInstance({
			id: "i1",
			scheduleUpdate: { mode: "off" },
		});
		const arg = tiUpdate.mock.calls[0][0] as {
			data: Record<string, unknown>;
		};
		expect(arg.data.scheduleMode).toBe("OFF");
		expect(arg.data.nextRunAt).toBeNull();
		expect("schedule" in arg.data).toBe(false); // retained, not rewritten
	});

	it("custom: normalizes the schedule, sets CUSTOM + nextRunAt = anchorAt", async () => {
		await updateTemplateInstance({
			id: "i1",
			scheduleUpdate: {
				mode: "custom",
				schedule: { frequency: "daily" },
			},
		});
		const arg = tiUpdate.mock.calls[0][0] as {
			data: {
				scheduleMode: string;
				schedule: { anchorAt: string };
				nextRunAt: Date;
			};
		};
		expect(arg.data.scheduleMode).toBe("CUSTOM");
		expect(arg.data.schedule).toMatchObject({
			frequency: "daily",
			anchorAt: expect.any(String),
		});
		expect(arg.data.nextRunAt).toEqual(
			new Date(arg.data.schedule.anchorAt),
		);
	});

	it("inherit: re-seeds from the owner-owned template, sets INHERITED", async () => {
		await updateTemplateInstance({
			id: "i1",
			scheduleUpdate: { mode: "inherit" },
		});
		const arg = tiUpdate.mock.calls[0][0] as {
			data: { scheduleMode: string; schedule: { frequency: string } };
		};
		expect(arg.data.scheduleMode).toBe("INHERITED");
		expect(arg.data.schedule).toMatchObject({ frequency: "daily" }); // from template
	});

	it("inherit from a cross-tenant/SYSTEM template yields DbNull + null nextRunAt", async () => {
		tiFindUnique.mockResolvedValue({
			...current,
			template: {
				schedule: { frequency: "daily" },
				scope: "SYSTEM",
				userId: null,
				organizationId: null,
			},
		});
		await updateTemplateInstance({
			id: "i1",
			scheduleUpdate: { mode: "inherit" },
		});
		const arg = tiUpdate.mock.calls[0][0] as {
			data: { schedule: unknown; nextRunAt: unknown };
		};
		expect(arg.data.schedule).toBe(Prisma.DbNull);
		expect(arg.data.nextRunAt).toBeNull();
	});

	it("omitted scheduleUpdate is a no-op (writes neither scheduleMode, schedule, nor nextRunAt)", async () => {
		await updateTemplateInstance({ id: "i1", name: "renamed" });
		const arg = tiUpdate.mock.calls[0][0] as {
			data: Record<string, unknown>;
		};
		expect("scheduleMode" in arg.data).toBe(false);
		expect("schedule" in arg.data).toBe(false);
		expect("nextRunAt" in arg.data).toBe(false);
	});

	it("createNewVersion clones scheduleMode when scheduleUpdate omitted", async () => {
		tiCreate.mockResolvedValue({ ...current, version: 2 });
		// updateTemplateInstance uses db.$transaction; mock it to invoke the callback with the tx = same mocked db
		await updateTemplateInstance({ id: "i1", createNewVersion: true });
		const arg = tiCreate.mock.calls.at(-1)?.[0] as {
			data: { scheduleMode: string };
		};
		expect(arg.data.scheduleMode).toBe("CUSTOM"); // cloned from current
	});

	it("createNewVersion + scheduleUpdate:off → new version is OFF, schedule retained, nextRunAt null", async () => {
		tiCreate.mockResolvedValue({ ...current, version: 2 });
		await updateTemplateInstance({
			id: "i1",
			createNewVersion: true,
			scheduleUpdate: { mode: "off" },
		});
		const arg = tiCreate.mock.calls.at(-1)?.[0] as {
			data: {
				scheduleMode: string;
				schedule: unknown;
				nextRunAt: unknown;
			};
		};
		expect(arg.data.scheduleMode).toBe("OFF");
		expect(arg.data.nextRunAt).toBeNull();
		expect(arg.data.schedule).toMatchObject({ frequency: "weekly" }); // retained from current
	});
});

describe("restoreReportInstanceVersion (Part 2: preserves OFF)", () => {
	it("clones scheduleMode so a restored OFF version stays OFF (no resurrection)", async () => {
		tiFindUnique.mockResolvedValue({
			id: "old",
			sId: "s1",
			templateId: "t1",
			userId: "u1",
			organizationId: null,
			name: "X",
			description: null,
			heroEmojis: [],
			connections: {},
			parameterDefaults: null,
			fabricConfig: null,
			schedule: {
				frequency: "weekly",
				dayOfWeek: 1,
				hour: 9,
				minute: 0,
				timezone: "UTC",
				anchorAt: "2026-06-29T09:00:00.000Z",
			},
			scheduleMode: "OFF",
		});
		tiAggregate.mockResolvedValue({ _max: { version: 3 } });
		tiUpdateMany.mockResolvedValue({ count: 1 });
		tiCreate.mockResolvedValue({ id: "new" });
		await restoreReportInstanceVersion("old");
		const arg = tiCreate.mock.calls.at(-1)?.[0] as {
			data: { scheduleMode: string; nextRunAt: unknown };
		};
		expect(arg.data.scheduleMode).toBe("OFF");
		expect(arg.data.nextRunAt).toBeNull(); // and find-due/backfill exclude OFF, so it won't resurrect
	});
});

describe("getInstanceScheduleMode (§6.4 dispatch-time re-check)", () => {
	it("selects only scheduleMode for the given id", async () => {
		tiFindUnique.mockResolvedValue({ scheduleMode: "OFF" });
		await expect(getInstanceScheduleMode("i1")).resolves.toBe("OFF");
		expect(tiFindUnique).toHaveBeenCalledWith({
			where: { id: "i1" },
			select: { scheduleMode: true },
		});
	});

	it("returns null when the instance is not found", async () => {
		tiFindUnique.mockResolvedValue(null);
		await expect(getInstanceScheduleMode("missing")).resolves.toBeNull();
	});
});
