import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAccessibleFrameById: vi.fn() }));
vi.mock("@repo/database", () => ({
	getAccessibleFrameById: mocks.getAccessibleFrameById,
}));

import { resolveUsageFrame } from "../resolve-usage-frame";

const caller = {
	userId: "user-example",
	userEmail: "member@example.com",
	organizationId: "org-example",
	projectId: "project-example",
};

beforeEach(() => {
	mocks.getAccessibleFrameById.mockReset();
});

describe("launch frame usage authorization", () => {
	it("checks current caller access in the resolved tenant", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue({
			id: "frame-example",
			projectId: caller.projectId,
		});
		await expect(
			resolveUsageFrame({ ...caller, launchFrameId: "frame-example" }),
		).resolves.toEqual({ usageFrameId: "frame-example" });
		expect(mocks.getAccessibleFrameById).toHaveBeenCalledWith({
			id: "frame-example",
			userId: caller.userId,
			userEmail: caller.userEmail,
			organizationId: caller.organizationId,
		});
	});

	it.each(["frame-foreign-tenant", "frame-inaccessible"])(
		"refuses %s when canonical access denies it",
		async (launchFrameId) => {
			mocks.getAccessibleFrameById.mockResolvedValue(null);
			const result = await resolveUsageFrame({
				...caller,
				launchFrameId,
			});
			expect(result.error?.status).toBe(403);
			expect(result).not.toHaveProperty("usageFrameId");
		},
	);

	it.each(["project-other", undefined])(
		"refuses an attached frame outside the resolved project (%s)",
		async (projectId) => {
			mocks.getAccessibleFrameById.mockResolvedValue({
				id: "frame-example",
				projectId: caller.projectId,
			});
			const result = await resolveUsageFrame({
				...caller,
				projectId,
				launchFrameId: "frame-example",
			});
			expect(result.error?.status).toBe(403);
			expect(result).not.toHaveProperty("usageFrameId");
		},
	);

	it("allows an unattached frame alongside an authorized project", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue({
			id: "frame-example",
			projectId: null,
		});
		await expect(
			resolveUsageFrame({ ...caller, launchFrameId: "frame-example" }),
		).resolves.toEqual({ usageFrameId: "frame-example" });
	});

	it("validates the legacy Workspace launcher for a new workflow", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue({
			id: "frame-example",
			projectId: caller.projectId,
		});
		await expect(
			resolveUsageFrame({
				...caller,
				launchFrameId: undefined,
				legacyLaunchFrameId: "frame-example",
			}),
		).resolves.toEqual({ usageFrameId: "frame-example" });
		expect(mocks.getAccessibleFrameById).toHaveBeenCalledWith(
			expect.objectContaining({ id: "frame-example" }),
		);
	});

	it("refuses conflicting origins before an access lookup", async () => {
		const result = await resolveUsageFrame({
			...caller,
			launchFrameId: "frame-example",
			legacyLaunchFrameId: "frame-other",
		});
		expect(result.error?.status).toBe(400);
		expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
	});

	it.each(["", 42, { not: "" }, "x".repeat(201)])(
		"refuses malformed explicit launch input (%j) before querying",
		async (launchFrameId) => {
			const result = await resolveUsageFrame({
				...caller,
				launchFrameId,
			});
			expect(result.error?.status).toBe(400);
			expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
		},
	);

	it.each([undefined, null])(
		"preserves absent launch input (%s)",
		async (launchFrameId) => {
			await expect(
				resolveUsageFrame({ ...caller, launchFrameId }),
			).resolves.toEqual({});
			expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
		},
	);
});

describe("stream boundary wiring", () => {
	it.each([
		["stream/direct-turn.ts", "workspaceId"],
		["orchestrator-temporal/orchestrator-turn.ts", "rawLaunchWorkspaceId"],
	])("%s validates before model resolution", (path, launcher) => {
		const route = readFileSync(
			join(process.cwd(), "app/api/agents/fabric-ai", path),
			"utf8",
		);
		const validation = route.indexOf(
			"const usageFrame = await resolveUsageFrame(",
		);
		expect(validation).toBeGreaterThan(0);
		expect(validation).toBeLessThan(
			route.indexOf("aiModelResult = await getAIModelWithMetadata("),
		);
		const boundary = route.slice(validation, validation + 400);
		expect(boundary).toContain("launchFrameId,");
		expect(boundary).toContain(`legacyLaunchFrameId: ${launcher}`);
		expect(boundary).toContain("userEmail: session.user.email");
		expect(boundary).toContain("return usageFrame.error");
		expect(route).toContain("...usageFrame,");
		expect(route).not.toContain("usageFrameId: body.");
	});
});
