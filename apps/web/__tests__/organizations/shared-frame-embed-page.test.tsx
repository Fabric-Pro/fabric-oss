import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getFrame: vi.fn(),
	notFound: vi.fn(() => {
		throw new Error("NOT_FOUND");
	}),
}));

vi.mock("@repo/database", () => ({ getFrameByShareToken: mocks.getFrame }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@saas/frames/components/FrameRenderer", () => ({
	FrameRenderer: () => null,
}));

import SharedFrameEmbedPage from "../../app/share/frame/[token]/embed/page";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getFrame.mockResolvedValue({
		userId: "author",
		projectId: null,
		surface: null,
		sourceRunType: "direct-chat",
		document: { version: 1, kind: "frame", title: "Example", blocks: [] },
	});
});

const renderPage = () =>
	SharedFrameEmbedPage({
		params: Promise.resolve({ token: "example-token" }),
		searchParams: Promise.resolve({}),
	});

describe("public frame embeds", () => {
	it("keeps the scripts of a loose frame, even without a project or surface", async () => {
		const element = await renderPage();

		expect(mocks.getFrame).toHaveBeenCalledWith("example-token");
		expect(element.props).toMatchObject({
			embedded: true,
			allowScripts: true,
		});
	});

	it("keeps unattended public pages static inside the strict sandbox", async () => {
		mocks.getFrame.mockResolvedValueOnce({
			sourceRunType: "workflow",
			document: {
				version: 1,
				kind: "frame",
				title: "Example",
				blocks: [],
			},
		});

		expect((await renderPage()).props).toMatchObject({
			allowScripts: false,
		});
	});

	it("does not render an unavailable share", async () => {
		mocks.getFrame.mockResolvedValueOnce(null);

		await expect(renderPage()).rejects.toThrow("NOT_FOUND");
	});
});
