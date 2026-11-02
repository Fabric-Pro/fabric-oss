import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
	handler: undefined as any,
	inputSchema: undefined as any,
	get: vi.fn(),
	edit: vi.fn(),
	access: vi.fn(),
	update: vi.fn(),
	event: vi.fn(),
	audit: vi.fn(),
	describe: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getCodingRun: f.get,
	canEditProject: f.edit,
	recordAuditTx: f.audit,
	db: {
		$transaction: async (fn: any) =>
			fn({
				codingRun: { updateMany: f.update },
				codingRunEvent: { create: f.event },
			}),
	},
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { getHandle: () => ({ describe: f.describe }) },
	}),
}));
vi.mock("../lib/remote-server-access", () => ({
	remoteServerConnectionId: () => "example-connection",
	requireRemoteServerAccess: f.access,
}));
vi.mock("../../../orpc/procedures", () => {
	const chain: any = {
		use: () => chain,
		route: () => chain,
		input: (schema: unknown) => {
			f.inputSchema = schema;
			return chain;
		},
		output: () => chain,
		handler: (fn: any) => {
			f.handler = fn;
			return fn;
		},
	};
	return {
		tenantProtectedProcedure: chain,
		Permissions: { AGENT_DELETE: "AGENT_DELETE" },
		requireInputOrgPermission: () => {},
		resolveOrganizationId: () => "example-org",
	};
});
import "../procedures/recover-coding-run";
const run = {
	id: "example-run",
	userId: "example-owner",
	organizationId: "example-org",
	projectId: "example-project",
	workflowId: "example-workflow",
	status: "AWAITING_REVIEW",
	events: [{ eventType: "cancellation_unknown" }],
};
const call = (userId = "example-owner") =>
	f.handler({
		input: {
			id: run.id,
			organizationId: run.organizationId,
			confirmOrphanCheck: true,
		},
		context: {
			user: { id: userId },
			session: { activeOrganizationId: run.organizationId },
		},
	});
beforeEach(() => {
	vi.resetAllMocks();
	f.get.mockResolvedValue(run);
	f.edit.mockResolvedValue(true);
	f.describe.mockResolvedValue({ status: { name: "COMPLETED" } });
	f.access.mockResolvedValue({});
	f.update.mockResolvedValue({ count: 1 });
});
it.each(["example-owner", "example-editor"])(
	"allows %s to close the ambiguous row and audits atomically",
	async (userId) => {
		f.edit.mockResolvedValue(true);
		expect(await call(userId)).toMatchObject({
			status: "failed",
			warning: expect.stringContaining("original server"),
		});
		expect(f.get).toHaveBeenCalledWith(run.id, userId, run.organizationId);
		expect(f.access).toHaveBeenCalledWith({
			id: "example-connection",
			projectId: run.projectId,
			userId,
			allowDisabled: true,
		});
		expect(f.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: run.id,
					organizationId: run.organizationId,
					status: "AWAITING_REVIEW",
					workflowId: run.workflowId,
					events: {
						some: {
							eventType: {
								in: [
									"cancellation_unknown",
									"continuation_recovery_required",
								],
							},
						},
					},
				}),
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
		expect(f.event).toHaveBeenCalled();
		expect(f.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "weave.session.recovery_closed",
				organizationId: run.organizationId,
				resource: { type: "coding_run", id: run.id },
			}),
		);
	},
);
it("refuses a non-owner without edit permission", async () => {
	f.edit.mockResolvedValue(false);
	await expect(call("example-viewer")).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	expect(f.update).not.toHaveBeenCalled();
});
it("refuses another developer's private server", async () => {
	f.access.mockRejectedValue(new Error("Private server"));
	await expect(call()).rejects.toThrow("Private server");
	expect(f.update).not.toHaveBeenCalled();
});
it.each([{ status: "RUNNING" }, { events: [] }])(
	"refuses non-ambiguous rows %j",
	async (override) => {
		f.get.mockResolvedValue({ ...run, ...override });
		await expect(call()).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(f.update).not.toHaveBeenCalled();
	},
);
it("refuses tenant-invisible rows", async () => {
	f.get.mockResolvedValue(null);
	await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
	expect(f.update).not.toHaveBeenCalled();
});
it("does not audit or release a row that changed during recovery", async () => {
	f.update.mockResolvedValue({ count: 0 });
	await expect(call()).rejects.toMatchObject({ code: "CONFLICT" });
	expect(f.audit).not.toHaveBeenCalled();
	expect(f.event).not.toHaveBeenCalled();
});

it("rejects recovery without an explicit orphan-check acknowledgment", () => {
	expect(
		f.inputSchema.safeParse({ id: run.id, confirmOrphanCheck: false })
			.success,
	).toBe(false);
	expect(f.inputSchema.safeParse({ id: run.id }).success).toBe(false);
});

it("requires current edit permission for the run owner", async () => {
	f.edit.mockResolvedValue(false);
	await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(f.update).not.toHaveBeenCalled();
});
it("refuses recovery while the workflow can still write its finally", async () => {
	f.describe.mockResolvedValue({ status: { name: "RUNNING" } });
	await expect(call()).rejects.toMatchObject({ code: "CONFLICT" });
	expect(f.update).not.toHaveBeenCalled();
});
it("allows recovery when the workflow is not found", async () => {
	const error = Object.assign(new Error("Absent"), {
		name: "WorkflowNotFoundError",
	});
	f.describe.mockRejectedValue(error);
	expect(await call()).toMatchObject({ status: "failed" });
});
it("does not mistake a description outage for a closed workflow", async () => {
	f.describe.mockRejectedValue(new Error("Temporal unavailable"));
	await expect(call()).rejects.toThrow("Temporal unavailable");
	expect(f.update).not.toHaveBeenCalled();
});
