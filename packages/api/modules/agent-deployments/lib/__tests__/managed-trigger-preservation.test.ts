import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	instance: vi.fn(),
	deployment: vi.fn(),
	triggers: vi.fn(),
	update: vi.fn(),
	create: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		agentTemplateInstance: { findUnique: m.instance },
		agentDeployment: { findUnique: m.deployment },
		agentDeploymentTrigger: {
			findMany: m.triggers,
			update: m.update,
			create: m.create,
		},
	},
}));
vi.mock("@repo/utils", () => ({ encryptApiKey: vi.fn() }));

import { syncDeploymentTriggers } from "../sync-triggers";

const managed = {
	id: "fabric-run-schedule-example-deployment",
	type: "SCHEDULE",
	slackChannelId: null,
	isActive: true,
	config: {
		fabricManagedRunSchedule: 1,
		inputTemplate: { message: "Example" },
	},
};
beforeEach(() => {
	vi.resetAllMocks();
	m.instance.mockResolvedValue({
		id: "example-instance",
		name: "Example",
		triggers: [],
	});
	m.deployment.mockResolvedValue({ id: "example-deployment" });
	m.triggers.mockResolvedValue([managed]);
});
describe("ordinary instance trigger reconciliation", () => {
	it("preserves managed run schedule when advanced triggers are empty", async () => {
		await syncDeploymentTriggers({
			instanceId: "example-instance",
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(m.update).not.toHaveBeenCalled();
		expect(m.create).not.toHaveBeenCalled();
	});
	it("still deactivates removed advanced schedule without changing managed one", async () => {
		m.triggers.mockResolvedValue([
			managed,
			{
				id: "example-advanced",
				type: "SCHEDULE",
				slackChannelId: null,
				isActive: true,
				config: {},
			},
		]);
		await syncDeploymentTriggers({
			instanceId: "example-instance",
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(m.update).toHaveBeenCalledExactlyOnceWith({
			where: { id: "example-advanced" },
			data: { isActive: false },
		});
	});
});
