import { buildExternalPmTarget } from "@repo/utils/pm-target";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ config: vi.fn(), server: vi.fn() }));
vi.mock("@repo/database", () => ({
	db: {
		mCPConfig: { findFirst: mocks.config },
		mCPServer: { findUnique: mocks.server },
	},
}));

import { resolveExternalPmTarget } from "../external-pm-target";

const base = {
	projectId: "example-project",
	userId: "example-user",
	organizationId: "example-org",
	mcpServerId: "example-server",
	mcpConfigId: "example-config",
	containerId: "example-container",
};
beforeEach(() => {
	mocks.config.mockReset();
	mocks.server.mockReset();
});
describe("shared activity target resolution", () => {
	it("uses the recorded GitLab instance for config and REST callers", async () => {
		const config = {
			mcpServer: {
				key: "gitlab-official",
				defaultUrl: "https://gitlab.com",
			},
		};
		const additionalContext = {
			gitlabOrigin: "https://gitlab.example.com/",
		};
		mocks.config.mockResolvedValue(config);
		const expected = buildExternalPmTarget({
			...base,
			pmTool: "gitlab",
			additionalContext,
		});
		expect(
			await resolveExternalPmTarget({
				...base,
				additionalContext,
				config,
			}),
		).toBe(expected);
		expect(
			await resolveExternalPmTarget({ ...base, additionalContext }),
		).toBe(expected);
	});
	it("returns null rather than throwing for missing or placeholder configs", async () => {
		mocks.config.mockResolvedValue(null);
		mocks.server.mockResolvedValue(null);
		await expect(resolveExternalPmTarget(base)).resolves.toBeNull();
		await expect(
			resolveExternalPmTarget({
				...base,
				mcpServerId: "key:gitlab-official",
				mcpConfigId: null,
			}),
		).resolves.toBeNull();
		mocks.config.mockRejectedValue(new Error("config unavailable"));
		await expect(resolveExternalPmTarget(base)).resolves.toBeNull();
	});
	it("refuses to key an ADO display name from an older activity payload", async () => {
		mocks.config.mockResolvedValue({
			commandArgs: ["example-org"],
			mcpServer: { key: "azure-devops" },
		});
		expect(
			await resolveExternalPmTarget({
				...base,
				containerId: "Example Project",
				pmTool: "azure-devops",
			}),
		).toBeNull();
	});
	it("requires an explicit ADO stable id even if its display name looks like a GUID", async () => {
		const containerId = "11111111-1111-4111-8111-111111111111";
		const config = {
			commandArgs: ["example-org"],
			mcpServer: { key: "azure-devops" },
		};
		expect(
			await resolveExternalPmTarget({ ...base, containerId, config }),
		).toBeNull();
		expect(
			await resolveExternalPmTarget({
				...base,
				containerId: "Example",
				stableContainerId: containerId,
				config,
			}),
		).toBe(
			'pmt1:["example-server","example-org","11111111-1111-4111-8111-111111111111"]',
		);
	});
});
