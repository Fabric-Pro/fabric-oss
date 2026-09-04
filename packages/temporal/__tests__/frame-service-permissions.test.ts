/**
 * Frame writes honour the caller's organization role (Fizzy #2380).
 *
 * Frames are organization resources and the oRPC procedures behind the UI gate
 * them on WORKSPACE_CREATE / WORKSPACE_UPDATE, which a viewer does not hold.
 * This service enforced nothing, and it is the shared floor under five separate
 * callers — the MCP gateway, the agent executor, direct-chat built-in tools, the
 * orchestrator's MCP tool execution, and the Fabric AI handler — so the gap was
 * reachable five ways and fixable in one.
 *
 * The cases below assert on the *write*: a refusal that has already called
 * `createFrame` is not a refusal. The create path is checked immediately after
 * argument validation and before any model work, so a refused create costs
 * nothing and needs none of the AI machinery mocked.
 *
 * Run with: pnpm --filter @repo/temporal test __tests__/frame-service-permissions
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	canCreateOrganizationFrames: vi.fn(),
	canUpdateOrganizationFrames: vi.fn(),
	createFrame: vi.fn(),
	updateFrame: vi.fn(),
	publishFrame: vi.fn(),
	getFrameById: vi.fn(),
	listFrames: vi.fn(),
}));

// Spread the real module rather than listing its exports: this service's
// import graph reaches far more of `@repo/database` than the four functions
// under test, and an exhaustive mock is a list that goes stale the next time
// someone adds an import. Nothing here calls the untouched exports, so the lazy
// Prisma client is never constructed.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		canCreateOrganizationFrames: mocks.canCreateOrganizationFrames,
		canUpdateOrganizationFrames: mocks.canUpdateOrganizationFrames,
		createFrame: mocks.createFrame,
		updateFrame: mocks.updateFrame,
		publishFrame: mocks.publishFrame,
	};
});

import {
	createFirstClassFrame,
	shareFirstClassFrame,
	updateFirstClassFrame,
} from "../src/activities/shared/frame-service";

const USER = "user-1";
const ORG = "org-1";

const createArgs = {
	title: "Quarterly Review",
	description: "A frame",
	blocks: [{ type: "markdown", content: "hello" }],
};

const updateArgs = { frameId: "frame-1", title: "Renamed" };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.updateFrame.mockResolvedValue({ id: "frame-1", title: "Renamed" });
	mocks.publishFrame.mockResolvedValue({ id: "frame-1", isPublic: true });
});

describe("createFirstClassFrame", () => {
	it("refuses a caller whose organization role cannot create frames", async () => {
		mocks.canCreateOrganizationFrames.mockResolvedValue(false);

		const result = await createFirstClassFrame({
			args: createArgs,
			userId: USER,
			organizationId: ORG,
		});

		expect(mocks.canCreateOrganizationFrames).toHaveBeenCalledWith(
			USER,
			ORG,
		);
		expect(result).toEqual({
			error: "No permission to create frames in this organization.",
		});
		expect(mocks.createFrame).not.toHaveBeenCalled();
	});

	// Every session runs inside exactly one organization since the
	// personal-context removal, so an absent one means something upstream
	// failed to resolve it. That is a bug, and a bug is not permission to write.
	it("fails closed when the caller carries no organization", async () => {
		mocks.canCreateOrganizationFrames.mockResolvedValue(true);

		const result = await createFirstClassFrame({
			args: createArgs,
			userId: USER,
			organizationId: undefined,
		});

		expect(result).toEqual({
			error: "No organization context for this frame operation.",
		});
		expect(mocks.canCreateOrganizationFrames).not.toHaveBeenCalled();
		expect(mocks.createFrame).not.toHaveBeenCalled();
	});
});

describe("updateFirstClassFrame", () => {
	it("refuses a caller whose organization role cannot update frames", async () => {
		mocks.canUpdateOrganizationFrames.mockResolvedValue(false);

		const result = await updateFirstClassFrame({
			args: updateArgs,
			userId: USER,
			organizationId: ORG,
		});

		expect(result).toEqual({
			error: "No permission to update frames in this organization.",
		});
		expect(mocks.updateFrame).not.toHaveBeenCalled();
	});

	it("allows a caller who holds WORKSPACE_UPDATE", async () => {
		mocks.canUpdateOrganizationFrames.mockResolvedValue(true);

		await updateFirstClassFrame({
			args: updateArgs,
			userId: USER,
			organizationId: ORG,
		});

		expect(mocks.updateFrame).toHaveBeenCalled();
	});

	// Malformed arguments are still reported as malformed. A caller who may not
	// update frames and also omitted the frame id gets the error they can act on
	// themselves, rather than being sent to an administrator over a typo.
	it("reports invalid arguments before consulting permissions", async () => {
		mocks.canUpdateOrganizationFrames.mockResolvedValue(false);

		const result = await updateFirstClassFrame({
			args: {},
			userId: USER,
			organizationId: ORG,
		});

		expect(mocks.canUpdateOrganizationFrames).not.toHaveBeenCalled();
		expect((result as { error: string }).error).not.toContain(
			"No permission",
		);
	});
});

describe("shareFirstClassFrame", () => {
	// Sharing publishes a frame outward. It is gated as an update because
	// making something visible is a change to it, and because that is what the
	// oRPC publish path requires.
	it("refuses a caller who cannot update frames", async () => {
		mocks.canUpdateOrganizationFrames.mockResolvedValue(false);

		const result = await shareFirstClassFrame({
			args: { frameId: "frame-1" },
			userId: USER,
			organizationId: ORG,
		});

		expect(result).toEqual({
			error: "No permission to update frames in this organization.",
		});
		expect(mocks.publishFrame).not.toHaveBeenCalled();
	});

	it("allows a caller who holds WORKSPACE_UPDATE", async () => {
		mocks.canUpdateOrganizationFrames.mockResolvedValue(true);

		await shareFirstClassFrame({
			args: { frameId: "frame-1" },
			userId: USER,
			organizationId: ORG,
		});

		expect(mocks.publishFrame).toHaveBeenCalled();
	});
});
