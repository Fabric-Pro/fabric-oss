import { describe, expect, it } from "vitest";
import {
	agentContextOfFrame,
	FrameDetailSchema,
	FrameListSchema,
	frameDocumentOf,
	frameEmbedUrl,
	shareScopeLabel,
	shareScopeSentence,
} from "../frame-tool-types";

const SUMMARY = {
	frameId: "frame-1",
	title: "Delivery status",
	kind: "frame",
	updatedAt: "2026-10-14T09:00:00.000Z",
};

const DETAIL = {
	frameId: "frame-1",
	title: "Delivery status",
	description: "Open work by status.",
	kind: "frame",
	surface: "workspace",
	projectId: "project-1",
	shareScope: "WORKSPACE_AND_EMAILS",
	ownedByCaller: true,
	blocks: [{ id: "page", type: "html", content: "<p>page</p>" }],
	runtimeTools: ["fabric_list_workflows"],
	updatedAt: "2026-10-14T09:00:00.000Z",
};

describe("FrameListSchema", () => {
	it("reads what fabric_list_frames returns, keeping the fields the surfaces use", () => {
		const list = FrameListSchema.parse({
			frames: [
				{
					...SUMMARY,
					description: "x",
					surface: "artifact",
					contentType: "application/json",
					frameUrl: "/app/example-org/frames/frame-1",
				},
			],
		});

		expect(list.frames[0]).toEqual({
			...SUMMARY,
			description: "x",
			surface: "artifact",
		});
	});

	it.each([
		[
			"a frame without an id",
			{ frames: [{ ...SUMMARY, frameId: undefined }] },
		],
		["an unknown kind", { frames: [{ ...SUMMARY, kind: "deck" }] }],
		[
			"an unknown surface",
			{ frames: [{ ...SUMMARY, surface: "elsewhere" }] },
		],
		[
			"an unknown share scope",
			{ frames: [{ ...SUMMARY, shareScope: "ALL" }] },
		],
		["no list", {}],
		["a bare error text", "Frame not found."],
	])("refuses %s", (_label, payload) => {
		expect(FrameListSchema.safeParse(payload).success).toBe(false);
	});
});

describe("FrameDetailSchema", () => {
	it("reads what fabric_get_frame returns", () => {
		expect(FrameDetailSchema.parse(DETAIL)).toEqual(DETAIL);
	});

	it("keeps what produced the page, which decides whether it runs scripts", () => {
		expect(
			FrameDetailSchema.parse({ ...DETAIL, sourceRunType: "workflow" })
				.sourceRunType,
		).toBe("workflow");
		expect(FrameDetailSchema.parse(DETAIL).sourceRunType).toBeUndefined();
	});

	it("accepts a page that declares no tools and has no description or share link", () => {
		const { description: _, ...bare } = DETAIL;

		expect(
			FrameDetailSchema.parse({ ...bare, runtimeTools: [] }),
		).toMatchObject({ runtimeTools: [] });
	});

	it.each([
		["a missing tool list", { ...DETAIL, runtimeTools: undefined }],
		[
			"a block of an unknown type",
			{ ...DETAIL, blocks: [{ id: "a", type: "flash", content: "" }] },
		],
		[
			"a block without content",
			{ ...DETAIL, blocks: [{ id: "a", type: "html" }] },
		],
		["a tool that is not a name", { ...DETAIL, runtimeTools: [1] }],
	])("refuses %s", (_label, payload) => {
		expect(FrameDetailSchema.safeParse(payload).success).toBe(false);
	});
});

describe("shareScopeLabel and shareScopeSentence", () => {
	it("names the organization scope as the organization, not as 'Shared'", () => {
		expect(shareScopeLabel("WORKSPACE_AND_EMAILS")).toBe("Organization");
		expect(shareScopeSentence("WORKSPACE_AND_EMAILS", true)).toBe(
			"Shared with everyone in your organization.",
		);
		expect(shareScopeSentence("WORKSPACE_AND_EMAILS", false)).toBe(
			"Shared with everyone in your organization.",
		);
	});

	it("tells a private page's author it is theirs alone, and anyone else how it reached them", () => {
		expect(shareScopeSentence("PRIVATE", true)).toMatch(
			/only you can open it/,
		);
		expect(shareScopeSentence("PRIVATE", false)).toBe(
			"Opened with you through its project.",
		);
	});

	it.each([
		["PRIVATE", "Private"],
		["EMAILS_ONLY", "Invited"],
		["PUBLIC", "Public"],
		["PROJECT", "Project"],
	] as const)("labels %s as %s", (scope, label) => {
		expect(shareScopeLabel(scope)).toBe(label);
		expect(shareScopeSentence(scope, true).length).toBeGreaterThan(10);
	});
});

describe("agentContextOfFrame", () => {
	it("makes a Workspace its own workspace, with its project", () => {
		expect(
			agentContextOfFrame({
				frameId: "frame-1",
				surface: "workspace",
				projectId: "project-1",
			}),
		).toEqual({
			surface: "workspace",
			workspaceId: "frame-1",
			projectId: "project-1",
		});
	});

	it("gives an artifact its surface and project, and no workspace", () => {
		expect(
			agentContextOfFrame({
				frameId: "frame-1",
				surface: "artifact",
				projectId: "project-1",
			}),
		).toEqual({
			surface: "artifact",
			workspaceId: null,
			projectId: "project-1",
		});
	});

	it("gives a frame that is neither nothing to go on", () => {
		expect(agentContextOfFrame({ frameId: "frame-1" })).toEqual({
			surface: null,
			workspaceId: null,
			projectId: null,
		});
	});
});

describe("frameEmbedUrl", () => {
	it("is always inside the organization's own routes", () => {
		expect(frameEmbedUrl("frame-1", "example-org")).toBe(
			"/app/example-org/frames/frame-1/embed",
		);
	});
});

describe("frameDocumentOf", () => {
	it("rebuilds the document a shell shows in its code view", () => {
		const document = frameDocumentOf(FrameDetailSchema.parse(DETAIL));

		expect(document).toEqual({
			version: 1,
			kind: "frame",
			title: "Delivery status",
			description: "Open work by status.",
			blocks: DETAIL.blocks,
		});
	});

	it("leaves out a description there is not", () => {
		const { description: _, ...bare } = DETAIL;

		expect(
			frameDocumentOf(FrameDetailSchema.parse(bare)),
		).not.toHaveProperty("description");
	});
});
