/**
 * Fizzy #2250: `PromptDetails.updateMutation` used to call `prompts.update`
 * (metadata) and then `prompts.version.create` (content) as two separate
 * requests. A rename plus a blank/invalid body updated the metadata, THEN
 * failed on the version create — the toast said "Failed to update prompt"
 * while the rename had already persisted.
 *
 * `savePromptAtomically` is the extracted mutation function
 * `PromptDetails.tsx` now uses; this proves the property that mattered:
 * a rename with new content makes exactly ONE `prompts.update` call
 * carrying both, and never calls `prompts.version.create`.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/save-prompt-atomically.test.ts
 */

import { describe, expect, it, vi } from "vitest";

const { update, versionCreate } = vi.hoisted(() => ({
	update: vi.fn(),
	versionCreate: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			update,
			version: { create: versionCreate },
		},
	},
}));

import { savePromptAtomically } from "@saas/prompts/lib/save-prompt-atomically";

describe("savePromptAtomically", () => {
	it("makes exactly one prompts.update call carrying both the rename and the content, and never calls version.create", async () => {
		update.mockResolvedValue({ prompt: { id: "p-1" } });

		await savePromptAtomically(
			"p-1",
			{ name: "Renamed", content: "new body", changeNote: "tightened" },
			"old body",
		);

		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith({
			id: "p-1",
			name: "Renamed",
			content: "new body",
			changeNote: "tightened",
		});
		expect(versionCreate).not.toHaveBeenCalled();
	});

	it("omits content when it did not change, so a metadata-only edit stays metadata-only", async () => {
		update.mockResolvedValue({ prompt: { id: "p-1" } });

		await savePromptAtomically(
			"p-1",
			{ name: "Renamed", content: "same body" },
			"same body",
		);

		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ content: undefined }),
		);
	});

	it("omits content entirely when the caller never passed any", async () => {
		update.mockResolvedValue({ prompt: { id: "p-1" } });

		await savePromptAtomically("p-1", { name: "Renamed" }, "old body");

		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ content: undefined }),
		);
	});
});
