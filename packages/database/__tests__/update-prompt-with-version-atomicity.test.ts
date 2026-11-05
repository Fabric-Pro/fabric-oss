/**
 * Fizzy #2250: `updatePromptWithVersion` is what makes a rename-plus-body-fix
 * atomic. Before it, `PromptDetails.updateMutation` on the client issued two
 * separate requests — `prompts.update` then `prompts.version.create` — so a
 * rename could commit while the body submitted alongside it was rejected.
 *
 * This proves the metadata update and the version insert run inside ONE
 * transaction: a failure partway through must leave nothing written, not a
 * half-saved prompt. Mocked at the Prisma client boundary, the same way
 * `bind-prompt-version-atomicity.test.ts` proves `bindPromptVersion`'s own
 * transaction shape — no real database involved, so this always runs.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/update-prompt-with-version-atomicity.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	promptUpdate,
	versionFindFirst,
	versionCreate,
	bindingUpdateMany,
	transaction,
	audit,
} = vi.hoisted(() => ({
	promptUpdate: vi.fn(),
	versionFindFirst: vi.fn(),
	versionCreate: vi.fn(),
	bindingUpdateMany: vi.fn(),
	transaction: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("../prisma/queries/audit-log", () => ({ recordAuditTx: audit }));

vi.mock("../prisma/client", () => {
	const tx = {
		prompt: { update: promptUpdate },
		promptVersion: { findFirst: versionFindFirst, create: versionCreate },
		promptBinding: { updateMany: bindingUpdateMany },
	};
	return {
		db: {
			$transaction: (fn: (tx: unknown) => unknown) => {
				transaction(fn);
				return fn(tx);
			},
		},
		Prisma: {
			PrismaClientKnownRequestError: class extends Error {
				code: string;
				constructor(code: string) {
					super(`fake prisma error ${code}`);
					this.code = code;
				}
			},
		},
	};
});

import { updatePromptWithVersion } from "../prisma/queries/prompts";

const PARENT = {
	id: "p-1",
	scope: "ORG" as const,
	userId: null,
	organizationId: "org-a",
};

beforeEach(() => {
	for (const m of [
		promptUpdate,
		versionFindFirst,
		versionCreate,
		bindingUpdateMany,
		transaction,
		audit,
	]) {
		m.mockReset();
	}
	promptUpdate.mockResolvedValue(PARENT);
	versionFindFirst.mockResolvedValue({ id: "v-old", version: 1 });
	versionCreate.mockResolvedValue({ id: "v-new", version: 2 });
	bindingUpdateMany.mockResolvedValue({ count: 1 });
});

describe("content provided: metadata and the new version write in one transaction", () => {
	it("opens exactly one transaction for both writes", async () => {
		await updatePromptWithVersion({
			id: "p-1",
			name: "Renamed",
			updatedBy: "user-1",
			content: "new body",
		});

		expect(transaction).toHaveBeenCalledTimes(1);
		expect(promptUpdate).toHaveBeenCalledWith({
			where: { id: "p-1" },
			data: expect.objectContaining({ name: "Renamed" }),
		});
		expect(versionCreate).toHaveBeenCalledTimes(1);
		expect(bindingUpdateMany).toHaveBeenCalledWith({
			where: { promptVersionId: "v-old", scope: "ORG" },
			data: { promptVersionId: "v-new" },
		});
	});

	it("propagates a version-insert failure without swallowing it — nothing this transaction did is real once it throws", async () => {
		versionCreate.mockRejectedValue(new Error("insert failed"));

		await expect(
			updatePromptWithVersion({
				id: "p-1",
				name: "Renamed",
				updatedBy: "user-1",
				content: "new body",
			}),
		).rejects.toThrow("insert failed");

		// The metadata update ran inside the SAME transaction function that
		// threw — a real Prisma transaction rolls the whole function back on
		// any throw, so a rename never persists on its own here.
		expect(transaction).toHaveBeenCalledTimes(1);
		expect(promptUpdate).toHaveBeenCalledTimes(1);
	});

	it("retries in a new transaction on a version-number collision (P2002)", async () => {
		const { Prisma } = await import("../prisma/client");
		versionCreate
			.mockRejectedValueOnce(
				new (Prisma as any).PrismaClientKnownRequestError("P2002"),
			)
			.mockResolvedValueOnce({ id: "v-new-2", version: 3 });

		const result = await updatePromptWithVersion({
			id: "p-1",
			name: "Renamed",
			updatedBy: "user-1",
			content: "new body",
		});

		expect(transaction).toHaveBeenCalledTimes(2);
		expect(result.version).toMatchObject({ id: "v-new-2" });
	});
});

describe("content omitted: metadata-only save creates no version", () => {
	it("writes the prompt row and returns a null version, with no version insert at all", async () => {
		const result = await updatePromptWithVersion({
			id: "p-1",
			name: "Renamed only",
			updatedBy: "user-1",
		});

		expect(promptUpdate).toHaveBeenCalledTimes(1);
		expect(versionCreate).not.toHaveBeenCalled();
		expect(bindingUpdateMany).not.toHaveBeenCalled();
		expect(result).toEqual({ prompt: PARENT, version: null });
	});
});

describe("versioned response settings", () => {
	it("carries the body and variables from the same latest read for a contract-only save", async () => {
		versionFindFirst.mockResolvedValue({
			id: "latest",
			version: 7,
			content: "newer instructions",
			variables: { topic: "release" },
			responseContract: { format: "TEXT" },
		});
		await updatePromptWithVersion({
			id: PARENT.id,
			updatedBy: "example-user",
			responseContract: { format: "XML" },
			auditOrganizationId: "example-org",
		});
		expect(versionFindFirst).toHaveBeenCalledTimes(1);
		expect(versionCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				version: 8,
				content: "newer instructions",
				variables: { topic: "release" },
				responseContract: { format: "XML" },
			}),
		});
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: "example-org",
				action: "prompt.response_contract_changed",
				metadata: { versionId: "v-new", responseFormat: "XML" },
			}),
		);
	});
	it("inherits the response contract without changing legacy content-only variable semantics", async () => {
		versionFindFirst.mockResolvedValue({
			id: "latest",
			version: 2,
			content: "old",
			variables: { old: "value" },
			responseContract: { format: "XML" },
		});
		await updatePromptWithVersion({
			id: PARENT.id,
			updatedBy: "example-user",
			content: "replacement",
		});
		expect(versionCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				content: "replacement",
				variables: {},
				responseContract: { format: "XML" },
			}),
		});
		expect(audit).not.toHaveBeenCalled();
	});
	it("does not treat an audit failure as a successful save", async () => {
		audit.mockRejectedValueOnce(new Error("audit unavailable"));
		versionFindFirst.mockResolvedValue({
			id: "latest",
			version: 2,
			content: "body",
		});
		await expect(
			updatePromptWithVersion({
				id: PARENT.id,
				updatedBy: "example-user",
				responseContract: { format: "XML" },
			}),
		).rejects.toThrow("audit unavailable");
	});
});
