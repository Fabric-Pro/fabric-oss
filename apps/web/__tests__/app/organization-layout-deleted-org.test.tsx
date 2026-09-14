/**
 * A deleted organization must not be reachable by URL (Fizzy #2462).
 *
 * The schema states the contract: a deactivated organization keeps every row it
 * owns and "is made unreachable by REFUSING it at tenant resolution instead",
 * which is why none of its ~168 related tables carries a liveness predicate.
 * The oRPC tenant middleware honoured that. This layout did not — so the shell
 * rendered (sidebar, name, logo, theme) over panels that each failed on their
 * own, and the one fact that explained it was stated nowhere.
 *
 * The redirect target is asserted, not just the fact of redirecting: `/app` is
 * load-bearing. It routes to another organization if the person has one and to
 * `/new-organization` — which carries the restore banner — if this was their
 * last. A 404 would be neither.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getOrganizationDeletedAt = vi.fn();
const getActiveOrganization = vi.fn();

const redirectMock = vi.fn((url: string) => {
	throw new Error(`REDIRECT:${url}`);
});
const notFoundMock = vi.fn(() => {
	throw new Error("NOT_FOUND");
});

vi.mock("server-only", () => ({}));

vi.mock("next/navigation", () => ({
	redirect: redirectMock,
	notFound: notFoundMock,
}));

vi.mock("@repo/database", () => ({
	getAllFlagsForOrganization: vi.fn(async () => ({})),
	getOrganizationRequireTwoFactor: vi.fn(async () => false),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getOrganizationDeletedAt: (slug: string) => getOrganizationDeletedAt(slug),
	getActiveOrganization: (slug: string) => getActiveOrganization(slug),
	getSession: vi.fn(async () => ({
		user: { id: "user-1", twoFactorEnabled: true },
	})),
	isGuestInOrg: vi.fn(async () => false),
}));

const LAYOUT = "../../app/(saas)/app/(organizations)/[organizationSlug]/layout";

async function renderLayout(slug: string) {
	const { default: Layout } = await import(LAYOUT);
	return await Layout({
		children: null,
		params: Promise.resolve({ organizationSlug: slug }),
	});
}

describe("organization layout, deleted organization", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getActiveOrganization.mockResolvedValue({
			id: "org-1",
			slug: "example-org",
			metadata: null,
		});
	});

	it("redirects to /app instead of rendering the shell", async () => {
		getOrganizationDeletedAt.mockResolvedValue(new Date("2098-01-01"));

		await expect(renderLayout("example-org")).rejects.toThrow(
			"REDIRECT:/app",
		);
		expect(notFoundMock).not.toHaveBeenCalled();
	});

	it("checks liveness BEFORE resolving the organization", async () => {
		// Order matters beyond tidiness: everything below this point — the
		// guest probe, the 2FA gate, the flag resolution, the prefetches — runs
		// against an organization that is on its way to being destroyed.
		getOrganizationDeletedAt.mockResolvedValue(new Date("2098-01-01"));

		await expect(renderLayout("example-org")).rejects.toThrow("REDIRECT:");
		expect(getActiveOrganization).not.toHaveBeenCalled();
	});

	it("leaves a live organization alone", async () => {
		getOrganizationDeletedAt.mockResolvedValue(null);

		// It gets past both gates. Whatever it does afterwards is the subject of
		// the sibling layout tests, not this one.
		await renderLayout("example-org").catch(() => undefined);

		expect(redirectMock).not.toHaveBeenCalledWith("/app");
		expect(getActiveOrganization).toHaveBeenCalledWith("example-org");
	});
});
