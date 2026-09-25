/**
 * Fizzy #2250: `prompts.version.create` had no maximum prompt length — only
 * the 200,000-character abuse ceiling (`INPUT_BOUNDS.text`) stood between a
 * saved prompt and a body long enough to dominate every generation it is
 * bound to. This proves the procedure wires the 50,000-character product
 * limit through `assertSavablePromptContent`, not just that the helper
 * itself enforces it (already covered by `prompt-content.test.ts` in
 * `@repo/utils`).
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/prompts/__tests__/version-content-length.test.ts
 */

import { beforeEach, expect, it, vi } from "vitest";

const { getPromptById, createPromptVersion } = vi.hoisted(() => ({
	getPromptById: vi.fn(),
	createPromptVersion: vi.fn(),
}));

vi.mock("@repo/database", () => ({ getPromptById, createPromptVersion }));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));

vi.mock("../lib/announce-default-change", () => ({
	announceDefaultChangeForWinningActions: vi.fn(),
}));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_CREATE: "prompt:create" },
	requirePermission: () => (next: unknown) => next,
	tenantProtectedProcedure: {
		use: () => ({
			route: () => ({
				input: () => ({
					output: () => ({ handler: (fn: unknown) => fn }),
				}),
			}),
		}),
	},
}));

import { versionProcedures } from "../procedures/version";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string; role?: string | null } };
}) => Promise<unknown>;

beforeEach(() => {
	vi.clearAllMocks();
	getPromptById.mockResolvedValue({
		id: "p-1",
		scope: "USER",
		organizationId: null,
		userId: "user-1",
		format: "PLAIN_TEXT",
	});
});

it("rejects a body over the 50,000-character limit and never writes a version", async () => {
	const tooLong = "x".repeat(50_001);

	await expect(
		(versionProcedures.create as unknown as Handler)({
			input: { id: "p-1", content: tooLong },
			context: { user: { id: "user-1", role: null } },
		}),
	).rejects.toThrow(
		/Prompt content is 50,001 characters; the maximum is 50,000\./,
	);

	expect(createPromptVersion).not.toHaveBeenCalled();
});

it("accepts a body at exactly the limit", async () => {
	const atMax = "x".repeat(50_000);
	createPromptVersion.mockResolvedValue({ id: "v-1" });

	await expect(
		(versionProcedures.create as unknown as Handler)({
			input: { id: "p-1", content: atMax },
			context: { user: { id: "user-1", role: null } },
		}),
	).resolves.toMatchObject({ id: "v-1" });
});
