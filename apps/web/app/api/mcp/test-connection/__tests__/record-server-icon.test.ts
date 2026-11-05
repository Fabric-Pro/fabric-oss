import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findOwnedCustomMcpServer: vi.fn(),
	setOwnedCustomMcpServerIcon: vi.fn(),
	canUpdateOrganizationMcpServers: vi.fn(),
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	findOwnedCustomMcpServer: mocks.findOwnedCustomMcpServer,
	setOwnedCustomMcpServerIcon: mocks.setOwnedCustomMcpServerIcon,
	canUpdateOrganizationMcpServers: mocks.canUpdateOrganizationMcpServers,
}));

vi.mock("@repo/api/lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAuditFromRequest,
}));

import {
	type RecordServerIconInput,
	recordServerProvidedIcon,
} from "../record-server-icon";

const ICON = "https://example.com/brand/mark.svg";

function input(
	overrides: Partial<RecordServerIconInput> = {},
): RecordServerIconInput {
	return {
		headers: new Headers(),
		user: { id: "user-1", email: "dev@example.com" },
		session: { id: "session-1" },
		mcpServerId: "server-1",
		isSystemProvided: false,
		organizationId: "org-1",
		serverUrl: "https://example.com/mcp",
		icons: [{ src: ICON, mimeType: "image/svg+xml", sizes: ["any"] }],
		websiteUrl: undefined,
		...overrides,
	};
}

describe("recordServerProvidedIcon", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findOwnedCustomMcpServer.mockResolvedValue({
			id: "server-1",
			name: "Example server",
			iconUrl: null,
			defaultUrl: "https://example.com/mcp",
		});
		mocks.canUpdateOrganizationMcpServers.mockResolvedValue(true);
		mocks.setOwnedCustomMcpServerIcon.mockResolvedValue(true);
	});

	it("stores the icon on an owned custom server and audits it", async () => {
		await expect(recordServerProvidedIcon(input())).resolves.toBe(
			"written",
		);
		expect(mocks.findOwnedCustomMcpServer).toHaveBeenCalledWith({
			id: "server-1",
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(mocks.setOwnedCustomMcpServerIcon).toHaveBeenCalledWith({
			id: "server-1",
			userId: "user-1",
			organizationId: "org-1",
			expectedIconUrl: null,
			iconUrl: ICON,
		});
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditFromRequest.mock.calls[0][1]).toMatchObject({
			action: "mcp.config.updated",
			organizationId: "org-1",
			resource: { type: "mcp_server", id: "server-1" },
			metadata: { change: "server_icon_updated" },
		});
	});

	it.each([
		["a system or catalog server", { isSystemProvided: true }],
		["an unknown server kind", { isSystemProvided: null }],
		["a config without a server", { mcpServerId: null }],
		["a personal (no-organization) config", { organizationId: null }],
		["a server that lists no icons", { icons: [] }],
	])("never writes for %s", async (_label, overrides) => {
		await expect(
			recordServerProvidedIcon(
				input(overrides as Partial<RecordServerIconInput>),
			),
		).resolves.toBe("not-applicable");
		expect(mocks.findOwnedCustomMcpServer).not.toHaveBeenCalled();
		expect(mocks.setOwnedCustomMcpServerIcon).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("never writes for a caller who does not own the server", async () => {
		mocks.findOwnedCustomMcpServer.mockResolvedValue(null);
		await expect(recordServerProvidedIcon(input())).resolves.toBe(
			"not-owner",
		);
		expect(mocks.setOwnedCustomMcpServerIcon).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("never writes for an owner without MCP_UPDATE in the organization", async () => {
		mocks.canUpdateOrganizationMcpServers.mockResolvedValue(false);
		await expect(recordServerProvidedIcon(input())).resolves.toBe(
			"forbidden",
		);
		expect(mocks.canUpdateOrganizationMcpServers).toHaveBeenCalledWith(
			"user-1",
			"org-1",
		);
		expect(mocks.setOwnedCustomMcpServerIcon).not.toHaveBeenCalled();
	});

	it("does not write or audit when the stored icon is unchanged", async () => {
		mocks.findOwnedCustomMcpServer.mockResolvedValue({
			id: "server-1",
			name: "Example server",
			iconUrl: ICON,
			defaultUrl: "https://example.com/mcp",
		});
		await expect(recordServerProvidedIcon(input())).resolves.toBe(
			"unchanged",
		);
		expect(mocks.setOwnedCustomMcpServerIcon).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("does not overwrite an icon from another origin", async () => {
		mocks.findOwnedCustomMcpServer.mockResolvedValue({
			id: "server-1",
			name: "Example server",
			iconUrl: "https://icons.example.org/custom.png",
			defaultUrl: "https://example.com/mcp",
		});
		await expect(recordServerProvidedIcon(input())).resolves.toBe(
			"unchanged",
		);
		expect(mocks.setOwnedCustomMcpServerIcon).not.toHaveBeenCalled();
	});

	it("refreshes an icon on the websiteUrl origin of a separate MCP host", async () => {
		mocks.findOwnedCustomMcpServer.mockResolvedValue({
			id: "server-1",
			name: "Example server",
			iconUrl: "https://example.com/brand/old-mark.svg",
			defaultUrl: "https://mcp.example.com/mcp",
		});
		await expect(
			recordServerProvidedIcon(
				input({
					serverUrl: "https://mcp.example.com/mcp",
					websiteUrl: "https://example.com",
				}),
			),
		).resolves.toBe("written");
		expect(mocks.setOwnedCustomMcpServerIcon).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedIconUrl: "https://example.com/brand/old-mark.svg",
				iconUrl: ICON,
			}),
		);
	});

	it("skips the audit when a concurrent change won the conditional write", async () => {
		mocks.setOwnedCustomMcpServerIcon.mockResolvedValue(false);
		await expect(recordServerProvidedIcon(input())).resolves.toBe(
			"unchanged",
		);
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("never throws when the write fails", async () => {
		mocks.setOwnedCustomMcpServerIcon.mockRejectedValue(
			new Error("database unavailable"),
		);
		await expect(recordServerProvidedIcon(input())).resolves.toBe("failed");
	});
});
