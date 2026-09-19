/**
 * Tests for `createUploadUrlsProcedure` — mints signed PUT URLs for a page
 * of already-registered staging files, rewriting each row's provisional
 * `begin`-time storage key to the real `(projectId, snapshotId, fileId)`
 * key before signing.
 *
 * `@repo/storage` is stubbed with a fake provider so both the
 * presigned-upload happy path and the "provider cannot sign uploads" guard
 * (R14: `PRECONDITION_FAILED`, mirroring
 * `documents/create-media-upload-url.ts`'s
 * `supportsPresignedUrls && getSignedUploadUrl` check) are covered.
 *
 * That rewrite is now a one-way compare-and-set
 * (`claimInstructionFileStagingKey`) rather than an unconditional metadata
 * write: see the promoted-file cases below for what it closes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	getInstructionSnapshot: vi.fn(),
	listInstructionFiles: vi.fn(),
	claimInstructionFileStagingKey: vi.fn(),
	authorizeInstructionProposalUploadUrls: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	getStorageProvider: vi.fn(),
	assertInstructionSnapshotMutationAccess: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getInstructionSnapshot: (...a: unknown[]) => m.getInstructionSnapshot(...a),
	listInstructionFiles: (...a: unknown[]) => m.listInstructionFiles(...a),
	claimInstructionFileStagingKey: (...a: unknown[]) =>
		m.claimInstructionFileStagingKey(...a),
	authorizeInstructionProposalUploadUrls: (...a: unknown[]) =>
		m.authorizeInstructionProposalUploadUrls(...a),
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: (...a: unknown[]) => m.getStorageProvider(...a),
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../proposal-authorization", () => ({
	assertInstructionSnapshotMutationAccess: (...a: unknown[]) =>
		m.assertInstructionSnapshotMutationAccess(...a),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const builder = {
		use: () => builder,
		route: () => builder,
		input: () => builder,
		handler: (fn: (...a: unknown[]) => unknown) => {
			m.handlers.createUploadUrls = fn;
			return fn;
		},
	};
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission: () => ({}),
		Permissions: { INSTRUCTION_READ: "instruction:read" },
	};
});

import "../create-upload-urls";

const ctx = {
	user: { id: "user_1" },
	session: { activeOrganizationId: "org_1" },
};

const baseInput = {
	projectId: "proj_1",
	snapshotId: "snap_1",
	fileIds: ["f1", "f2"],
};

beforeEach(() => {
	for (const fn of Object.values(m)) {
		if (typeof fn === "function") {
			(fn as ReturnType<typeof vi.fn>).mockReset?.();
		}
	}
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: [],
		source: "org",
		organizationId: "org_1",
	});
	m.getInstructionSnapshot.mockResolvedValue({
		id: "snap_1",
		status: "RECEIVING",
		userId: "user_1",
		proposalStatus: null,
		createdAt: new Date("2026-09-18T00:00:00Z"),
	});
	m.listInstructionFiles.mockResolvedValue([
		{
			id: "f1",
			path: "CLAUDE.md",
			storageKey: "projects/proj_1/instructions/staging/pending/0",
			kind: "INSTRUCTIONS",
			name: null,
			description: null,
			mimeType: "text/markdown",
			size: 123,
		},
		{
			id: "f2",
			path: "AGENTS.md",
			storageKey: "projects/proj_1/instructions/staging/pending/1",
			kind: "INSTRUCTIONS",
			name: null,
			description: null,
			mimeType: "text/markdown",
			size: 456,
		},
	]);
	m.claimInstructionFileStagingKey.mockResolvedValue({ moved: true });
	m.authorizeInstructionProposalUploadUrls.mockResolvedValue({
		authorized: true,
	});
	m.getStorageProvider.mockReturnValue({
		supportsPresignedUrls: true,
		getSignedUploadUrl: vi.fn(
			async (key: string) => `https://signed/${key}`,
		),
	});
});

describe("projects.instructions.createUploadUrls", () => {
	it("rewrites the provisional storage key to the real (projectId, snapshotId, fileId) key and signs it", async () => {
		const result = (await m.handlers.createUploadUrls!({
			input: baseInput,
			context: ctx,
		})) as {
			uploads: Array<{ fileId: string; path: string; url: string }>;
		};

		expect(m.claimInstructionFileStagingKey).toHaveBeenCalledWith({
			fileId: "f1",
			snapshotId: "snap_1",
			projectId: "proj_1",
			organizationId: "org_1",
			from: "projects/proj_1/instructions/staging/pending/0",
			to: "projects/proj_1/instructions/staging/snap_1/f1",
		});
		expect(m.claimInstructionFileStagingKey).toHaveBeenCalledWith({
			fileId: "f2",
			snapshotId: "snap_1",
			projectId: "proj_1",
			organizationId: "org_1",
			from: "projects/proj_1/instructions/staging/pending/1",
			to: "projects/proj_1/instructions/staging/snap_1/f2",
		});
		expect(result.uploads).toEqual([
			{
				fileId: "f1",
				path: "CLAUDE.md",
				url: "https://signed/projects/proj_1/instructions/staging/snap_1/f1",
				contentType: "text/markdown",
			},
			{
				fileId: "f2",
				path: "AGENTS.md",
				url: "https://signed/projects/proj_1/instructions/staging/snap_1/f2",
				contentType: "text/markdown",
			},
		]);
	});

	// Critical 1 (round 4): a repeat request for a page whose URLs expired is
	// ordinary, and it must not write.
	it("does not rewrite a file whose storage key is already correct", async () => {
		m.listInstructionFiles.mockResolvedValue([
			{
				id: "f1",
				path: "CLAUDE.md",
				storageKey: "projects/proj_1/instructions/staging/snap_1/f1",
				kind: "INSTRUCTIONS",
				name: null,
				description: null,
				mimeType: "text/markdown",
			},
		]);
		const result = (await m.handlers.createUploadUrls!({
			input: { ...baseInput, fileIds: ["f1"] },
			context: ctx,
		})) as { uploads: Array<{ url: string }> };

		expect(m.claimInstructionFileStagingKey).not.toHaveBeenCalled();
		expect(result.uploads[0]?.url).toBe(
			"https://signed/projects/proj_1/instructions/staging/snap_1/f1",
		);
	});

	/**
	 * Critical 1 (round 4). The handler checked RECEIVING once and then
	 * rewrote any non-staging key with an update constrained by file id and
	 * organization alone. A request that had already passed that check could,
	 * after finalization promoted a file to its IMMUTABLE snapshot key, point
	 * the row back at writable staging and return a signed PUT for it — so a
	 * READY, published snapshot served bytes the gate never scanned while its
	 * recorded digest still described the original content.
	 */
	it("refuses a file already promoted to its immutable snapshot key, and writes nothing", async () => {
		m.listInstructionFiles.mockResolvedValue([
			{
				id: "f1",
				path: "CLAUDE.md",
				// The promoted key: `snapshots/`, not `staging/`.
				storageKey: "projects/proj_1/instructions/snapshots/snap_1/f1",
				kind: "INSTRUCTIONS",
				name: null,
				description: null,
				mimeType: "text/markdown",
			},
		]);
		const sign = vi.fn(async (key: string) => `https://signed/${key}`);
		m.getStorageProvider.mockReturnValue({
			supportsPresignedUrls: true,
			getSignedUploadUrl: sign,
		});

		await expect(
			m.handlers.createUploadUrls!({
				input: { ...baseInput, fileIds: ["f1"] },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.claimInstructionFileStagingKey).not.toHaveBeenCalled();
		expect(sign).not.toHaveBeenCalled();
	});

	// The same refusal when the conditional write itself matches nothing: the
	// snapshot left RECEIVING, or the row moved, between the listing and the
	// UPDATE. The response must not say which.
	it("refuses when the conditional staging-key claim matches no row", async () => {
		m.claimInstructionFileStagingKey.mockResolvedValue({ moved: false });
		const sign = vi.fn(async (key: string) => `https://signed/${key}`);
		m.getStorageProvider.mockReturnValue({
			supportsPresignedUrls: true,
			getSignedUploadUrl: sign,
		});

		await expect(
			m.handlers.createUploadUrls!({
				input: { ...baseInput, fileIds: ["f1"] },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(sign).not.toHaveBeenCalled();
	});

	it("404s when the snapshot does not exist or is not scoped to this org/project", async () => {
		m.getInstructionSnapshot.mockResolvedValue(null);
		await expect(
			m.handlers.createUploadUrls!({ input: baseInput, context: ctx }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.listInstructionFiles).not.toHaveBeenCalled();
	});

	it("404s when the snapshot is no longer RECEIVING", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			id: "snap_1",
			status: "VALIDATING",
		});
		await expect(
			m.handlers.createUploadUrls!({ input: baseInput, context: ctx }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("only signs files matching the requested fileIds, never the whole snapshot", async () => {
		await m.handlers.createUploadUrls!({
			input: { ...baseInput, fileIds: ["f1"] },
			context: ctx,
		});
		expect(m.claimInstructionFileStagingKey).toHaveBeenCalledTimes(1);
		expect(m.claimInstructionFileStagingKey).toHaveBeenCalledWith(
			expect.objectContaining({ fileId: "f1" }),
		);
	});

	// I5: a caller who belongs to more than one organization used to strand
	// their own upload here. `begin` tagged the snapshot with the PROJECT's
	// hosting organization; this procedure resolved the caller's ACTIVE
	// organization, the tenant-scoped snapshot lookup missed, and the page of
	// URLs 404'd with a RECEIVING snapshot that could never be finished.
	it("uses the project's hosting organization, not the caller's active one", async () => {
		const result = (await m.handlers.createUploadUrls!({
			input: { ...baseInput, organizationId: "org_active" },
			context: {
				user: { id: "user_1" },
				session: { activeOrganizationId: "org_active" },
			},
		})) as { uploads: unknown[] };

		expect(m.resolveEffectiveProjectPermissions).toHaveBeenCalledWith(
			"proj_1",
			"user_1",
		);
		// The scoped lookup ran against the host org — the organization the
		// caller named and the one on their session are both ignored.
		expect(m.getInstructionSnapshot).toHaveBeenCalledWith(
			"snap_1",
			"proj_1",
			"org_1",
		);
		expect(result.uploads).toHaveLength(2);
	});

	// I4: the provider's default expiry is 60 seconds and a page is 200 URLs
	// drained by six workers, so the tail of the queue was reached after its
	// URLs had already expired — and each per-file retry reused the same dead
	// URL, which is why a retry of the dialog reproduced it exactly.
	it("signs each upload URL with an explicit 15-minute expiry", async () => {
		const sign = vi.fn(async (key: string) => `https://signed/${key}`);
		m.getStorageProvider.mockReturnValue({
			supportsPresignedUrls: true,
			getSignedUploadUrl: sign,
		});

		await m.handlers.createUploadUrls!({ input: baseInput, context: ctx });

		expect(sign).toHaveBeenCalledWith(
			"projects/proj_1/instructions/staging/snap_1/f1",
			expect.objectContaining({ expiresIn: 900 }),
		);
	});

	it("binds proposal upload length to an immutable absolute signing boundary", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-18T00:59:50Z"));
		m.getInstructionSnapshot.mockResolvedValue({
			id: "snap_1",
			status: "RECEIVING",
			userId: "user_1",
			proposalStatus: "PENDING",
			createdAt: new Date("2026-09-18T00:00:00Z"),
		});
		const sign = vi.fn(async (key: string) => `https://signed/${key}`);
		m.getStorageProvider.mockReturnValue({
			supportsPresignedUrls: true,
			getSignedUploadUrl: sign,
		});

		await m.handlers.createUploadUrls!({
			input: { ...baseInput, fileIds: ["f1"] },
			context: ctx,
		});

		expect(sign).toHaveBeenCalledWith(
			"projects/proj_1/instructions/staging/snap_1/f1",
			expect.objectContaining({
				contentLength: 123,
				expiresIn: 3600,
				signingDate: new Date("2026-09-18T00:00:00Z"),
			}),
		);
		expect(m.authorizeInstructionProposalUploadUrls).toHaveBeenCalledWith({
			snapshotId: "snap_1",
			projectId: "proj_1",
			organizationId: "org_1",
			createdAfter: new Date("2026-09-17T23:59:50.999Z"),
		});
		vi.useRealTimers();
	});

	it("withholds URLs when signing crosses the lease or a concurrent cancellation wins", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-18T00:59:59Z"));
		m.getInstructionSnapshot.mockResolvedValue({
			id: "snap_1",
			status: "RECEIVING",
			userId: "user_1",
			proposalStatus: "PENDING",
			createdAt: new Date("2026-09-18T00:00:00Z"),
		});
		m.getStorageProvider.mockReturnValue({
			supportsPresignedUrls: true,
			getSignedUploadUrl: vi.fn(async () => {
				vi.setSystemTime(new Date("2026-09-18T01:00:01Z"));
				return "https://signed/expired";
			}),
		});
		m.authorizeInstructionProposalUploadUrls.mockResolvedValue({
			authorized: false,
		});

		await expect(
			m.handlers.createUploadUrls!({
				input: { ...baseInput, fileIds: ["f1"] },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.authorizeInstructionProposalUploadUrls).toHaveBeenCalledAfter(
			m.getStorageProvider.mock.results[0]?.value
				.getSignedUploadUrl as ReturnType<typeof vi.fn>,
		);
		vi.useRealTimers();
	});

	it("refuses to mint proposal upload URLs after the signing boundary", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-18T01:00:00Z"));
		m.getInstructionSnapshot.mockResolvedValue({
			id: "snap_1",
			status: "RECEIVING",
			userId: "user_1",
			proposalStatus: "PENDING",
			createdAt: new Date("2026-09-18T00:00:00Z"),
		});
		const sign = vi.fn();
		m.getStorageProvider.mockReturnValue({
			supportsPresignedUrls: true,
			getSignedUploadUrl: sign,
		});

		await expect(
			m.handlers.createUploadUrls!({ input: baseInput, context: ctx }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(sign).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	// R14: `getSignedUploadUrl` on the storage provider is nullable
	// (packages/storage/types.ts:194). Guard exactly like
	// documents/create-media-upload-url.ts:84-96
	// (`supportsPresignedUrls && getSignedUploadUrl`).
	it("throws PRECONDITION_FAILED when the storage provider cannot sign uploads", async () => {
		m.getStorageProvider.mockReturnValue({
			supportsPresignedUrls: false,
			getSignedUploadUrl: null,
		});
		await expect(
			m.handlers.createUploadUrls!({ input: baseInput, context: ctx }),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(m.listInstructionFiles).not.toHaveBeenCalled();
	});
});
