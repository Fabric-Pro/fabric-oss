/**
 * Trusted access override on the Read-only gate.
 *
 * The name heuristic is wrong in BOTH directions for integration operations:
 * it reads NHTSA's `decode_vin` as a write (blocking a pure read), and it would
 * read a hypothetical registered write named `query_and_purge` as a read
 * (letting a write through). Callers holding a first-party declaration of the
 * operation's effect — the executor registry — pass it instead.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { isProjectReadOnly } = vi.hoisted(() => ({
	isProjectReadOnly: vi.fn(async () => true),
}));

vi.mock("@repo/database", () => ({ isProjectReadOnly }));
vi.mock("@repo/utils/project-context", () => ({
	getAmbientProjectId: () => undefined,
}));

const { guardToolWriteForReadOnly } = await import("../read-only-gate");

beforeEach(() => {
	isProjectReadOnly.mockClear();
	isProjectReadOnly.mockResolvedValue(true);
});

describe("accessOverride", () => {
	it("lets a declared READ through a name that classifies WRITE", async () => {
		// `decode_vin` has no read prefix the authority-style heuristic knows.
		await expect(
			guardToolWriteForReadOnly("p1", "decode_vin", {
				accessOverride: "READ",
			}),
		).resolves.toBeNull();
		// Short-circuits before the project lookup.
		expect(isProjectReadOnly).not.toHaveBeenCalled();
	});

	it("blocks a declared WRITE behind a name that classifies READ", async () => {
		const blocked = await guardToolWriteForReadOnly(
			"p1",
			"query_and_purge",
			{ accessOverride: "WRITE" },
		);

		expect(blocked?.code).toBe("PROJECT_READ_ONLY");
		expect(isProjectReadOnly).toHaveBeenCalledWith("p1");
	});

	it("still allows a declared WRITE when the project is not read-only", async () => {
		isProjectReadOnly.mockResolvedValue(false);

		await expect(
			guardToolWriteForReadOnly("p1", "query_index", {
				accessOverride: "WRITE",
			}),
		).resolves.toBeNull();
	});

	it("falls back to the name heuristic when no override is supplied", async () => {
		await expect(
			guardToolWriteForReadOnly("p1", "send_message"),
		).resolves.toMatchObject({ code: "PROJECT_READ_ONLY" });

		await expect(
			guardToolWriteForReadOnly("p1", "list_channels"),
		).resolves.toBeNull();
	});

	it("does not gate at all without a project in scope", async () => {
		await expect(
			guardToolWriteForReadOnly(undefined, "query_and_purge", {
				accessOverride: "WRITE",
			}),
		).resolves.toBeNull();
		expect(isProjectReadOnly).not.toHaveBeenCalled();
	});
});
