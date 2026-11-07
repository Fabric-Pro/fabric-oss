import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), canRead: vi.fn() }));
vi.mock("../prisma/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../prisma/client")>()),
	db: { agentWorkspaceFile: { findFirst: mocks.findFirst } },
}));
vi.mock("../prisma/queries/report-frame-access", () => ({
	canReadReportDerivedFrame: mocks.canRead,
	canWriteReportDerivedFrame: vi.fn(),
}));

import { getFrameById } from "../prisma/queries/frames";

const actor = {
	id: "example-frame",
	userId: "example-user",
	organizationId: "example-org",
};
const document = {
	version: 1,
	kind: "frame",
	title: "Example",
	blocks: [{ id: "page", type: "html", content: "<main>Example</main>" }],
};
function row(
	content: Record<string, unknown>,
	sourceRunType: string | null = "REPORT_EXECUTION",
) {
	return {
		id: actor.id,
		userId: actor.userId,
		organizationId: actor.organizationId,
		fileType: "FRAME",
		sourceRunType,
		content: JSON.stringify(content),
		metadata: {},
		updatedAt: new Date(),
		createdAt: new Date(),
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.canRead.mockResolvedValue(true);
});

describe("authoritative report presentation reads", () => {
	it.each([
		{ ...document, presentation: "INTERFACE" },
		{
			...document,
			presentation: "INTERFACE",
			metadata: { sourceRunType: "MCP_GATEWAY" },
		},
		{ ...document },
	])(
		"clamps historical report documents independently of authored metadata: %j",
		async (content) => {
			mocks.findFirst.mockResolvedValue(row(content));
			const frame = await getFrameById(actor);
			expect(frame?.presentation).toBe("DOCUMENT");
			expect(frame?.document.presentation).toBe("DOCUMENT");
			expect(mocks.canRead).toHaveBeenCalledWith(
				expect.objectContaining({ sourceRunType: "REPORT_EXECUTION" }),
				actor,
			);
		},
	);
	it("preserves non-report authored layout and legacy omission", async () => {
		mocks.findFirst.mockResolvedValue(
			row({ ...document, presentation: "INTERFACE" }, "MCP_GATEWAY"),
		);
		expect((await getFrameById(actor))?.document.presentation).toBe(
			"INTERFACE",
		);
		mocks.findFirst.mockResolvedValue(row(document, null));
		expect((await getFrameById(actor))?.document).not.toHaveProperty(
			"presentation",
		);
	});
	it("does not bypass report access when normalizing historical content", async () => {
		mocks.findFirst.mockResolvedValue(
			row({ ...document, presentation: "INTERFACE" }),
		);
		mocks.canRead.mockResolvedValue(false);
		expect(await getFrameById(actor)).toBeNull();
	});
});
