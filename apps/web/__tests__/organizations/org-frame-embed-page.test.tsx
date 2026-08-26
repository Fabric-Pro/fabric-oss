import { getActiveOrganization } from "@saas/auth/lib/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const notFoundMock = vi.fn(() => {
	throw new Error("NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: notFoundMock }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));

// Session's active org is a DIFFERENT org (as if another tab switched) — the
// page must ignore it and resolve against the URL slug instead.
const getSessionMock = vi.fn(async () => ({
	user: { id: "u1" },
	session: { activeOrganizationId: "org-other" },
}));
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: getSessionMock } },
}));

const getFrameByIdMock = vi.fn(async () => ({ document: { slides: [] } }));
vi.mock("@repo/database", () => ({ getFrameById: getFrameByIdMock }));

vi.mock("@saas/auth/lib/server", () => ({
	getActiveOrganization: vi.fn(async () => null),
}));

vi.mock("@saas/frames/components/FrameRenderer", () => ({
	FrameRenderer: () => null,
}));

const PAGE =
	"../../app/(saas)/app/(organizations)/[organizationSlug]/frames/[frameId]/embed/page";

describe("org frame embed page", () => {
	beforeEach(() => {
		notFoundMock.mockClear();
		getFrameByIdMock.mockClear();
	});

	it("resolves the frame against the URL slug's org, not the shared session", async () => {
		vi.mocked(getActiveOrganization).mockResolvedValueOnce({
			id: "org-acme",
			slug: "acme",
		} as any);

		const module = await import(PAGE);
		await module.default({
			params: Promise.resolve({
				organizationSlug: "acme",
				frameId: "f1",
			}),
			searchParams: Promise.resolve({}),
		});

		expect(getActiveOrganization).toHaveBeenCalledWith("acme");
		// The XOR tenant filter must use the slug's org (org-acme), never the
		// session's stale active org (org-other).
		expect(getFrameByIdMock).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "f1",
				userId: "u1",
				organizationId: "org-acme",
			}),
		);
		expect(notFoundMock).not.toHaveBeenCalled();
	});
});
