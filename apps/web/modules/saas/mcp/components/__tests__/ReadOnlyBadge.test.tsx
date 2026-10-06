import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { McpConfigTile } from "../McpConfigTile";
import { McpServerCard } from "../McpServerCard";
import {
	isReadOnlyMcpServer,
	READ_ONLY_MCP_TAG,
	ReadOnlyBadge,
} from "../ReadOnlyBadge";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
	usePathname: () => "/app/settings/mcp",
}));

describe("isReadOnlyMcpServer", () => {
	it("identifies read-only server and handles empty tags correctly", () => {
		expect(isReadOnlyMcpServer({ tags: [READ_ONLY_MCP_TAG] })).toBe(true);
		expect(
			isReadOnlyMcpServer({
				mcpServer: { tags: [READ_ONLY_MCP_TAG] },
			}),
		).toBe(true);
		expect(
			isReadOnlyMcpServer({
				tags: [],
				mcpServer: { tags: [READ_ONLY_MCP_TAG] },
			}),
		).toBe(true);
		expect(isReadOnlyMcpServer({ tags: ["git"] })).toBe(false);
		expect(isReadOnlyMcpServer(null)).toBe(false);
	});
});

describe("ReadOnlyBadge", () => {
	it("shows tooltip explaining agents can read resources but cannot make changes on hover", async () => {
		const user = userEvent.setup();
		render(<ReadOnlyBadge />);
		const badge = screen.getByTestId("mcp-read-only-badge");
		expect(badge).toHaveTextContent("Read-only");

		await user.hover(badge);
		expect(await screen.findByRole("tooltip")).toHaveTextContent(
			"Agents can read and inspect resources, but can't make changes.",
		);
	});
});

describe("McpServerCard", () => {
	it("renders badge when read-only and omits when not", () => {
		const { rerender } = render(
			<McpServerCard
				server={{
					id: "1",
					key: "figma",
					name: "Figma",
					tags: [READ_ONLY_MCP_TAG],
				}}
			/>,
		);
		expect(screen.getByTestId("mcp-read-only-badge")).toBeInTheDocument();

		rerender(
			<McpServerCard
				server={{ id: "2", key: "gh", name: "GitHub", tags: ["git"] }}
			/>,
		);
		expect(
			screen.queryByTestId("mcp-read-only-badge"),
		).not.toBeInTheDocument();
	});
});

describe("McpConfigTile", () => {
	it("renders badge, filters read-only from chips, and omits badge when not read-only", () => {
		const { rerender } = render(
			<McpConfigTile
				config={{
					id: "1",
					displayName: "Figma",
					mcpServer: {
						key: "figma",
						name: "Figma",
						tags: [READ_ONLY_MCP_TAG, "assets"],
					},
					enabled: true,
				}}
			/>,
		);
		expect(screen.getByTestId("mcp-read-only-badge")).toBeInTheDocument();
		expect(screen.queryByText("read-only")).not.toBeInTheDocument();
		expect(screen.getByText("assets")).toBeInTheDocument();

		rerender(
			<McpConfigTile
				config={{
					id: "2",
					displayName: "GH",
					mcpServer: { key: "gh", name: "GitHub", tags: ["git"] },
					enabled: true,
				}}
			/>,
		);
		expect(
			screen.queryByTestId("mcp-read-only-badge"),
		).not.toBeInTheDocument();
	});
});
