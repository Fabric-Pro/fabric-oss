/**
 * `projects.instructions.compare` — the path-level diff of two versions.
 *
 * `diffInstructionManifests` is the REAL pure function here (only the two
 * database loaders are stubbed): the point of the added/removed/changed cases
 * is that this handler's projection agrees with the diff the rest of the
 * product already computes, which a second stubbed diff would not prove.
 */
import { diffInstructionManifests } from "@repo/database/prisma/queries/instructions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	getInstructionSnapshot: vi.fn(),
	listInstructionFiles: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
}));
vi.mock("@repo/database", async () => {
	const { diffInstructionManifests: real } = await import(
		"@repo/database/prisma/queries/instructions"
	);
	return {
		getInstructionSnapshot: (...a: unknown[]) =>
			m.getInstructionSnapshot(...a),
		listInstructionFiles: (...a: unknown[]) => m.listInstructionFiles(...a),
		diffInstructionManifests: real,
	};
});
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const b = {
		use: () => b,
		route: () => b,
		input: () => b,
		handler: (fn: (...a: unknown[]) => unknown) => {
			m.handlers.compare = fn;
			return fn;
		},
	};
	return {
		tenantProtectedProcedure: b,
		requireProjectPermission: () => ({}),
		Permissions: { INSTRUCTION_READ: "instruction:read" },
	};
});
import "../compare-snapshots";

const ctx = { user: { id: "u" }, session: { activeOrganizationId: "org_1" } };

function snapshot(overrides: Record<string, unknown> = {}) {
	return {
		id: "s_from",
		version: 7,
		status: "READY",
		proposalStatus: null,
		...overrides,
	};
}

function file(
	path: string,
	sha256: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		id: `f_${path}`,
		path,
		kind: "KNOWLEDGE",
		name: null,
		description: null,
		size: sha256.length,
		mimeType: "text/markdown",
		isText: true,
		sha256,
		storageKey: `keys/${path}`,
		mode: null,
		...overrides,
	};
}

/**
 * The handler the module registered when it was imported, asserted rather
 * than assumed: a `!` here would turn "the procedure never reached
 * `.handler()`" into an opaque "cannot read properties of undefined" inside
 * whichever case ran first.
 */
function compareHandler(): (...a: unknown[]) => unknown {
	const handler = m.handlers.compare;
	if (!handler) {
		throw new Error(
			"compare-snapshots did not register a handler on import",
		);
	}
	return handler;
}

function call(input: Record<string, unknown> = {}) {
	return compareHandler()({
		input: {
			projectId: "p",
			fromSnapshotId: "s_from",
			toSnapshotId: "s_to",
			...input,
		},
		context: ctx,
	});
}

beforeEach(() => {
	m.getInstructionSnapshot.mockReset();
	m.listInstructionFiles.mockReset();
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: [],
		source: "org",
		organizationId: "org_1",
	});
});

/** Both ids resolve to READY, publishable snapshots. */
function bothReadable() {
	m.getInstructionSnapshot.mockImplementation(async (id: string) =>
		id === "s_from" ? snapshot() : snapshot({ id: "s_to", version: 8 }),
	);
}

describe("projects.instructions.compare", () => {
	it("names added, removed and changed paths and counts the rest as unchanged", async () => {
		bothReadable();
		m.listInstructionFiles.mockImplementation(async (snapshotId: string) =>
			snapshotId === "s_from"
				? [
						file("AGENTS.md", "aaa"),
						file("gone.md", "ggg", { kind: "RULE", size: 40 }),
						file("same.md", "sss"),
					]
				: [
						file("AGENTS.md", "bbb", { size: 120 }),
						file("new.md", "nnn", { kind: "SKILL", size: 12 }),
						file("same.md", "sss"),
					],
		);

		const r = (await call()) as Record<string, unknown>;

		expect(r).toMatchObject({
			from: { id: "s_from", version: 7 },
			to: { id: "s_to", version: 8 },
			added: [{ path: "new.md", kind: "SKILL", isText: true, size: 12 }],
			removed: [
				{ path: "gone.md", kind: "RULE", isText: true, size: 40 },
			],
			changed: [
				{
					path: "AGENTS.md",
					kind: "KNOWLEDGE",
					isText: true,
					fromSize: 3,
					toSize: 120,
				},
			],
			unchangedCount: 1,
		});
		// The projection agrees with the shared pure diff, path for path.
		expect(
			diffInstructionManifests(
				[
					{ path: "AGENTS.md", sha256: "aaa" },
					{ path: "gone.md", sha256: "ggg" },
					{ path: "same.md", sha256: "sss" },
				],
				[
					{ path: "AGENTS.md", sha256: "bbb" },
					{ path: "new.md", sha256: "nnn" },
					{ path: "same.md", sha256: "sss" },
				],
			),
		).toEqual({
			added: ["new.md"],
			removed: ["gone.md"],
			changed: ["AGENTS.md"],
		});
	});

	it("scopes both file lists to the project's hosting organization and leaks no sha256 or storage key", async () => {
		bothReadable();
		m.listInstructionFiles.mockResolvedValue([file("AGENTS.md", "aaa")]);

		const r = (await call()) as Record<string, unknown>;

		expect(m.listInstructionFiles).toHaveBeenCalledWith("s_from", "org_1");
		expect(m.listInstructionFiles).toHaveBeenCalledWith("s_to", "org_1");
		const serialized = JSON.stringify(r);
		expect(serialized).not.toContain("sha256");
		expect(serialized).not.toContain("storageKey");
		expect(serialized).not.toContain("keys/");
	});

	it("marks a file diffable only when both sides are text", async () => {
		bothReadable();
		m.listInstructionFiles.mockImplementation(async (snapshotId: string) =>
			snapshotId === "s_from"
				? [file("logo.png", "aaa", { isText: false })]
				: [file("logo.png", "bbb")],
		);

		const r = (await call()) as { changed: Array<{ isText: boolean }> };

		expect(r.changed).toEqual([
			{
				path: "logo.png",
				kind: "KNOWLEDGE",
				isText: false,
				fromSize: 3,
				toSize: 3,
			},
		]);
	});

	it("compares a version with itself as no change at all", async () => {
		m.getInstructionSnapshot.mockResolvedValue(snapshot());
		m.listInstructionFiles.mockResolvedValue([
			file("AGENTS.md", "aaa"),
			file("same.md", "sss"),
		]);

		const r = await call({ toSnapshotId: "s_from" });

		expect(r).toMatchObject({
			added: [],
			removed: [],
			changed: [],
			unchangedCount: 2,
		});
	});

	it.each(["s_from", "s_to"] as const)(
		"404s and reads no files when %s is missing",
		async (missing) => {
			m.getInstructionSnapshot.mockImplementation(async (id: string) =>
				id === missing ? null : snapshot({ id }),
			);

			await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(m.listInstructionFiles).not.toHaveBeenCalled();
		},
	);

	it.each(["PENDING", "REJECTED"] as const)(
		"404s for a READY snapshot still awaiting a %s proposal decision",
		async (proposalStatus) => {
			m.getInstructionSnapshot.mockImplementation(async (id: string) =>
				id === "s_to"
					? snapshot({ id: "s_to", version: 8, proposalStatus })
					: snapshot(),
			);

			await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(m.listInstructionFiles).not.toHaveBeenCalled();
		},
	);

	it.each(["RECEIVING", "VALIDATING", "REJECTED", "FAILED"] as const)(
		"404s when a side is %s rather than READY",
		async (status) => {
			m.getInstructionSnapshot.mockImplementation(async (id: string) =>
				id === "s_from" ? snapshot({ status }) : snapshot({ id }),
			);

			await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(m.listInstructionFiles).not.toHaveBeenCalled();
		},
	);
});
