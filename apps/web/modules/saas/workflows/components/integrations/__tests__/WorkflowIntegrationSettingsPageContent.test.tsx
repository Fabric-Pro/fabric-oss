/**
 * Pins the header back-button on the workflow integration settings page.
 *
 * Fizzy #2504 renamed this button from "Back to Integrations" to "Back to
 * Connections". The label was the bug; the ROUTE was always correct --
 * `settingsBasePath` points at `/settings/integrations`, which redirects and
 * lands the user on `/connections`. So the href is asserted alongside the
 * name: a later edit that "fixes" the route to match the new wording would
 * break that redirect chain, and this test is what catches it.
 *
 * The page is large but the header only needs the plugin registry and the two
 * data boundaries, so three boundary mocks are enough: `orpcClient`,
 * `@tanstack/react-query`, and the integration plugin registry. `next/navigation`
 * and `next-intl` are mocked globally in `apps/web/vitest.setup.ts`.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { mockUseQuery } = vi.hoisted(() => ({
	mockUseQuery: vi.fn(() => ({ data: undefined })),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		workflows: { integrations: { list: vi.fn() } },
		aiConfig: { resolution: { getStatus: vi.fn() } },
		users: { firecrawl: { getConfig: vi.fn() } },
		integrations: { oauth: { disconnect: vi.fn() } },
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => mockUseQuery(...args),
	useMutation: () => ({
		mutate: vi.fn(),
		mutateAsync: vi.fn().mockResolvedValue(undefined),
		isPending: false,
		reset: vi.fn(),
	}),
	useQueryClient: () => ({
		invalidateQueries: vi.fn(),
		refetchQueries: vi.fn(),
	}),
}));

// The real registry eagerly pulls in every provider plugin (and each one's
// settings component). The header only needs one plugin to exist, so stub the
// registry at the boundary and keep the render tiny.
vi.mock("../../../lib/plugins", () => ({
	getAllIntegrations: () => [
		{
			type: "GITHUB",
			label: "GitHub",
			description: "Source code management",
			category: "web",
			actions: [],
			formFields: [],
		},
		{
			type: "LINEAR",
			label: "Linear",
			description: "Issue tracking",
			category: "productivity",
			actions: [],
			formFields: [],
		},
	],
}));

import type { FeatureFlagKey } from "@repo/utils/feature-flag-registry";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { WorkflowIntegrationSettingsPageContent } from "../WorkflowIntegrationSettingsPageContent";

function renderPage(
	settingsBasePath: string,
	flags: Partial<Record<FeatureFlagKey, boolean>> = {
		LINEAR_INTEGRATION: false,
	},
) {
	return render(
		<FeatureFlagProvider value={flags as Record<FeatureFlagKey, boolean>}>
			<WorkflowIntegrationSettingsPageContent
				organizationId="org-example"
				settingsBasePath={settingsBasePath}
			/>
		</FeatureFlagProvider>,
	);
}

describe("WorkflowIntegrationSettingsPageContent — header back link", () => {
	it("names the back link 'Back to Connections' and keeps it routed to settingsBasePath", () => {
		renderPage("/app/example-org/settings/integrations");

		const backLink = screen.getByRole("link", {
			name: /Back to Connections/i,
		});
		expect(backLink).toBeInTheDocument();
		// Route pin: `settings/integrations` redirects to `/connections`.
		// Renaming the label must not drag the href along with it.
		expect(backLink).toHaveAttribute(
			"href",
			"/app/example-org/settings/integrations",
		);
	});

	it("passes the settingsBasePath prop through verbatim", () => {
		renderPage("/app/other-org/settings/integrations");

		expect(
			screen.getByRole("link", { name: /Back to Connections/i }),
		).toHaveAttribute("href", "/app/other-org/settings/integrations");
	});
});

describe("WorkflowIntegrationSettingsPageContent — Linear visibility", () => {
	it("hides Linear from integrations list when LINEAR_INTEGRATION is false", () => {
		renderPage("/app/example-org/settings/integrations", {
			LINEAR_INTEGRATION: false,
		});

		expect(screen.queryByText("Linear")).not.toBeInTheDocument();
		expect(screen.getAllByText("GitHub").length).toBeGreaterThan(0);
	});

	it("shows Linear when LINEAR_INTEGRATION is true", () => {
		renderPage("/app/example-org/settings/integrations", {
			LINEAR_INTEGRATION: true,
		});

		expect(screen.getAllByText("Linear").length).toBeGreaterThan(0);
	});
});
