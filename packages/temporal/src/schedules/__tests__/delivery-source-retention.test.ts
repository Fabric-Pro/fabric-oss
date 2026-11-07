import { readFileSync } from "node:fs";
import { ScheduleAlreadyRunning } from "@temporalio/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	storage: vi.fn(),
	worker: vi.fn(),
	create: vi.fn(),
	describe: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	isDeliverySourceRetentionWorkerQualified: m.worker,
}));
vi.mock("../../lib/delivery-source-readiness", () => ({
	isPrivateDeliverySourceStorageReady: m.storage,
}));

import {
	DELIVERY_SOURCE_RETENTION_SCHEDULE,
	registerDeliverySourceRetentionSchedule,
} from "../delivery-source-retention";

const existing = () => ({
	scheduleId: DELIVERY_SOURCE_RETENTION_SCHEDULE.scheduleId,
	spec: {
		timezone: "UTC",
		calendars: [
			{
				second: [{ start: 0, end: 0, step: 1 }],
				minute: [{ start: 35, end: 35, step: 1 }],
				hour: [{ start: 6, end: 6, step: 1 }],
				dayOfMonth: [{ start: 1, end: 31, step: 1 }],
				month: [{ start: "JANUARY", end: "DECEMBER", step: 1 }],
				dayOfWeek: [{ start: "SUNDAY", end: "SATURDAY", step: 1 }],
				year: [],
			},
		],
	},
	action: {
		type: "startWorkflow",
		workflowType: String(DELIVERY_SOURCE_RETENTION_SCHEDULE.workflowType),
		taskQueue: String(DELIVERY_SOURCE_RETENTION_SCHEDULE.taskQueue),
		args: [],
	},
	state: { paused: false },
	policies: {
		overlap: "SKIP",
		catchupWindow: 43200000,
		pauseOnFailure: false,
	},
});
beforeEach(() => {
	vi.resetAllMocks();
	m.storage.mockResolvedValue(true);
	m.worker.mockResolvedValue(true);
	m.create.mockResolvedValue(undefined);
	m.describe.mockResolvedValue(existing());
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());
describe("private-source native retention schedule registration", () => {
	it.each(["true", "false", ""])(
		"registers daily cleanup independently of ingestion flag %j",
		async (flag) => {
			vi.stubEnv("FABRIC_PRIVATE_SOURCE_CAPTURE_ENABLED", flag);
			await registerDeliverySourceRetentionSchedule({
				create: m.create,
				getHandle: () => ({ describe: m.describe }),
			});
			expect(m.create).toHaveBeenCalledOnce();
			expect(m.create.mock.calls[0][0]).toMatchObject({
				scheduleId: DELIVERY_SOURCE_RETENTION_SCHEDULE.scheduleId,
				spec: { cronExpressions: ["35 6 * * *"], timezone: "UTC" },
				action: {
					type: "startWorkflow",
					workflowType: "deliverySourceObservationRetentionWorkflow",
					taskQueue: "fabric-worker",
					args: [],
				},
				policies: { overlap: "SKIP", catchupWindow: "12 hours" },
				state: { paused: false },
			});
		},
	);
	it("does not query worker authority or register when storage is absent", async () => {
		m.storage.mockResolvedValue(false);
		await registerDeliverySourceRetentionSchedule({
			create: m.create,
			getHandle: () => ({ describe: m.describe }),
		});
		expect(m.worker).not.toHaveBeenCalled();
		expect(m.create).not.toHaveBeenCalled();
	});
	it("refuses unqualified actual worker even with enabled ingestion", async () => {
		vi.stubEnv("FABRIC_PRIVATE_SOURCE_CAPTURE_ENABLED", "true");
		m.worker.mockResolvedValue(false);
		await registerDeliverySourceRetentionSchedule({
			create: m.create,
			getHandle: () => ({ describe: m.describe }),
		});
		expect(m.create).not.toHaveBeenCalled();
	});
	it.each(["storage", "worker"] as const)(
		"safely skips a failed %s check without disclosing connection errors",
		async (name) => {
			m[name].mockRejectedValue(Error("example-private-connection"));
			await registerDeliverySourceRetentionSchedule({
				create: m.create,
				getHandle: () => ({ describe: m.describe }),
			});
			expect(m.create).not.toHaveBeenCalled();
			expect(console.log).not.toHaveBeenCalledWith(
				expect.stringContaining("example-private-connection"),
			);
		},
	);
	it("accepts only the expected active existing native cleanup schedule", async () => {
		m.create.mockRejectedValue(
			new ScheduleAlreadyRunning(
				"exists",
				DELIVERY_SOURCE_RETENTION_SCHEDULE.scheduleId,
			),
		);
		await expect(
			registerDeliverySourceRetentionSchedule({
				create: m.create,
				getHandle: () => ({ describe: m.describe }),
			}),
		).resolves.toBeUndefined();
	});
	it("surfaces Temporal registration failures", async () => {
		m.create.mockRejectedValue(Error("example-temporal-unavailable"));
		await expect(
			registerDeliverySourceRetentionSchedule({
				create: m.create,
				getHandle: () => ({ describe: m.describe }),
			}),
		).rejects.toThrow("example-temporal-unavailable");
	});
	it("is part of worker startup and names the actual registered workflow", () => {
		const schedules = readFileSync(
			new URL("../../schedules.ts", import.meta.url),
			"utf8",
		);
		const workflows = readFileSync(
			new URL("../../workflows/index.ts", import.meta.url),
			"utf8",
		);
		expect(schedules).toContain(
			"await registerDeliverySourceRetentionSchedule(scheduleClient)",
		);
		expect(workflows).toContain(
			DELIVERY_SOURCE_RETENTION_SCHEDULE.workflowType,
		);
	});
});

it.each([
	"paused",
	"wrongWorkflow",
	"wrongQueue",
	"wrongHour",
	"futureStart",
	"finiteActions",
	"wrongPolicy",
	"extraArgs",
])(
	"refuses an existing %s cleanup schedule without overwriting it",
	async (kind) => {
		const value = existing();
		if (kind === "paused") value.state.paused = true;
		if (kind === "wrongWorkflow")
			value.action.workflowType = "example-other-workflow";
		if (kind === "wrongQueue")
			value.action.taskQueue = "example-other-queue";
		if (kind === "wrongHour") value.spec.calendars[0].hour[0].start = 7;
		const extra =
			kind === "futureStart"
				? {
						spec: {
							...value.spec,
							startAt: new Date(Date.now() + 86400000),
						},
					}
				: kind === "finiteActions"
					? { state: { ...value.state, remainingActions: 1 } }
					: kind === "extraArgs"
						? {
								action: {
									...value.action,
									args: ["example-untrusted"],
								},
							}
						: kind === "wrongPolicy"
							? {
									policies: {
										...value.policies,
										overlap: "ALLOW_ALL",
									},
								}
							: {};
		m.create.mockRejectedValue(
			new ScheduleAlreadyRunning(
				"exists",
				DELIVERY_SOURCE_RETENTION_SCHEDULE.scheduleId,
			),
		);
		m.describe.mockResolvedValue({ ...value, ...extra });
		await expect(
			registerDeliverySourceRetentionSchedule({
				create: m.create,
				getHandle: () => ({ describe: m.describe }),
			}),
		).rejects.toThrow("requires operator attention");
		expect(m.create).toHaveBeenCalledTimes(1);
	},
);
