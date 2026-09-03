/**
 * The "who is on this flag" disclosure on the instance feature-flag console.
 *
 * A separate file from FeatureFlagsPanel.test.tsx: that file's orpc mock
 * deliberately models only the three instance-wide procedures, and widening it
 * would blur what those tests cover.
 *
 * The cases worth having are the ones where an operator could act on a wrong
 * reading — an unreadable table that looks like an empty allowlist, and a
 * truncated list that looks like the whole one.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const enrolment = (over: Record<string, unknown> = {}) => ({
	key: "PUBLISHING_SUITE",
	enabledCount: 1,
	excludedCount: 1,
	organizations: [
		{
			organizationId: "org-a",
			name: "Alpha",
			enabled: true,
			updatedAt: new Date("2026-09-01T00:00:00Z"),
		},
		{
			organizationId: "org-b",
			name: "Beta",
			enabled: false,
			updatedAt: new Date("2026-09-02T00:00:00Z"),
		},
	],
	truncated: false,
	...over,
});

let queryFn: () => Promise<unknown> = async () => enrolment();

afterEach(() => {
	queryFn = async () => enrolment();
});

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		admin: {
			featureFlags: {
				organizations: {
					queryOptions: (options: { input: { key: string } }) => ({
						queryKey: [
							["admin", "featureFlags", "organizations"],
							{ input: options.input, type: "query" },
						],
						queryFn: () => queryFn(),
					}),
				},
			},
		},
	},
}));

vi.mock("@saas/admin/lib/links", () => ({
	useAdminPath: () => (path: string) => `/app/admin${path}`,
}));

import { FlagEnrolmentDisclosure } from "../FlagEnrolmentDisclosure";

function renderDisclosure() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<FlagEnrolmentDisclosure flagKey="PUBLISHING_SUITE" />
		</QueryClientProvider>,
	);
}

describe("FlagEnrolmentDisclosure", () => {
	it("shows both counts without needing to be expanded", async () => {
		renderDisclosure();

		expect(
			await screen.findByText(/Enrolled: 1 · Excluded: 1/),
		).toBeInTheDocument();
	});

	it("keeps the list collapsed until it is asked for", async () => {
		renderDisclosure();
		await screen.findByText(/Enrolled: 1/);

		expect(
			screen.getByRole("button", { name: /Enrolled: 1/ }),
		).toHaveAttribute("aria-expanded", "false");
		// Still in the DOM — collapsing must not discard a list already
		// fetched, or re-expanding would look like a fresh load...
		expect(screen.getByText("Alpha")).not.toBeVisible();
		// ...but `hidden` takes it out of the accessibility tree, so a screen
		// reader is not read a list the button says is closed.
		expect(screen.queryByRole("link", { name: "Alpha" })).toBeNull();
	});

	it("reveals each organization and links to its admin page", async () => {
		renderDisclosure();
		await userEvent.click(
			await screen.findByRole("button", { name: /Enrolled: 1/ }),
		);

		const link = screen.getByRole("link", { name: "Alpha" });
		expect(link).toBeVisible();
		expect(link).toHaveAttribute("href", "/app/admin/organizations/org-a");
	});

	// Enabled and Disabled are different states, and an operator reading this
	// list to decide who to remove must not confuse the two.
	it("distinguishes an enrolled organization from an excluded one", async () => {
		renderDisclosure();
		await userEvent.click(
			await screen.findByRole("button", { name: /Enrolled: 1/ }),
		);

		expect(screen.getByText("Enabled")).toBeInTheDocument();
		expect(screen.getByText("Disabled")).toBeInTheDocument();
	});

	// The third state has no row and can never appear in the list, so the list
	// must say so — otherwise "not listed" reads as "excluded".
	it("says what happens to every organization that is not listed", async () => {
		renderDisclosure();
		await userEvent.click(
			await screen.findByRole("button", { name: /Enrolled: 1/ }),
		);

		expect(
			screen.getByText(/inherits the deployment-wide value/i),
		).toBeInTheDocument();
	});

	it("says when the list it is showing is not the whole list", async () => {
		queryFn = async () => enrolment({ enabledCount: 900, truncated: true });
		renderDisclosure();
		await userEvent.click(
			await screen.findByRole("button", { name: /Enrolled: 900/ }),
		);

		const line = screen.getByText(/Showing the first 2 of 901/);
		expect(line).toBeVisible();
		// Exact text, not a pattern. The counts are interpolated next to
		// punctuation, which is where a reflow silently inserts a space —
		// "of 901 . Open". A regex that tolerates whitespace would not see it.
		expect(line.textContent).toBe(
			"Showing the first 2 of 901. Open an organization's page to change its value.",
		);
	});

	it("reports nothing enrolled as exactly that, not as zero counts", async () => {
		queryFn = async () =>
			enrolment({
				enabledCount: 0,
				excludedCount: 0,
				organizations: [],
			});
		renderDisclosure();

		expect(
			await screen.findByText(/No organization overrides/i),
		).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	// The failure that matters: a read error must not render as an empty
	// allowlist, which an operator could act on believing nobody is enrolled.
	it("says the read failed rather than showing an empty allowlist", async () => {
		queryFn = async () => {
			throw new Error("db down");
		};
		renderDisclosure();

		expect(
			await screen.findByText(/Couldn't read the per-organization/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/No organization overrides/i)).toBeNull();
		expect(screen.queryByText(/Enrolled:/)).toBeNull();
	});
});
