import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
	query: vi.fn(),
	get: vi.fn(),
	scope: true,
	guest: false,
	planKnown: true,
	own: false,
	shared: false,
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: unknown) => f.query(options),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { aiConfig: { resolution: { getStatus: f.get } } },
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "example-org" }),
}));
vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => f.guest,
}));
vi.mock("@saas/shared/lib/use-tenant-scope-resolved", () => ({
	useTenantScopeResolved: () => f.scope,
}));
vi.mock("@saas/settings/components/chatgpt-plan/chatgpt-plan-status", () => ({
	useChatgptPlanStatusKnown: () => f.planKnown,
	useChatgptPlanServesOwnWork: () => f.own,
	useSharedChatgptPlanServesOwnWork: () => f.shared,
}));
vi.mock("../AiGatewayWarningBanner", () => ({
	aiConfigStatusQueryKey: (id: string) => ["aiConfigStatus", id],
}));

import { PortalAiGate } from "../PortalAiGate";

function mount() {
	return render(
		<PortalAiGate fallback={<p>Configure Portal AI</p>}>
			<p>Runtime mounted</p>
		</PortalAiGate>,
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(f, {
		scope: true,
		guest: false,
		planKnown: true,
		own: false,
		shared: false,
	});
	f.query.mockReturnValue({
		data: { canResolveProvider: true },
		isPending: false,
	});
});
it("does not mount the runtime before provider status resolves", () => {
	f.query.mockReturnValue({ isPending: true });
	mount();
	expect(screen.queryByText("Runtime mounted")).toBeNull();
	expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
});
it("shows setup instead of mounting a runtime that would reject info/connect", () => {
	f.query.mockReturnValue({
		data: { canResolveProvider: false },
		isPending: false,
	});
	mount();
	expect(screen.getByText("Configure Portal AI")).toBeVisible();
	expect(screen.queryByText("Runtime mounted")).toBeNull();
});
it.each(["own", "shared"] as const)(
	"preserves %s ChatGPT plan access without an API provider",
	(key) => {
		f[key] = true;
		f.query.mockReturnValue({
			data: { canResolveProvider: false },
			isPending: false,
		});
		mount();
		expect(screen.getByText("Runtime mounted")).toBeVisible();
	},
);
it("keeps configuration queries disabled until the organization resolves", () => {
	f.scope = false;
	mount();
	expect(f.query).toHaveBeenCalledWith(
		expect.objectContaining({
			enabled: false,
			queryKey: ["aiConfigStatus", "example-org"],
		}),
	);
	expect(screen.queryByText("Runtime mounted")).toBeNull();
});
it("does not inspect host organization setup for a project guest", () => {
	f.guest = true;
	mount();
	expect(f.query).toHaveBeenCalledWith(
		expect.objectContaining({ enabled: false }),
	);
	expect(screen.getByText("Runtime mounted")).toBeVisible();
});
it("does not mislabel a failed configuration read as missing setup", () => {
	f.query.mockReturnValue({ isPending: false, isError: true });
	mount();
	expect(screen.getByText("Runtime mounted")).toBeVisible();
});
