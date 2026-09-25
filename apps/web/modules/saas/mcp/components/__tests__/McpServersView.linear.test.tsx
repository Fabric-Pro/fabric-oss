import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		mcp: {
			configs: {
				list: vi.fn().mockResolvedValue([]),
				upsert: vi.fn(),
				delete: vi.fn(),
			},
			registry: {
				list: vi.fn().mockResolvedValue([
					{
						id: "srv-github",
						key: "github-remote",
						name: "GitHub",
						description: "GitHub remote MCP server",
						isSystemProvided: true,
						transport: "HTTP",
					},
					{
						id: "srv-linear",
						key: "linear-remote",
						name: "Linear",
						description: "Linear remote MCP server",
						isSystemProvided: true,
						transport: "HTTP",
					},
				]),
			},
			tools: {
				list: vi.fn().mockResolvedValue({ tools: [] }),
			},
		},
	},
}));

vi.mock("../hooks/useMcpConnection", () => ({
	useMcpConnection: () => ({
		checkOAuthStatuses: vi.fn(),
		oauthStatuses: {},
		isCheckingOAuth: false,
	}),
}));

import type { FeatureFlagKey } from "@repo/utils/feature-flag-registry";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { McpServersView } from "../McpServersView";

function renderComponent(flags: Partial<Record<FeatureFlagKey, boolean>>) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
		},
	});

	return render(
		<QueryClientProvider client={queryClient}>
			<FeatureFlagProvider
				value={flags as Record<FeatureFlagKey, boolean>}
			>
				<McpServersView organizationId="org-example" />
			</FeatureFlagProvider>
		</QueryClientProvider>,
	);
}

describe("McpServersView — Linear Remote visibility", () => {
	it("hides Linear Remote from available servers when LINEAR_INTEGRATION is false", async () => {
		renderComponent({ LINEAR_INTEGRATION: false });

		const addRegistryBtn = await screen.findByRole("button", {
			name: /Add from Registry/i,
		});
		addRegistryBtn.click();

		await screen.findByText("GitHub");
		expect(screen.queryByText("Linear")).not.toBeInTheDocument();
	});

	it("shows Linear Remote when LINEAR_INTEGRATION is true", async () => {
		renderComponent({ LINEAR_INTEGRATION: true });

		const addRegistryBtn = await screen.findByRole("button", {
			name: /Add from Registry/i,
		});
		addRegistryBtn.click();

		await screen.findByText("Linear");
	});
});
