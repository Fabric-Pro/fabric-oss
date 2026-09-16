/**
 * Fizzy #2527: `streamCompleteText` (the shared helper behind
 * `generateFrameBlock` / `generateSlideOutline`) used to send the system
 * prompt as a `role: "system"` entry inside `messages`, which `ai` 6.0.170+
 * warns on and AI SDK 7 will reject. The system text must go through the
 * top-level `system` option instead, leaving `messages` with only the user
 * turn.
 *
 * Reaches `streamText` through `createFirstClassFrame` with no `blocks` and
 * a non-slideshow frame — the shortest public path to `generateFrameBlock` →
 * `streamCompleteText`. `@repo/database` is mocked the same way
 * `frame-service-permissions.test.ts` does it: spread the real module and
 * override only the functions this path touches.
 *
 * Run with: pnpm --filter @repo/temporal test __tests__/frame-service-system-message
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
	streamTextMock: vi.fn(),
	getAIModelWithMetadataMock: vi.fn(),
	computeMaxOutputTokenBudgetMock: vi.fn(),
	canCreateOrganizationFrames: vi.fn(),
	createFrame: vi.fn(),
}));

vi.mock("ai", () => ({
	streamText: stubs.streamTextMock,
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: stubs.getAIModelWithMetadataMock,
}));
vi.mock("@repo/ai/lib/output-token-budget", () => ({
	computeMaxOutputTokenBudget: stubs.computeMaxOutputTokenBudgetMock,
}));

// Spread the real module rather than listing its exports — this service's
// import graph reaches far more of `@repo/database` than the two functions
// under test (see frame-service-permissions.test.ts for the same rationale).
vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		canCreateOrganizationFrames: stubs.canCreateOrganizationFrames,
		createFrame: stubs.createFrame,
	};
});

import { createFirstClassFrame } from "../src/activities/shared/frame-service";

const USER = "user-1";
const ORG = "org-1";

beforeEach(() => {
	stubs.streamTextMock.mockReset();
	stubs.getAIModelWithMetadataMock.mockReset();
	stubs.computeMaxOutputTokenBudgetMock.mockReset();
	stubs.canCreateOrganizationFrames.mockReset();
	stubs.createFrame.mockReset();

	stubs.canCreateOrganizationFrames.mockResolvedValue(true);
	stubs.getAIModelWithMetadataMock.mockResolvedValue({
		model: { __mockModel: true },
		metadata: { modelString: "test-model", provider: "test" },
	});
	stubs.computeMaxOutputTokenBudgetMock.mockReturnValue(undefined);
	stubs.streamTextMock.mockReturnValue({
		textStream: (async function* () {
			yield "<html><body>Generated</body></html>";
		})(),
	});
	stubs.createFrame.mockResolvedValue({
		id: "frame-1",
		title: "Dashboard",
		description: "Simple admin dashboard",
		kind: "frame",
		contentType: "html",
		shareToken: null,
		document: {
			blocks: [{ content: "<html><body>Generated</body></html>" }],
		},
	});
});

describe("createFirstClassFrame — system prompt placement", () => {
	it("sends the system prompt via `system`, not as a message", async () => {
		await createFirstClassFrame({
			args: { title: "Dashboard", description: "Simple admin dashboard" },
			userId: USER,
			organizationId: ORG,
		});

		expect(stubs.streamTextMock).toHaveBeenCalledTimes(1);
		const callArgs = stubs.streamTextMock.mock.calls[0][0] as {
			system?: unknown;
			messages: Array<{ role: string }>;
		};

		expect(typeof callArgs.system).toBe("string");
		expect(callArgs.messages.some((m) => m.role === "system")).toBe(false);
		expect(callArgs.messages).toEqual([
			{ role: "user", content: expect.any(String) },
		]);
	});
});
