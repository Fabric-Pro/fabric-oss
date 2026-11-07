import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	state: vi.fn(),
	propose: vi.fn(),
	apply: vi.fn(),
	dismiss: vi.fn(),
	get: vi.fn(),
	list: vi.fn(),
	approve: vi.fn(),
}));
vi.mock("@repo/database", async (original) => ({
	...(await original<typeof import("@repo/database")>()),
	FRAME_SURFACES: ["artifact", "workspace"],
	proposeFrameChange: m.propose,
	applyFrameChange: m.apply,
	dismissFrameChange: m.dismiss,
	getFrameChange: m.get,
	listFrameChanges: m.list,
	getFrameReviewState: m.state,
	approveFrameRevision: m.approve,
	FrameReviewError: class extends Error {
		constructor(
			readonly code: string,
			message: string,
		) {
			super(message);
		}
	},
	db: {
		organization: {
			findUnique: vi.fn().mockResolvedValue({ slug: "example-org" }),
		},
	},
}));

import { pinnedSessionHasTool } from "../project-binding";
import { brandingToolConsentSatisfied } from "../tool-eligibility";
import { createFrameTools } from "../tools/frame-tools";
import type { GatewaySession } from "../types";

const family = createFrameTools(() => false);
const session: GatewaySession = {
	sessionId: "example-session",
	userId: "example-user",
	organizationId: "example-org",
	email: "dev@example.com",
	userName: "Example",
	role: "user",
	credential: "service",
	scopes: ["frames:read", "frames:write"],
	pinnedProjectId: "example-project",
};
beforeEach(() => vi.clearAllMocks());
it("passes a signed runtime project binding into canonical review authorization", async () => {
	m.state.mockResolvedValue({ frameId: "example-frame" });
	const result = await family.handlers.get("fabric_get_frame_review")!(
		{ frameId: "example-frame" },
		session,
	);
	expect(result.isError).not.toBe(true);
	expect(m.state).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: "example-user",
			organizationId: "example-org",
			boundProjectId: "example-project",
		}),
		"example-frame",
		{},
	);
});
it("does not offer organization authoring or template discovery to pinned runtimes", () => {
	for (const name of [
		"fabric_create_frame_draft",
		"fabric_list_frame_templates",
		"fabric_create_frame_template",
		"fabric_create_frame_from_template",
	])
		expect(pinnedSessionHasTool(name)).toBe(false);
	expect(pinnedSessionHasTool("fabric_propose_frame_change")).toBe(true);
});
it("never treats general MCP read consent as exact artifact review consent", () => {
	const tool = family.definitions.find(
		(t) => t.name === "fabric_get_frame_review",
	)!;
	expect(
		brandingToolConsentSatisfied(
			{
				...session,
				credential: "organization-key",
				scopes: ["mcp:read"],
			},
			tool,
		),
	).toBe(false);
	expect(brandingToolConsentSatisfied(session, tool)).toBe(true);
});
it("rejects external project-bound and embedded page calls before reading a proposal", async () => {
	for (const extra of [
		{ projectId: "example-project", pinnedProjectId: undefined },
		{ pageProjectId: "example-project" },
	]) {
		const result = await family.handlers.get("fabric_get_frame_review")!(
			{ frameId: "example-frame" },
			{ ...session, ...extra },
		);
		expect(result.isError).toBe(true);
	}
	expect(m.state).not.toHaveBeenCalled();
});
it("refuses missing write scope before staging a change", async () => {
	const result = await family.handlers.get("fabric_propose_frame_change")!(
		{ frameId: "example-frame" },
		{ ...session, scopes: ["frames:read"] },
	);
	expect(result.isError).toBe(true);
	expect(m.propose).not.toHaveBeenCalled();
});
it("always asks for apply and approval and never declares authoring as an embedded page effect", () => {
	for (const name of [
		"fabric_apply_frame_change",
		"fabric_approve_frame_revision",
		"fabric_create_frame_template",
	])
		expect(
			family.definitions.find((t) => t.name === name)?._meta?.[
				"fabric/confirm"
			],
		).toBe(true);
});
