import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAgentTemplate: vi.fn() }));

vi.mock("../prisma/client", () => ({ db: {} }));
vi.mock("../prisma/queries/agent-templates", () => ({
	getAgentTemplate: mocks.getAgentTemplate,
}));

import { initializeMemoryFromTemplate } from "../prisma/queries/agent-memory";

it("refuses another organization's template before initializing memory", async () => {
	mocks.getAgentTemplate.mockResolvedValue(null);

	await expect(
		initializeMemoryFromTemplate({
			agentInstanceId: "example-agent",
			templateId: "example-template-b",
			userId: "example-user",
			organizationId: "example-org-a",
		}),
	).rejects.toThrow("Template example-template-b not found");

	expect(mocks.getAgentTemplate).toHaveBeenCalledWith("example-template-b", {
		userId: "example-user",
		organizationId: "example-org-a",
	});
});
