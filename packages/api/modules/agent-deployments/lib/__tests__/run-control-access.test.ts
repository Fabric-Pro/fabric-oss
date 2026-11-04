import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	find: vi.fn(),
	read: vi.fn(),
	execute: vi.fn(),
	deployment: vi.fn(),
	available: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		agentTemplateInstance: { findFirst: m.find },
		agentDeployment: { findFirst: m.deployment },
	},
	getAgentTemplateInstanceForRead: m.read,
	getAgentTemplateInstanceForExecution: m.execute,
}));
vi.mock("@repo/agent-types/agent-implementation", () => ({
	getAgentImplementationAvailability: m.available,
}));

import {
	getOwnedRunDeployment,
	resolveRunControlInstance,
} from "../run-control-access";

const actor = { userId: "example-user", organizationId: "example-org" };
const instance = {
	id: "example-canonical",
	...actor,
	status: "ACTIVE",
	name: "Example",
	customInstructions: {},
};
beforeEach(() => {
	vi.resetAllMocks();
	m.find.mockResolvedValue(instance);
	m.read.mockResolvedValue({ instance, projectId: "example-project" });
	m.execute.mockResolvedValue({ instance, projectId: "example-project" });
	m.available.mockReturnValue({ available: true });
});
describe("run control current authority", () => {
	it("resolves SID within one organization and applies current project visibility", async () => {
		expect(
			await resolveRunControlInstance("EXAMPLE-SID", actor),
		).toMatchObject({ id: instance.id, projectId: "example-project" });
		expect(m.find).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					organizationId: actor.organizationId,
					OR: [{ id: "EXAMPLE-SID" }, { sId: "EXAMPLE-SID" }],
				},
			}),
		);
		expect(m.read).toHaveBeenCalledWith({
			instanceId: instance.id,
			...actor,
		});
	});
	it.each([null, { ...instance, organizationId: "another-org" }])(
		"fails closed for missing/foreign agent",
		async (value) => {
			m.find.mockResolvedValue(value);
			await expect(
				resolveRunControlInstance(instance.id, actor),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(m.execute).not.toHaveBeenCalled();
		},
	);
	it("does not run another member saved credentials", async () => {
		m.find.mockResolvedValue({ ...instance, userId: "another-user" });
		await expect(
			resolveRunControlInstance(instance.id, actor, true),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("refuses revoked execution project permission", async () => {
		m.execute.mockResolvedValue(null);
		await expect(
			resolveRunControlInstance(instance.id, actor, true),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("refuses archived or unsupported implementation without runtime fallback", async () => {
		m.find.mockResolvedValue({ ...instance, status: "ARCHIVED" });
		await expect(
			resolveRunControlInstance(instance.id, actor, true),
		).rejects.toMatchObject({ code: "CONFLICT" });
		m.find.mockResolvedValue(instance);
		m.available.mockReturnValue({
			available: false,
			reason: "Implementation unavailable",
		});
		await expect(
			resolveRunControlInstance(instance.id, actor, true),
		).rejects.toThrow("Implementation unavailable");
	});
	it("scopes deployment read to instance, credential owner and tenant", async () => {
		await getOwnedRunDeployment(instance.id, actor);
		expect(m.deployment).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { instanceId: instance.id, ...actor },
			}),
		);
	});
});

describe("pause does not activate an agent", () => {
	it.each(["ARCHIVED", "INACTIVE"])(
		"keeps owner and current execution access when pausing a %s agent",
		async (status) => {
			m.find.mockResolvedValue({ ...instance, status });
			m.available.mockReturnValue({
				available: false,
				reason: "Implementation unavailable",
			});
			expect(
				await resolveRunControlInstance(instance.id, actor, true, {
					requireRunnable: false,
				}),
			).toMatchObject({ status });
			expect(m.execute).toHaveBeenCalledWith({
				instanceId: instance.id,
				...actor,
			});
			expect(m.available).not.toHaveBeenCalled();
		},
	);
	it("allows pause of an unsupported implementation but still refuses enabling it", async () => {
		m.available.mockReturnValue({
			available: false,
			reason: "Implementation unavailable",
		});
		await expect(
			resolveRunControlInstance(instance.id, actor, true, {
				requireRunnable: false,
			}),
		).resolves.toMatchObject({ id: instance.id });
		await expect(
			resolveRunControlInstance(instance.id, actor, true),
		).rejects.toThrow("Implementation unavailable");
	});
	it("does not let pause bypass revoked current access or owner credentials", async () => {
		m.execute.mockResolvedValue(null);
		await expect(
			resolveRunControlInstance(instance.id, actor, true, {
				requireRunnable: false,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		m.execute.mockResolvedValue({ instance });
		m.find.mockResolvedValue({ ...instance, userId: "another-user" });
		await expect(
			resolveRunControlInstance(instance.id, actor, true, {
				requireRunnable: false,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
