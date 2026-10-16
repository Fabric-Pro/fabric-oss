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

describe("tools a runtime adds to the agent's own", () => {
	it("merges them under the runtime's source and sends their calls through invoke", async () => {
		const execute = vi.fn(async () => ({ posted: true }));
		const invoke = vi.fn(async (invocation: { execute: () => unknown }) =>
			invocation.execute(),
		);
		const tools: Record<string, unknown> = {
			existing: { inputSchema: {}, execute: vi.fn() },
		};

		await withAgentToolRuntime(
			{
				invoke,
				tools: {
					post_to_meeting_chat: {
						description: "Post",
						inputSchema: {},
						execute,
					},
				},
			},
			async () => {
				await prepareAgentTools(tools, {
					existing: {
						configId: "connection",
						originalName: "existing",
					},
				});
				const added = tools.post_to_meeting_chat;
				if (!isExecutableAgentTool(added)) {
					throw new Error("The runtime's tool was not merged");
				}
				await expect(added.execute({ text: "Hello" })).resolves.toEqual(
					{
						posted: true,
					},
				);
			},
		);

		expect(Object.keys(tools).sort()).toEqual([
			"existing",
			"post_to_meeting_chat",
		]);
		expect(invoke).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "post_to_meeting_chat",
				args: { text: "Hello" },
				source: {
					configId: "parlume",
					originalName: "post_to_meeting_chat",
				},
			}),
		);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("leaves the agent's own tools on their own source", async () => {
		const invoke = vi.fn(async () => "held");
		const tools: Record<string, unknown> = {
			existing: { inputSchema: {}, execute: vi.fn() },
		};

		await withAgentToolRuntime(
			{
				invoke,
				tools: { added: { inputSchema: {}, execute: vi.fn() } },
			},
			async () => {
				await prepareAgentTools(tools, {
					existing: {
						configId: "connection",
						originalName: "existing",
					},
				});
				await (
					tools.existing as { execute: (args: unknown) => unknown }
				).execute({});
			},
		);

		expect(invoke).toHaveBeenCalledWith(
			expect.objectContaining({
				source: { configId: "connection", originalName: "existing" },
			}),
		);
	});

	it("does not change the caller's source map", async () => {
		const sources = {
			existing: { configId: "connection", originalName: "existing" },
		};

		await withAgentToolRuntime(
			{
				invoke: vi.fn(),
				tools: { added: { inputSchema: {}, execute: vi.fn() } },
			},
			() =>
				prepareAgentTools(
					{ existing: { inputSchema: {}, execute: vi.fn() } },
					sources,
				),
		);

		expect(Object.keys(sources)).toEqual(["existing"]);
	});

	it("adds nothing when the runtime has none, and nothing outside a runtime", async () => {
		const tools: Record<string, unknown> = {};
		await withAgentToolRuntime({ invoke: vi.fn() }, () =>
			prepareAgentTools(tools),
		);
		await prepareAgentTools(tools);
		expect(tools).toEqual({});
	});

	it("is skipped by a runtime that prepares the tools itself", async () => {
		const tools: Record<string, unknown> = {};
		await withAgentToolRuntime(
			{
				invoke: vi.fn(),
				prepared: async () => "Done",
				tools: { added: { inputSchema: {}, execute: vi.fn() } },
			},
			() => prepareAgentTools(tools),
		);
		expect(tools).toEqual({});
	});
});
