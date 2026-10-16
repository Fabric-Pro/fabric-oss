/**
 * Who can open a page, going back to an earlier version of it, and forking it.
 *
 * The cases assert on the write: a refusal that has already changed the share
 * scope, invited someone, reverted the page or created the copy is not a
 * refusal. Who may open which page is the database's (its own tests cover the
 * owner, member, invitee and outsider matrix); what these pin is what the
 * service adds around it. The organization's sharing policy (public links,
 * invitation domains) is `shareFrame`'s, and a copy's project placement is
 * `duplicateFrame`'s, each pinned in `@repo/database`; here they are faked, and
 * what is pinned is that the service hands them the call and relays their
 * refusals.
 *
 * Run with: pnpm --filter @repo/temporal test __tests__/frame-service-sharing
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	canCreateOrganizationFrames: vi.fn(),
	canUpdateOrganizationFrames: vi.fn(),
	duplicateFrame: vi.fn(),
	getFrameById: vi.fn(),
	getAccessibleFrameById: vi.fn(),
	shareFrame: vi.fn(),
	revertFrameToVersion: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		canCreateOrganizationFrames: mocks.canCreateOrganizationFrames,
		canUpdateOrganizationFrames: mocks.canUpdateOrganizationFrames,
		duplicateFrame: mocks.duplicateFrame,
		getFrameById: mocks.getFrameById,
		getAccessibleFrameById: mocks.getAccessibleFrameById,
		shareFrame: mocks.shareFrame,
		revertFrameToVersion: mocks.revertFrameToVersion,
	};
});

import { FramePlacementRefusedError } from "@repo/database";
import { withAgentToolRuntime } from "../src/activities/shared/agent-tool-runtime";
import {
	duplicateFirstClassFrame,
	restoreFirstClassFrameVersion,
	shareFirstClassFrame,
} from "../src/activities/shared/frame-service";

const OWNER = "user-1";
const OTHER = "user-2";
const ORG = "org-1";
const PROJECT = "project-1";

const blocks = [{ id: "page", type: "html", content: "<p>page</p>" }];

function frameRecord(overrides: Record<string, unknown> = {}) {
	return {
		id: "frame-1",
		userId: OWNER,
		title: "Team poll",
		description: "A poll",
		kind: "frame",
		contentType: "application/vnd.fabric.frame",
		shareToken: null,
		isPublic: false,
		shareScope: "PRIVATE",
		surface: "workspace",
		projectId: undefined,
		runtimeTools: ["fabric_list_frames"],
		version: 3,
		document: { blocks, theme: { name: "paper" } },
		updatedAt: new Date("2026-10-14T10:00:00Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	process.env.NEXT_PUBLIC_SITE_URL = "https://app.example.com";
	mocks.canCreateOrganizationFrames.mockResolvedValue(true);
	mocks.canUpdateOrganizationFrames.mockResolvedValue(true);
	mocks.getFrameById.mockResolvedValue(frameRecord());
	mocks.getAccessibleFrameById.mockResolvedValue(frameRecord());
	mocks.shareFrame.mockImplementation(
		async (input: { scope?: string; emails?: string[] }) => ({
			ok: true,
			scope: input.scope,
			...(input.scope === "PUBLIC" ? { shareToken: "token-1" } : {}),
			invited: input.emails ?? [],
			grants: [],
		}),
	);
	mocks.revertFrameToVersion.mockResolvedValue({ success: true });
	mocks.duplicateFrame.mockImplementation(async (input) =>
		frameRecord({
			id: "frame-2",
			userId: input.userId,
			title: input.title ?? `${input.original.title} (Copy)`,
			surface: input.original.surface,
			projectId: input.original.projectId,
			runtimeTools: input.runtimeTools ?? [],
			shareScope: "PRIVATE",
		}),
	);
});

const share = (args: Record<string, unknown>) =>
	shareFirstClassFrame({
		args: { frameId: "frame-1", ...args },
		userId: OWNER,
		organizationId: ORG,
	});

describe("shareFirstClassFrame: who can open the page", () => {
	it("makes the page public when no scope is named, and answers with the link", async () => {
		const result = await share({});

		expect(mocks.shareFrame).toHaveBeenCalledWith({
			frameId: "frame-1",
			userId: OWNER,
			organizationId: ORG,
			scope: "PUBLIC",
			emails: [],
		});
		expect(result).toMatchObject({
			frameId: "frame-1",
			scope: "PUBLIC",
			invited: [],
			shareUrl: "https://app.example.com/share/frame/token-1",
		});
	});

	it("gives no public link for a scope the command made no link for", async () => {
		for (const scope of [
			"WORKSPACE_AND_EMAILS",
			"EMAILS_ONLY",
			"PRIVATE",
		]) {
			const result = await share({
				scope,
				...(scope === "PRIVATE" ? {} : { emails: ["a@example.com"] }),
			});

			expect(result, scope).toMatchObject({ scope });
			expect(
				(result as { shareUrl?: string }).shareUrl,
				scope,
			).toBeUndefined();
		}
	});

	it("refuses a scope it does not know, without asking the command", async () => {
		const result = await share({ scope: "EVERYONE" });

		expect(result).toEqual({
			error: "`scope` must be one of: PUBLIC, WORKSPACE_AND_EMAILS, EMAILS_ONLY, PRIVATE.",
		});
		expect(mocks.shareFrame).not.toHaveBeenCalled();
	});

	it("hands the command each address once, lower-cased, and answers with the ones it invited", async () => {
		mocks.shareFrame.mockResolvedValue({
			ok: true,
			scope: "EMAILS_ONLY",
			invited: ["new@example.com", "other@example.com"],
			grants: [],
		});

		const result = await share({
			scope: "EMAILS_ONLY",
			emails: [
				"New@Example.com",
				" new@example.com ",
				"old@example.com",
				"other@example.com",
			],
		});

		expect(mocks.shareFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "EMAILS_ONLY",
				emails: [
					"new@example.com",
					"old@example.com",
					"other@example.com",
				],
			}),
		);
		expect(result).toMatchObject({
			invited: ["new@example.com", "other@example.com"],
		});
	});

	it.each([
		[
			"public_sharing_disabled",
			"Public sharing is disabled for this organization.",
		],
		[
			"email_domain_not_allowed",
			"This organization allows invitations only to the domains example.com.",
		],
		[
			"emails_need_an_inviting_scope",
			"Emails cannot be invited while the frame is public. Share it with invited emails first.",
		],
		["frame_not_found", "Frame not found."],
	])(
		"relays the command's refusal (%s) as its own sentence",
		async (reason, message) => {
			mocks.shareFrame.mockResolvedValue({ ok: false, reason, message });

			const result = await share({
				scope: "EMAILS_ONLY",
				emails: ["lee@example.com"],
			});

			expect(result).toEqual({ error: message });
		},
	);

	it.each([
		["a string", "lee@example.com"],
		[
			"an entry that is not an address",
			["lee@example.com", "not-an-address"],
		],
		["an entry that is not a string", ["lee@example.com", 7]],
		[
			"more than 50 addresses",
			Array.from({ length: 51 }, (_, index) => `p${index}@example.com`),
		],
	])(
		"refuses emails given as %s, without asking the command",
		async (_, emails) => {
			const result = await share({ scope: "EMAILS_ONLY", emails });

			expect(result).toHaveProperty("error");
			expect(mocks.shareFrame).not.toHaveBeenCalled();
		},
	);

	it("refuses a caller who cannot update frames, before anything is read or changed", async () => {
		mocks.canUpdateOrganizationFrames.mockResolvedValue(false);

		const result = await share({ scope: "PRIVATE" });

		expect(result).toEqual({
			error: "No permission to update frames in this organization.",
		});
		expect(mocks.shareFrame).not.toHaveBeenCalled();
	});

	it("answers not found, and invites no one, for a page that is not the caller's", async () => {
		mocks.getFrameById.mockResolvedValue(null);

		const result = await share({
			scope: "EMAILS_ONLY",
			emails: ["lee@example.com"],
		});

		expect(result).toEqual({ error: "Frame not found." });
		expect(mocks.shareFrame).not.toHaveBeenCalled();
	});

	it("answers not found for a page outside the project the run is held to", async () => {
		mocks.getFrameById.mockResolvedValue(
			frameRecord({ projectId: "project-2" }),
		);

		const result = await withAgentToolRuntime(
			{
				invoke: async () => undefined,
				projectScope: {
					projectId: PROJECT,
					userId: OWNER,
					organizationId: ORG,
				},
			},
			() => share({ scope: "PRIVATE" }),
		);

		expect(result).toEqual({ error: "Frame not found." });
		expect(mocks.shareFrame).not.toHaveBeenCalled();
	});
});

describe("restoreFirstClassFrameVersion", () => {
	const restore = (args: Record<string, unknown>, userId: string = OWNER) =>
		restoreFirstClassFrameVersion({
			args: { frameId: "frame-1", ...args },
			userId,
			userEmail: "owner@example.com",
			organizationId: ORG,
		});

	it("puts the page back for its owner and says which version it is back at", async () => {
		const result = await restore({ version: 2 });

		expect(mocks.revertFrameToVersion).toHaveBeenCalledWith({
			frameId: "frame-1",
			userId: OWNER,
			organizationId: ORG,
			toVersion: 2,
		});
		expect(result).toMatchObject({
			frameId: "frame-1",
			restoredVersion: 2,
			surface: "workspace",
			runtimeTools: ["fabric_list_frames"],
		});
	});

	it("tells what the page declares once it is restored, which restoring does not change", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			frameRecord({ runtimeTools: ["fabric_list_workflows"] }),
		);

		const result = await restore({ version: 1 });

		expect(result).toMatchObject({
			runtimeTools: ["fabric_list_workflows"],
		});
	});

	it("refuses someone who can open the page but does not own it, and points them to a fork", async () => {
		const result = await restore({ version: 2 }, OTHER);

		expect(result).toEqual({
			error: "Only the page's owner can restore a version. Fork it with fabric_duplicate_frame to change your own copy.",
		});
		expect(mocks.revertFrameToVersion).not.toHaveBeenCalled();
	});

	it.each([
		["missing", undefined],
		["zero", 0],
		["negative", -1],
		["fractional", 1.5],
		["a string", "2"],
	])(
		"refuses a version that is %s, without touching the page",
		async (_, version) => {
			const result = await restore({ version });

			expect(result).toHaveProperty("error");
			expect(mocks.revertFrameToVersion).not.toHaveBeenCalled();
		},
	);

	it("refuses a caller who cannot update frames", async () => {
		mocks.canUpdateOrganizationFrames.mockResolvedValue(false);

		const result = await restore({ version: 2 });

		expect(result).toEqual({
			error: "No permission to update frames in this organization.",
		});
		expect(mocks.revertFrameToVersion).not.toHaveBeenCalled();
	});

	it("answers not found for a page the caller cannot open", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(null);

		expect(await restore({ version: 2 })).toEqual({
			error: "Frame not found.",
		});
		expect(mocks.revertFrameToVersion).not.toHaveBeenCalled();
	});

	it("reports a version that does not exist as the database says it", async () => {
		mocks.revertFrameToVersion.mockResolvedValue({
			success: false,
			error: "Version 9 not found",
		});

		expect(await restore({ version: 9 })).toEqual({
			error: "Version 9 not found",
		});
	});
});

describe("duplicateFirstClassFrame", () => {
	const duplicate = (
		args: Record<string, unknown> = {},
		extra: Record<string, unknown> = {},
		userId: string = OTHER,
	) =>
		duplicateFirstClassFrame({
			args: { frameId: "frame-1", ...args },
			userId,
			userEmail: "other@example.com",
			organizationId: ORG,
			...extra,
		});

	it("copies the page with the same command the app's duplicate uses, as the caller", async () => {
		const result = await duplicate();

		expect(mocks.duplicateFrame).toHaveBeenCalledWith({
			original: frameRecord(),
			userId: OTHER,
			organizationId: ORG,
			title: undefined,
			runtimeTools: undefined,
			conversationId: undefined,
			sourceRunType: undefined,
			sourceRunId: undefined,
		});
		expect(result).toMatchObject({
			frameId: "frame-2",
			duplicatedFrom: "frame-1",
			surface: "workspace",
			ownedByCaller: true,
		});
	});

	it("keeps the project the page is in; whether the project takes the copy is the command's to say", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			frameRecord({ surface: "artifact", projectId: PROJECT }),
		);

		const result = await duplicate();

		expect(mocks.duplicateFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				original: expect.objectContaining({
					projectId: PROJECT,
					surface: "artifact",
				}),
			}),
		);
		expect(result).toMatchObject({ projectId: PROJECT });
	});

	it("says the copy came from the chat and the gateway session that made it, not from the original's run", async () => {
		await duplicate(
			{},
			{
				conversationId: "conv-1",
				sourceRunType: "MCP_GATEWAY",
				sourceRunId: "sess-1",
			},
		);

		expect(mocks.duplicateFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "conv-1",
				sourceRunType: "MCP_GATEWAY",
				sourceRunId: "sess-1",
			}),
		);
	});

	it.each([
		["not_editable", "No permission to add frames to this project."],
		["not_found", "Project not found."],
	] as const)(
		"says why a project that refuses the copy (%s) refused it",
		async (refusal, message) => {
			mocks.getAccessibleFrameById.mockResolvedValue(
				frameRecord({ projectId: PROJECT }),
			);
			mocks.duplicateFrame.mockRejectedValue(
				new FramePlacementRefusedError(refusal),
			);

			const result = await duplicate();

			expect(result).toEqual({ error: message });
		},
	);

	it("lets any other failure of the copy through", async () => {
		mocks.duplicateFrame.mockRejectedValue(
			new Error("database unavailable"),
		);

		await expect(duplicate()).rejects.toThrow("database unavailable");
	});

	it("gives the copy none of the source's tools unless the caller passes them", async () => {
		await duplicate();

		expect(mocks.duplicateFrame).toHaveBeenCalledWith(
			expect.objectContaining({ runtimeTools: undefined }),
		);
	});

	it("gives the copy exactly the tools the caller passes, as a fork they chose", async () => {
		const result = await duplicate(
			{},
			{ runtimeTools: ["fabric_list_frames"] },
		);

		expect(mocks.duplicateFrame).toHaveBeenCalledWith(
			expect.objectContaining({ runtimeTools: ["fabric_list_frames"] }),
		);
		expect(result).toMatchObject({ runtimeTools: ["fabric_list_frames"] });
	});

	it("refuses tools that are not a list of names, without making the copy", async () => {
		const result = await duplicate(
			{},
			{ runtimeTools: "fabric_list_frames" },
		);

		expect(result).toHaveProperty("error");
		expect(mocks.duplicateFrame).not.toHaveBeenCalled();
	});

	it("names the copy with the title the caller gives", async () => {
		await duplicate({ title: "My poll" });

		expect(mocks.duplicateFrame).toHaveBeenCalledWith(
			expect.objectContaining({ title: "My poll" }),
		);
	});

	it("answers not found for a page the caller cannot open, and makes no copy", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(null);

		expect(await duplicate()).toEqual({ error: "Frame not found." });
		expect(mocks.duplicateFrame).not.toHaveBeenCalled();
	});

	it("refuses a caller who cannot create frames", async () => {
		mocks.canCreateOrganizationFrames.mockResolvedValue(false);

		expect(await duplicate()).toEqual({
			error: "No permission to create frames in this organization.",
		});
		expect(mocks.duplicateFrame).not.toHaveBeenCalled();
	});

	it("fails closed with no organization", async () => {
		const result = await duplicateFirstClassFrame({
			args: { frameId: "frame-1" },
			userId: OTHER,
		});

		expect(result).toEqual({
			error: "No organization context for this frame operation.",
		});
		expect(mocks.duplicateFrame).not.toHaveBeenCalled();
	});
});
