import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	getInstructionSnapshot: vi.fn(),
	getInstructionFileByPath: vi.fn(),
	downloadFile: vi.fn(),
	getSignedUrl: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getInstructionSnapshot: (...a: unknown[]) => m.getInstructionSnapshot(...a),
	getInstructionFileByPath: (...a: unknown[]) =>
		m.getInstructionFileByPath(...a),
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		downloadFile: m.downloadFile,
		getSignedUrl: m.getSignedUrl,
	}),
}));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));
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
			m.handlers.getFile = fn;
			return fn;
		},
	};
	return {
		tenantProtectedProcedure: b,
		requireProjectPermission: () => ({}),
		Permissions: { INSTRUCTION_READ: "instruction:read" },
	};
});
import "../get-file";
const ctx = { user: { id: "u" }, session: { activeOrganizationId: "org_1" } };
beforeEach(() => {
	for (const f of [
		m.getInstructionSnapshot,
		m.getInstructionFileByPath,
		m.downloadFile,
		m.getSignedUrl,
	]) {
		f.mockReset();
	}
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: [],
		source: "org",
		organizationId: "org_1",
	});
});

describe("projects.instructions.getFile", () => {
	it("returns a paged text body and never a body for a non-READY snapshot", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			id: "s",
			status: "READY",
		});
		m.getInstructionFileByPath.mockResolvedValue({
			path: "CLAUDE.md",
			kind: "INSTRUCTIONS",
			name: null,
			description: null,
			size: 5,
			mimeType: "text/markdown",
			isText: true,
			mode: null,
			storageKey: "k",
		});
		m.downloadFile.mockResolvedValue({
			data: Buffer.from("hello world"),
			contentType: "text/markdown",
			size: 11,
		});
		const r = await m.handlers.getFile!({
			input: {
				projectId: "p",
				snapshotId: "s",
				path: "CLAUDE.md",
				offset: 0,
				maxLength: 5,
			},
			context: ctx,
		});
		expect(r).toMatchObject({
			body: "hello",
			truncated: true,
			nextOffset: 5,
			url: null,
		});

		m.getInstructionSnapshot.mockResolvedValue({
			id: "s",
			status: "VALIDATING",
		});
		await expect(
			m.handlers.getFile!({
				input: {
					projectId: "p",
					snapshotId: "s",
					path: "CLAUDE.md",
					offset: 0,
					maxLength: 5,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("returns a signed url instead of a body for binaries", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			id: "s",
			status: "READY",
		});
		m.getInstructionFileByPath.mockResolvedValue({
			path: "a.png",
			kind: "OTHER",
			name: null,
			description: null,
			size: 5,
			mimeType: "image/png",
			isText: false,
			mode: null,
			storageKey: "k",
		});
		m.getSignedUrl.mockResolvedValue("https://example.com/signed");
		const r = await m.handlers.getFile!({
			input: {
				projectId: "p",
				snapshotId: "s",
				path: "a.png",
				offset: 0,
				maxLength: 5,
			},
			context: ctx,
		});
		expect(r).toMatchObject({
			body: null,
			url: "https://example.com/signed",
		});
		expect(m.downloadFile).not.toHaveBeenCalled();
	});
});
