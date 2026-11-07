import { renderToString } from "react-dom/server";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/config", () => ({
	config: {
		dashboard: { inviteWelcomeWidget: { enabled: false } },
		prompts: { enabled: true },
	},
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { name: "Dev Example" } }),
}));
vi.mock("@saas/shared/components/IncidentChip", () => ({
	IncidentChip: () => null,
}));
vi.mock("../../lib/greetings", () => ({
	DASHBOARD_GREETING_COUNT: 6,
	getDashboardGreeting: (_name: unknown, index: number) =>
		`greeting-${index}`,
}));

import { DashboardHero } from "../DashboardHero";

describe("DashboardHero", () => {
	beforeEach(() => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
	});

	it("uses a deterministic first render before changing the greeting after mount", async () => {
		const markup = renderToString(
			<DashboardHero
				organizationName="Example Workspace"
				organizationSlug="example-org"
				isOrganizationAdmin={false}
				onRefresh={vi.fn()}
				refreshing={false}
			/>,
		);
		expect(markup).toContain("greeting-0");
		expect(Math.random).not.toHaveBeenCalled();

		render(
			<DashboardHero
				organizationName="Example Workspace"
				organizationSlug="example-org"
				isOrganizationAdmin={false}
				onRefresh={vi.fn()}
				refreshing={false}
			/>,
		);

		await waitFor(() => {
			expect(
				screen.getByRole("heading", { name: "greeting-5" }),
			).toBeInTheDocument();
		});
	});
});
