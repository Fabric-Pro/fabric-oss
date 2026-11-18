import { beforeEach, describe, expect, it, vi } from "vitest";

const { lookupServer, findConfig, createConfig, updateConfig } = vi.hoisted(
	() => ({
		lookupServer: vi.fn(),
		findConfig: vi.fn(),
		createConfig: vi.fn(),
		updateConfig: vi.fn(),
	}),
);

vi.mock("../prisma/client", () => ({
	db: {
		mCPServer: { findUnique: lookupServer },
		mCPConfig: {
			findFirst: findConfig,
			create: createConfig,
			update: updateConfig,
		},
	},
}));

import { createMcpConfig, upsertMcpConfig } from "../prisma/queries/mcp";

const tenant = {
	mcpServerId: "server_example",
	userId: "user_example",
	organizationId: "org_example",
};

describe("MCP config query writers", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		lookupServer.mockResolvedValue({
			key: "azure-devops",
			isSystemProvided: true,
		});
		findConfig.mockResolvedValue(null);
	});

	it.each([createMcpConfig, upsertMcpConfig])(
		"%s refuses invalid arguments and writes a valid name on creation",
		async (write) => {
			await expect(
				write({
					...tenant,
					data: { commandArgs: ["-example"] },
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(createConfig).not.toHaveBeenCalled();

			await write({ ...tenant, data: { commandArgs: ["example-org"] } });
			expect(createConfig).toHaveBeenCalledWith({
				data: expect.objectContaining({ commandArgs: ["example-org"] }),
			});
		},
	);

	it("refuses new Filesystem connections", async () => {
		lookupServer.mockResolvedValue({
			key: "filesystem",
			isSystemProvided: true,
		});
		await expect(
			createMcpConfig({ ...tenant, data: {} }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "This MCP server is not available to configure.",
		});
		expect(createConfig).not.toHaveBeenCalled();
	});

	it("validates supplied arguments on update and permits unrelated edits", async () => {
		findConfig.mockResolvedValue({
			id: "config_example",
			commandArgs: ["-example"],
		});
		await expect(
			upsertMcpConfig({
				...tenant,
				data: { commandArgs: ["-example"] },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(updateConfig).not.toHaveBeenCalled();

		await upsertMcpConfig({ ...tenant, data: { displayName: "Example" } });
		expect(updateConfig).toHaveBeenCalledWith({
			where: { id: "config_example" },
			data: { displayName: "Example" },
		});
	});
});
