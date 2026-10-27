import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	permission: vi.fn(),
	getFrame: vi.fn(),
	update: vi.fn(),
}));
vi.mock("@repo/database", async (original) => ({
	...(await original<typeof import("@repo/database")>()),
	canUpdateOrganizationFrames: m.permission,
	getFrameById: m.getFrame,
	updateFrame: m.update,
}));

import { createFrameTools } from "../tools/frame-tools";
import type { GatewaySession } from "../types";

const session: GatewaySession = {
	sessionId: "example-session",
	userId: "example-user",
	organizationId: "example-org",
	email: "dev@example.com",
	userName: "Example User",
	role: "user",
	credential: "service",
	scopes: ["*"],
	createdAt: new Date(),
	expiresAt: new Date(),
};
const args = {
	frameId: "example-frame",
	blockId: "example-block",
	edits: [{ oldText: "hello", newText: "linked" }],
};
const frame = {
	id: args.frameId,
	title: "Example",
	document: {
		blocks: [{ id: args.blockId, type: "html", content: "hello" }],
	},
	updatedAt: new Date("2026-10-25T00:00:00Z"),
};
const handler = createFrameTools(() => true).handlers.get(
	"fabric_edit_frame_block",
);
beforeEach(() => {
	vi.clearAllMocks();
	m.permission.mockResolvedValue(true);
	m.getFrame.mockImplementation(async ({ organizationId }) =>
		organizationId === "example-org" ? frame : null,
	);
	m.update.mockResolvedValue(frame);
});
describe("block edit gateway handler with the real frame service", () => {
	it("refuses another organization through frameWriteRefusal and the owner-scoped read", async () => {
		const result = await handler?.(args, {
			...session,
			organizationId: "example-other-org",
		});
		expect(result).toMatchObject({ isError: true });
		expect(m.permission).toHaveBeenCalledWith(
			session.userId,
			"example-other-org",
		);
		expect(m.getFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "example-other-org",
				userId: session.userId,
			}),
		);
		expect(m.update).not.toHaveBeenCalled();
	});
	it("refuses a user without edit permission through frameWriteRefusal", async () => {
		m.permission.mockResolvedValue(false);
		expect(await handler?.(args, session)).toMatchObject({
			isError: true,
			content: [
				expect.objectContaining({
					text: expect.stringContaining("No permission"),
				}),
			],
		});
		expect(m.getFrame).not.toHaveBeenCalled();
		expect(m.update).not.toHaveBeenCalled();
	});
	it("passes acting identity through to the shared update and returns a small receipt", async () => {
		const result = await handler?.(args, session);
		expect(result?.isError).not.toBe(true);
		expect(m.update).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: session.userId,
				organizationId: session.organizationId,
				expectedUpdatedAt: frame.updatedAt,
			}),
		);
		expect(JSON.stringify(result)).not.toContain("hello");
	});
});
