/**
 * Regression guard for the active-project "Edit Project" crash (React #185 —
 * "Maximum update depth exceeded").
 *
 * `BasicInfoStep` passes `WizardBacklogCard` an inline `onChange={(patch) =>
 * updateFormData(patch)}` that is a NEW function every render. The card's
 * `fetchContainers` was `useCallback(..., [effectiveOrgId, onChange])`, so it
 * was recreated every render, which made the "fetch containers" effect
 * (keyed on `[mcpConfigId, fetchContainers]`) re-run every render. With a
 * backlog already connected (`mcpConfigId` set — true for an active project
 * being edited), `fetchContainers` calls `onChange({...})`, re-rendering the
 * parent → new `onChange` → new `fetchContainers` → effect re-runs → onChange →
 * … an infinite loop. Empty drafts / new projects have no `mcpConfigId`, so
 * they never entered the loop — which is why only active-project EDIT crashed.
 *
 * The fix reads `onChange` through a ref so the effects key only on real
 * triggers. This test renders the card with a connected backlog and an
 * intentionally-unstable parent `onChange`: it throws #185 against the pre-fix
 * code and renders cleanly with the fix.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		organizationName: "Acme",
	}),
	useContextPath: () => "settings/mcp",
}));

vi.mock("@saas/settings/hooks/use-settings-return-url", () => ({
	useSettingsReturnUrl: () => (url: string) => url,
}));

// Returns no tools → fetchContainers bails after its synchronous onChange reset
// (which is the call that drives the loop), so we exercise the loop path without
// needing a full MCP tool schema.
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		mcp: {
			tools: { list: vi.fn(async () => ({ tools: [], errors: [] })) },
		},
	},
}));

vi.mock("../../pm-tool-select", () => ({
	PMToolSelect: () => <div data-testid="pm-tool-select-stub" />,
}));

import { WizardBacklogCard } from "../WizardBacklogCard";

type BacklogValue = {
	projectManagementMcpConfigId: string | null;
	projectManagementMcpServerId: string | null;
	projectManagementContainerId: string | null;
	projectManagementContainerName: string | null;
	projectManagementAdditionalContext: Record<string, unknown> | null;
	projectManagementDetectedType: string | null;
};

// Mirrors BasicInfoStep: `onChange` is a brand-new arrow on every render, and it
// feeds patches back into the `value` the card receives.
function Harness({ initialConfigId }: { initialConfigId: string | null }) {
	const [value, setValue] = useState<BacklogValue>({
		projectManagementMcpConfigId: initialConfigId,
		projectManagementMcpServerId: initialConfigId ? "srv-1" : null,
		projectManagementContainerId: null,
		projectManagementContainerName: null,
		projectManagementAdditionalContext: null,
		projectManagementDetectedType: null,
	});
	const onChange = (patch: Partial<BacklogValue>) =>
		setValue((v) => ({ ...v, ...patch }));
	return (
		<WizardBacklogCard
			value={value}
			onChange={onChange}
			organizationId={null}
		/>
	);
}

describe("WizardBacklogCard — no render loop with an unstable parent onChange", () => {
	it("renders with a CONNECTED backlog without an infinite update loop (#185)", async () => {
		// Pre-fix this render throws "Maximum update depth exceeded".
		expect(() => render(<Harness initialConfigId="cfg-1" />)).not.toThrow();
		expect(screen.getByTestId("pm-tool-select-stub")).toBeInTheDocument();
		// Wait for the container fetch (mcpConfigId is set) to fully settle so no
		// async runs after the test / jsdom env tears down. The empty-tools mock
		// resolves to this error message.
		expect(
			await screen.findByText(/No tools available from this MCP server/i),
		).toBeInTheDocument();
	});

	it("renders with NO backlog connected", async () => {
		expect(() => render(<Harness initialConfigId={null} />)).not.toThrow();
		await waitFor(() => {
			expect(
				screen.getByTestId("pm-tool-select-stub"),
			).toBeInTheDocument();
		});
	});
});
