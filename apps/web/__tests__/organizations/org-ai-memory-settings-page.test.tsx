import { getActiveOrganization } from "@saas/auth/lib/server";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn((url: string) => {
	throw new Error(`REDIRECT:${url}`);
});
const notFoundMock = vi.fn(() => {
	throw new Error("NOT_FOUND");
});

vi.mock("next/navigation", () => ({
	redirect: redirectMock,
	notFound: notFoundMock,
}));

vi.mock("@saas/auth/lib/server", () => ({
	getActiveOrganization: vi.fn(async () => null),
}));

// Capture the org id the page hands the form — this is the tenant-isolation
// assertion: it must be the slug-derived org, never a session-derived value.
const formOrganizationId = vi.fn();
vi.mock("@saas/settings/components/OrchestratorMemoryForm", () => ({
	OrchestratorMemoryForm: ({
		organizationId,
	}: {
		organizationId: string;
	}) => {
		formOrganizationId(organizationId);
		return null;
	},
}));

vi.mock("@saas/settings/components/SettingsHero", () => ({
	SettingsHero: () => null,
}));
// Pass children through so the form below actually renders and reports its prop.
vi.mock("@saas/shared/components/SettingsList", () => ({
	SettingsList: ({ children }: { children: ReactNode }) => children,
}));

const PAGE =
	"../../app/(saas)/app/(organizations)/[organizationSlug]/settings/ai-memory/page";

describe("org AI-memory settings page", () => {
	beforeEach(() => {
		redirectMock.mockClear();
		notFoundMock.mockClear();
		formOrganizationId.mockClear();
	});

	afterEach(() => cleanup());

	it("resolves the org from the URL slug and passes ITS id to the form (multi-tab tenant isolation)", async () => {
		// The page no longer reads session.activeOrganizationId at all. It must
		// derive the org from the slug and hand exactly that org id to the form,
		// so memory is read/written under the org in the URL — not whatever org
		// another tab last activated.
		vi.mocked(getActiveOrganization).mockResolvedValueOnce({
			id: "org-acme",
			slug: "acme",
			name: "Acme",
			members: [],
		} as any);

		const module = await import(PAGE);
		const tree = await module.default({
			params: Promise.resolve({ organizationSlug: "acme" }),
		});
		render(tree);

		expect(getActiveOrganization).toHaveBeenCalledWith("acme");
		expect(formOrganizationId).toHaveBeenCalledWith("org-acme");
		expect(redirectMock).not.toHaveBeenCalled();
		expect(notFoundMock).not.toHaveBeenCalled();
	});

	it("calls notFound() when the slug does not resolve to an org", async () => {
		vi.mocked(getActiveOrganization).mockResolvedValueOnce(null);

		const module = await import(PAGE);
		// notFound() throws to halt rendering; swallow it and assert it fired.
		await module
			.default({ params: Promise.resolve({ organizationSlug: "ghost" }) })
			.catch(() => {});
		expect(notFoundMock).toHaveBeenCalled();
		expect(redirectMock).not.toHaveBeenCalled();
	});
});
