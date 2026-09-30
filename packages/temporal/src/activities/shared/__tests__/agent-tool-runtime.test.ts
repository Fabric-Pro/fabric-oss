import { describe, expect, it, vi } from "vitest";
import {
	hasExactAgentToolApproval,
	isExecutableAgentTool,
	prepareAgentTools,
	withAgentToolRuntime,
	withApprovedAgentTool,
} from "../agent-tool-runtime";

describe("agent execution boundary", () => {
	it("limits authority approval to the exact user, tenant, connection, tool and arguments", async () => {
		const approval = {
			userId: "user",
			organizationId: "org",
			configId: "connection",
			originalName: "create",
			args: { title: "Exact", nested: { value: 1 } },
		};
		await withApprovedAgentTool(approval, async () => {
			expect(hasExactAgentToolApproval(structuredClone(approval))).toBe(
				true,
			);
			for (const change of [
				{ userId: "other" },
				{ organizationId: "other" },
				{ configId: "other" },
				{ originalName: "other" },
				{ args: { title: "Changed", nested: { value: 1 } } },
			]) {
				expect(
					hasExactAgentToolApproval({ ...approval, ...change }),
				).toBe(false);
			}
		});
		expect(hasExactAgentToolApproval(approval)).toBe(false);
	});
	it("intercepts a newly added tool without a capability allowlist", async () => {
		const execute = vi.fn();
		const invocation = vi.fn(async () => ({ approvalRequired: true }));
		const tools = { future_vendor_mutation: { inputSchema: {}, execute } };
		await withAgentToolRuntime({ invoke: invocation }, async () => {
			await prepareAgentTools(tools);
			await tools.future_vendor_mutation.execute({
				title: "Exact value",
			});
		});
		expect(execute).not.toHaveBeenCalled();
		expect(invocation).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "future_vendor_mutation",
				args: { title: "Exact value" },
			}),
		);
	});
	it("inherits the boundary across nested asynchronous agent execution", async () => {
		const execute = vi.fn();
		const invocation = vi.fn(async () => ({ held: true }));
		await withAgentToolRuntime({ invoke: invocation }, async () => {
			await Promise.resolve();
			const tools = { create_issue: { inputSchema: {}, execute } };
			await prepareAgentTools(tools);
			await tools.create_issue.execute({ title: "Nested" });
		});
		expect(execute).not.toHaveBeenCalled();
		expect(invocation).toHaveBeenCalledOnce();
	});
	it("keeps independent concurrent executions isolated", async () => {
		const ordinary = vi.fn(async () => "ordinary");
		await Promise.all([
			withAgentToolRuntime({ invoke: async () => "held" }, async () => {
				const tools = {
					change: { inputSchema: {}, execute: ordinary },
				};
				await prepareAgentTools(tools);
				expect(await tools.change.execute()).toBe("held");
			}),
			(async () => {
				const tools = {
					change: { inputSchema: {}, execute: ordinary },
				};
				await prepareAgentTools(tools);
				expect(await tools.change.execute()).toBe("ordinary");
			})(),
		]);
		expect(ordinary).toHaveBeenCalledOnce();
	});
	it("can execute an exact approved payload from freshly loaded tools without a model", async () => {
		const execute = vi.fn(async (args: unknown) => args);
		await withAgentToolRuntime(
			{
				invoke: vi.fn(),
				prepared: async (tools) => {
					const definition = tools.create_issue;
					if (!isExecutableAgentTool(definition)) {
						throw new Error("Missing tool");
					}
					await definition.execute({ title: "Approved title" });
					return "Completed";
				},
			},
			async () => {
				expect(
					await prepareAgentTools({
						create_issue: { inputSchema: {}, execute },
					}),
				).toBe("Completed");
			},
		);
		expect(execute).toHaveBeenCalledExactlyOnceWith({
			title: "Approved title",
		});
	});
});
