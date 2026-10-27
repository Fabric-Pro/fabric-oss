import { call, ORPCError, os } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	write: vi.fn(),
	warn: vi.fn(),
	projectGuard: vi.fn(),
	chatGuard: vi.fn(),
	resolve: vi.fn(),
}));
vi.mock("@repo/database", () => ({ recordAiOutcome: mocks.write }));
vi.mock("@repo/logs", () => ({ logger: { warn: mocks.warn } }));
vi.mock("../../../../../orpc/procedures", () => ({
	tenantProtectedProcedure: os.$context<{
		user: { id: string };
		session: { activeOrganizationId: string };
	}>(),
	Permissions: {
		PROJECT_UPDATE: "project.update",
		AI_CHAT: "ai.chat",
		PUBLISHING_TOPIC_UPDATE: "publishing-topic:update",
	},
	requireProjectPermission:
		(permission: string) =>
		async ({ next }: { next: () => unknown }, input: unknown) => {
			await mocks.projectGuard(permission, input);
			return next();
		},
	requirePermission:
		(permission: string) =>
		async ({ next }: { next: () => unknown }) => {
			await mocks.chatGuard(permission);
			return next();
		},
	resolveOrganizationId: mocks.resolve,
}));

import { confirmAiDraft } from "../confirm-draft";

const context = {
	user: { id: "example-user" },
	session: { activeOrganizationId: "example-org" },
};
const base = { draftId: "example-draft", verdict: "accepted" as const };
const invoke = (input: unknown) =>
	call(confirmAiDraft, input as never, { context });
beforeEach(() => {
	vi.clearAllMocks();
	mocks.write.mockResolvedValue({});
	mocks.projectGuard.mockResolvedValue(undefined);
	mocks.chatGuard.mockResolvedValue(undefined);
	mocks.resolve.mockImplementation(
		(_input, session) => session.activeOrganizationId,
	);
});

describe("confirm draft", () => {
	it.each([
		[
			"feature-spec",
			"document-generation",
			"feature-spec-draft",
			"example-project",
		],
		[
			"document",
			"document-generation",
			"document-draft",
			"example-project",
		],
		[
			"document-generator",
			"agent-document-generation",
			"agent-document-draft",
			null,
		],
		[
			"prompt-enhancer",
			"prompt-enhancement",
			"prompt-enhancement-draft",
			null,
		],
	])(
		"maps %s to its usage key and distinct subject",
		async (surface, featureKey, subjectType, projectId) => {
			await invoke({
				...base,
				surface,
				...(projectId ? { projectId } : {}),
			});
			expect(mocks.write).toHaveBeenCalledWith({
				featureKey,
				subjectType,
				subjectId: base.draftId,
				projectId,
				userId: "example-user",
				organizationId: "example-org",
				outcome: "ACCEPTED_AS_IS",
				modelCanonicalName: null,
				promptVersionId: null,
			});
			expect(mocks.resolve).toHaveBeenCalledWith(
				undefined,
				context.session,
			);
			if (projectId) {
				expect(mocks.projectGuard).toHaveBeenCalledWith(
					"project.update",
					expect.objectContaining({ projectId }),
				);
				expect(mocks.chatGuard).not.toHaveBeenCalled();
			} else {
				expect(mocks.chatGuard).toHaveBeenCalledWith("ai.chat");
			}
		},
	);
	it.each([
		["accepted", "ACCEPTED_AS_IS"],
		["accepted-with-edits", "ACCEPTED_WITH_EDITS"],
		["rejected", "REJECTED"],
	])("maps %s verdict", async (verdict, outcome) => {
		await invoke({
			...base,
			surface: "document",
			projectId: "example-project",
			verdict,
		});
		expect(mocks.write).toHaveBeenCalledWith(
			expect.objectContaining({ outcome }),
		);
	});
	it.each(["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"] as const)(
		"does not swallow %s project authorization failure",
		async (code) => {
			mocks.projectGuard.mockRejectedValue(new ORPCError(code));
			await expect(
				invoke({
					...base,
					surface: "document",
					projectId: "example-other-project",
				}),
			).rejects.toMatchObject({ code });
			expect(mocks.write).not.toHaveBeenCalled();
		},
	);
	it("refuses projectless callers without AI permission", async () => {
		mocks.chatGuard.mockRejectedValue(new ORPCError("FORBIDDEN"));
		await expect(
			invoke({ ...base, surface: "prompt-enhancer" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it.each([
		{ ...base, surface: "document" },
		{ ...base, surface: "prompt-enhancer", projectId: "example-project" },
		{
			...base,
			surface: "document-generator",
			projectId: "example-project",
		},
		{
			...base,
			surface: "prompt-enhancer",
			organizationId: "example-other-org",
		},
		{ ...base, surface: "unknown" },
		{ ...base, surface: "prompt-enhancer", draftId: "x".repeat(129) },
	])("rejects invalid input %j", async (input) => {
		await expect(invoke(input)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.write).not.toHaveBeenCalled();
	});

	it("records a topic rewrite rejection under the saved-analysis subject type", async () => {
		await invoke({
			...base,
			surface: "topic-analysis",
			projectId: "example-project",
			verdict: "rejected",
		});
		expect(mocks.write).toHaveBeenCalledWith(
			expect.objectContaining({
				featureKey: "publishing-suite",
				subjectType: "publishing-analysis",
				outcome: "REJECTED",
			}),
		);
		expect(mocks.projectGuard).toHaveBeenCalledWith(
			"publishing-topic:update",
			expect.anything(),
		);
	});
	it.each(["accepted", "accepted-with-edits"])(
		"refuses %s for topic rewrite cards",
		async (verdict) => {
			await expect(
				invoke({
					...base,
					surface: "topic-analysis",
					projectId: "example-project",
					verdict,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.write).not.toHaveBeenCalled();
		},
	);
	it("warns and swallows write failure after authorization", async () => {
		mocks.write.mockRejectedValueOnce(new Error("example failure"));
		await expect(
			invoke({ ...base, surface: "prompt-enhancer" }),
		).resolves.toBeDefined();
		expect(mocks.warn).toHaveBeenCalledOnce();
	});
});
