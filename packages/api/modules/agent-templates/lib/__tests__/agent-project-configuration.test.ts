import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), deleted: vi.fn() }));
vi.mock("@repo/database", () => ({
	getProjectAccessContext: mocks.access,
	isProjectSoftDeleted: mocks.deleted,
}));

import { prepareAgentProjectConfiguration } from "../agent-project-configuration";

const base = { userId: "example-user", organizationId: "example-org" };
beforeEach(() => {
	vi.clearAllMocks();
	mocks.access.mockResolvedValue({ organizationId: "example-org" });
	mocks.deleted.mockResolvedValue(false);
});
describe("authorized agent project configuration", () => {
	it("preserves inherited template semantics when metadata changes without an instruction override", async () => {
		const result = await prepareAgentProjectConfiguration({
			...base,
			previousInstructions: { projectId: "example-project" },
			customInstructions: {
				starterMessages: [
					{ id: "example-starter", prompt: "Create a brief" },
				],
			},
		});
		expect(result.customInstructions).toEqual({
			projectId: "example-project",
			starterMessages: [
				{ id: "example-starter", prompt: "Create a brief" },
			],
		});
		expect(result.customInstructions).not.toHaveProperty("role");
	});
	it("preserves metadata and expected output on ordinary instruction edits", async () => {
		const result = await prepareAgentProjectConfiguration({
			...base,
			previousInstructions: {
				role: "Old",
				expectedOutput: "Cited answer",
				projectId: "example-project",
				portableRequirements: [{ kind: "mcp", name: "Example" }],
			},
			customInstructions: { role: "New" },
		});
		expect(result.customInstructions).toEqual({
			role: "New",
			expectedOutput: "Cited answer",
			projectId: "example-project",
			portableRequirements: [{ kind: "mcp", name: "Example" }],
		});
		expect(mocks.access).toHaveBeenCalledWith(
			"example-project",
			"example-user",
		);
	});
	it("binds selected project and expected output without enabling a tool", async () => {
		const result = await prepareAgentProjectConfiguration({
			...base,
			projectId: "example-project",
			expectedOutput: "  A concise brief  ",
			customInstructions: { role: "Helper" },
		});
		expect(result.customInstructions).toEqual({
			role: "Helper",
			projectId: "example-project",
			expectedOutput: "A concise brief",
		});
		expect(result.toolConnections).toEqual({});
	});
	it("clears both canonical and enabled legacy bindings deliberately", async () => {
		const result = await prepareAgentProjectConfiguration({
			...base,
			projectId: null,
			previousInstructions: { projectId: "example-project" },
			previousToolConnections: {
				"project-context": {
					enabled: true,
					projectId: "example-project",
				},
			},
		});
		expect(result.projectId).toBeUndefined();
		expect(result.toolConnections).toEqual({
			"project-context": { enabled: true },
		});
		expect(mocks.access).not.toHaveBeenCalled();
	});
	it.each([null, { organizationId: "other-org" }, { organizationId: null }])(
		"refuses inaccessible or foreign project even for a shared account (%j)",
		async (access) => {
			mocks.access.mockResolvedValue(access);
			await expect(
				prepareAgentProjectConfiguration({
					...base,
					projectId: "example-project",
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		},
	);
	it("refuses a deleted project", async () => {
		mocks.deleted.mockResolvedValue(true);
		await expect(
			prepareAgentProjectConfiguration({
				...base,
				projectId: "example-project",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("validates passthrough metadata and conflicts instead of trusting it", async () => {
		await expect(
			prepareAgentProjectConfiguration({
				...base,
				customInstructions: { projectId: 42 },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			prepareAgentProjectConfiguration({
				...base,
				customInstructions: { expectedOutput: {} },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			prepareAgentProjectConfiguration({
				...base,
				customInstructions: { projectId: "example-a" },
				toolConnections: {
					"project-context": { projectId: "example-b" },
				},
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
	it("reauthorizes an unchanged binding rather than letting a metadata edit bypass access", async () => {
		mocks.access.mockResolvedValue(null);
		await expect(
			prepareAgentProjectConfiguration({
				...base,
				previousInstructions: { projectId: "example-project" },
				customInstructions: { role: "Updated" },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("refuses an empty organization even when a project has a legacy empty tenant column", async () => {
		mocks.access.mockResolvedValue({ organizationId: "" });
		await expect(
			prepareAgentProjectConfiguration({
				...base,
				organizationId: "",
				projectId: "example-project",
			}),
		).rejects.toThrow("An organization is required");
		expect(mocks.access).not.toHaveBeenCalled();
	});
});
