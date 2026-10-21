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
	user: { id: "u1", email: "u1@example.com" },
	session: { activeOrganizationId: "org-other" },
}));
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: getSessionMock } },
}));

const getAccessibleFrameByIdMock = vi.fn(
	async (_input: unknown): Promise<Record<string, unknown> | null> => ({
		userId: "u1",
		document: { slides: [] },
	}),
);
const getFrameByIdMock = vi.fn(async (_input: unknown) => null);
vi.mock("@repo/database", () => ({
	getAccessibleFrameById: getAccessibleFrameByIdMock,
	getFrameById: getFrameByIdMock,
}));

vi.mock("@saas/auth/lib/server", () => ({
	getActiveOrganization: vi.fn(async () => null),
}));

const rendererProps: Array<Record<string, unknown>> = [];
vi.mock("@saas/frames/components/FrameRenderer", () => ({
	FrameRenderer: (props: Record<string, unknown>) => {
		rendererProps.push(props);
		return null;
	},
}));

const PAGE =
	"../../app/(saas)/app/(organizations)/[organizationSlug]/frames/[frameId]/embed/page";

async function renderPage() {
	const module = await import(PAGE);
	const element = await module.default({
		params: Promise.resolve({
			organizationSlug: "acme",
			frameId: "f1",
		}),
		searchParams: Promise.resolve({}),
	});
	element.type(element.props);
}

describe("org frame embed page", () => {
	beforeEach(() => {
		notFoundMock.mockClear();
		getAccessibleFrameByIdMock.mockClear();
		getFrameByIdMock.mockClear();
		rendererProps.length = 0;
		vi.mocked(getActiveOrganization).mockResolvedValue({
			id: "org-acme",
			slug: "acme",
		} as any);
	});

	it("resolves the frame against the URL slug's org, not the shared session", async () => {
		await renderPage();

		expect(getActiveOrganization).toHaveBeenCalledWith("acme");
		// The XOR tenant filter must use the slug's org (org-acme), never the
		// session's stale active org (org-other).
		expect(getAccessibleFrameByIdMock).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "f1",
				userId: "u1",
				userEmail: "u1@example.com",
				organizationId: "org-acme",
			}),
		);
		expect(notFoundMock).not.toHaveBeenCalled();
	});

	it("answers not found for a frame the viewer may not open", async () => {
		getAccessibleFrameByIdMock.mockResolvedValueOnce(null);

		await expect(renderPage()).rejects.toThrow("NOT_FOUND");
	});

	it("keeps the scripts of the viewer's own loose frame", async () => {
		await renderPage();

		expect(rendererProps[0]).toMatchObject({ allowScripts: true });
		expect(rendererProps[0]).not.toHaveProperty("strictSandbox");
	});

	it("draws a page an unattended run wrote without its scripts, even the viewer's own", async () => {
		getAccessibleFrameByIdMock.mockResolvedValueOnce({
			userId: "u1",
			sourceRunType: "workflow",
			document: { slides: [] },
		});

		await renderPage();

		expect(rendererProps[0]).toMatchObject({ allowScripts: false });
	});

	it("leaves the scripts of a page written in a chat alone", async () => {
		getAccessibleFrameByIdMock.mockResolvedValueOnce({
			userId: "u1",
			sourceRunType: "direct-chat",
			surface: "workspace",
			document: { slides: [] },
		});

		await renderPage();

		expect(rendererProps[0]).toMatchObject({ allowScripts: true });
	});
});
