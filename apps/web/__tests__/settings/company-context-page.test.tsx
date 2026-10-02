/**
 * Organization settings → Company context (Fizzy #2719): the server page and
 * its breadcrumb.
 *
 * With the COMPANY_CONTEXT gate off for the organization in the URL, the page
 * does not exist — the menu entry's absence is pinned in
 * `org-account-settings-menu.test.tsx`. With it on, the page hands the panel
 * the organization resolved from the slug, never a session default.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	getActiveOrganization: vi.fn(),
	isFeatureEnabled: vi.fn(),
	pathname: "/app/example-org/settings/company-context",
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: (key: string, organizationId?: string) =>
		state.isFeatureEnabled(key, organizationId),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getActiveOrganization: (slug: string) => state.getActiveOrganization(slug),
}));

vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("NEXT_NOT_FOUND");
	},
	usePathname: () => state.pathname,
}));

vi.mock("next-intl/server", () => ({
	getTranslations: async (namespace: string) => (key: string) =>
		`${namespace}.${key}`,
}));

vi.mock("@saas/settings/components/SettingsHero", () => ({
	SettingsHero: ({
		title,
		description,
	}: {
		title: string;
		description: string;
	}) => (
		<header>
			<h1>{title}</h1>
			<p>{description}</p>
		</header>
	),
}));

vi.mock(
	"@saas/organizations/components/company-context/CompanyContextPanel",
	() => ({
		CompanyContextPanel: ({
			organizationId,
			organizationSlug,
		}: {
			organizationId: string;
			organizationSlug: string;
		}) => (
			<div
				data-testid="company-context-panel"
				data-organization-id={organizationId}
				data-organization-slug={organizationSlug}
			/>
		),
	}),
);

vi.mock("@saas/shared/components/PageBreadcrumbs", () => ({
	PageBreadcrumbs: ({ items }: { items: { label: string }[] }) => (
		<nav aria-label="Breadcrumb">
			{items.map((item) => (
				<span key={item.label}>{item.label}</span>
			))}
		</nav>
	),
}));

vi.mock("@saas/shared/components/TopRightControls", () => ({
	TopRightControls: () => null,
}));

vi.mock("@saas/settings/components/SettingsReturnBanner", () => ({
	SettingsReturnBanner: () => null,
}));

import CompanyContextPage from "../../app/(saas)/app/(organizations)/[organizationSlug]/settings/company-context/page";
import { OrgSettingsLayoutClient } from "../../modules/saas/settings/components/OrgSettingsLayoutClient";

function renderPage() {
	return CompanyContextPage({
		params: Promise.resolve({ organizationSlug: "example-org" }),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	state.getActiveOrganization.mockResolvedValue({
		id: "org-1",
		name: "Example Org",
		slug: "example-org",
	});
	state.isFeatureEnabled.mockResolvedValue(true);
});

describe("company context settings page", () => {
	it("404s while the gate is off for the organization", async () => {
		state.isFeatureEnabled.mockResolvedValue(false);

		await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
		expect(state.isFeatureEnabled).toHaveBeenCalledWith(
			"COMPANY_CONTEXT",
			"org-1",
		);
	});

	it("404s for an organization the viewer cannot resolve", async () => {
		state.getActiveOrganization.mockResolvedValue(null);

		await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
		expect(state.isFeatureEnabled).not.toHaveBeenCalled();
	});

	it("renders the panel for the organization the URL names", async () => {
		render(await renderPage());

		expect(state.getActiveOrganization).toHaveBeenCalledWith("example-org");
		expect(
			screen.getByRole("heading", {
				name: "settings.companyContext.title",
			}),
		).toBeInTheDocument();
		const panel = screen.getByTestId("company-context-panel");
		expect(panel).toHaveAttribute("data-organization-id", "org-1");
		expect(panel).toHaveAttribute("data-organization-slug", "example-org");
	});
});

describe("organization settings breadcrumb", () => {
	it("ends with the page title on the company context page", () => {
		state.pathname = "/app/example-org/settings/company-context";

		render(
			<OrgSettingsLayoutClient
				organizationSlug="example-org"
				organizationName="Example Org"
			>
				<div />
			</OrgSettingsLayoutClient>,
		);

		const breadcrumb = screen.getByRole("navigation", {
			name: "Breadcrumb",
		});
		expect(breadcrumb).toHaveTextContent(
			"Example OrgSettingsCompany context",
		);
	});
});
