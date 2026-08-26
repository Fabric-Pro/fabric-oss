import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => {
	class P2002 extends Error {
		code = "P2002";
	}
	return {
		db: {
			userStory: { findFirst: vi.fn() },
			storyAttachment: {
				count: vi.fn(),
				create: vi.fn(),
				delete: vi.fn(),
				findUnique: vi.fn(),
			},
			$queryRaw: vi.fn(),
			$transaction: vi.fn(),
		},
		Prisma: { PrismaClientKnownRequestError: P2002 },
	};
});
vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "project-contexts" } },
	},
}));
vi.mock("@repo/storage", () => ({ getStorageProvider: vi.fn() }));
vi.mock("../../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({
		handler: fn,
		__permission: chain.__permission,
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (p: string) => {
			chain.__permission = p;
			return () => chain;
		},
		Permissions: { STORY_UPDATE: "story:update", STORY_READ: "story:read" },
	};
});

import { db, Prisma } from "@repo/database";
import { getStorageProvider } from "@repo/storage";
import { createAttachmentProcedure } from "../create-attachment";

const handler = (createAttachmentProcedure as unknown as { handler: Function })
	.handler;
const ctx = { user: { id: "u1" }, session: {} };
const tempKey = "story-attachments-tmp/p1/s1/abc.pdf";
const finalKey = "story-attachments/p1/s1/abc.pdf";
const input = {
	projectId: "p1",
	userStoryId: "s1",
	storageKey: tempKey,
	filename: "spec.pdf",
};

// A provider mock with the three methods reserve-then-promote uses.
function provider(over: Record<string, unknown> = {}) {
	return {
		getFileMetadata: vi
			.fn()
			.mockResolvedValue({ size: 1234, contentType: "application/pdf" }),
		copyFile: vi.fn().mockResolvedValue(undefined),
		deleteFile: vi.fn().mockResolvedValue(undefined),
		...over,
	};
}

// A $transaction stub that runs the callback against a tx whose count/create are
// configurable. Default: empty story, create returns a row with id "a1". A throw
// inside the callback propagates out (faithful to real Prisma $transaction).
function txOk(
	over: { count?: number; create?: ReturnType<typeof vi.fn> } = {},
) {
	return async (fn: Function) =>
		fn({
			$queryRaw: vi.fn().mockResolvedValue([{ id: "s1" }]),
			storyAttachment: {
				count: vi.fn().mockResolvedValue(over.count ?? 0),
				create:
					over.create ??
					vi.fn().mockResolvedValue({
						id: "a1",
						filename: "spec.pdf",
						designation: "LOCKED",
						source: "FABRIC",
						sizeBytes: 1234,
						mimeType: "application/pdf",
					}),
			},
		});
}

let prov: ReturnType<typeof provider>;

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(db.userStory.findFirst).mockResolvedValue({ id: "s1" } as never);
	prov = provider();
	vi.mocked(getStorageProvider).mockReturnValue(prov as never);
	vi.mocked(db.$transaction).mockImplementation(txOk());
	vi.mocked(db.storyAttachment.findUnique).mockResolvedValue({
		id: "a1",
	} as never);
});

describe("createAttachment (reserve-then-promote)", () => {
	it("is gated on STORY_UPDATE", () => {
		expect(
			(createAttachmentProcedure as unknown as { __permission: string })
				.__permission,
		).toBe("story:update");
	});

	it("NOT_FOUND when the story is not in the project", async () => {
		vi.mocked(db.userStory.findFirst).mockResolvedValue(null);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	// --- Structural temp-key validation ---
	it("BAD_REQUEST when the key belongs to a different story", async () => {
		await expect(
			handler({
				input: {
					...input,
					storageKey: "story-attachments-tmp/p1/OTHER/x.pdf",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
	it("BAD_REQUEST when the key uses the FINAL prefix (promotion bypass attempt)", async () => {
		await expect(
			handler({
				input: {
					...input,
					storageKey: "story-attachments/p1/s1/x.pdf",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(prov.copyFile).not.toHaveBeenCalled();
	});
	it("BAD_REQUEST when the key suffix has extra path segments (traversal)", async () => {
		await expect(
			handler({
				input: {
					...input,
					storageKey: "story-attachments-tmp/p1/s1/a/b.pdf",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	// --- HEAD verification ---
	it("BAD_REQUEST when the temp object is absent (HEAD returns null)", async () => {
		prov = provider({ getFileMetadata: vi.fn().mockResolvedValue(null) });
		vi.mocked(getStorageProvider).mockReturnValue(prov as never);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});
	it("SERVICE_UNAVAILABLE when HEAD throws (transient provider error)", async () => {
		prov = provider({
			getFileMetadata: vi
				.fn()
				.mockRejectedValue(
					new Error("Could not get file metadata from S3"),
				),
		});
		vi.mocked(getStorageProvider).mockReturnValue(prov as never);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
		expect(prov.copyFile).not.toHaveBeenCalled();
	});
	it("BAD_REQUEST when HEAD size exceeds the max", async () => {
		prov = provider({
			getFileMetadata: vi.fn().mockResolvedValue({
				size: 26 * 1024 * 1024,
				contentType: "application/pdf",
			}),
		});
		vi.mocked(getStorageProvider).mockReturnValue(prov as never);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});
	it("rejects a disallowed HEAD content-type", async () => {
		prov = provider({
			getFileMetadata: vi.fn().mockResolvedValue({
				size: 1234,
				contentType: "application/x-msdownload",
			}),
		});
		vi.mocked(getStorageProvider).mockReturnValue(prov as never);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});
	it("rejects an empty HEAD content-type (octet-stream not allowlisted)", async () => {
		prov = provider({
			getFileMetadata: vi
				.fn()
				.mockResolvedValue({ size: 1234, contentType: "" }),
		});
		vi.mocked(getStorageProvider).mockReturnValue(prov as never);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	// --- Happy path: reserve, then promote ---
	it("inserts LOCKED/FABRIC with sizeBytes from HEAD and sanitized filename", async () => {
		const res = await handler({
			input: { ...input, filename: "../weird\r\n.pdf" },
			context: ctx,
		});
		expect(res.attachment.designation).toBe("LOCKED");
		expect(res.attachment.sizeBytes).toBe(1234);
	});
	it("persists mimeType + sizeBytes from HEAD, with the FINAL storageKey", async () => {
		const create = vi.fn().mockResolvedValue({
			id: "a1",
			designation: "LOCKED",
			sizeBytes: 1234,
			mimeType: "application/pdf",
		});
		vi.mocked(db.$transaction).mockImplementation(txOk({ create }));
		await handler({ input, context: ctx });
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					mimeType: "application/pdf",
					sizeBytes: 1234,
					storageKey: finalKey,
					designation: "LOCKED",
					source: "FABRIC",
				}),
			}),
		);
	});
	it("persists the provided designation (UNLOCKED) when passed by the create flow", async () => {
		const create = vi.fn().mockResolvedValue({
			id: "a1",
			designation: "UNLOCKED",
			sizeBytes: 1234,
			mimeType: "application/pdf",
		});
		vi.mocked(db.$transaction).mockImplementation(txOk({ create }));
		await handler({
			input: { ...input, designation: "UNLOCKED" },
			context: ctx,
		});
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ designation: "UNLOCKED" }),
			}),
		);
	});
	it("does not expose storageKey in the returned attachment", async () => {
		const create = vi.fn().mockResolvedValue({
			id: "a1",
			filename: "spec.pdf",
			designation: "LOCKED",
			source: "FABRIC",
			sizeBytes: 1234,
			mimeType: "application/pdf",
		});
		vi.mocked(db.$transaction).mockImplementation(txOk({ create }));
		const res = await handler({ input, context: ctx });
		expect(
			(res.attachment as Record<string, unknown>).storageKey,
		).toBeUndefined();
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				select: expect.not.objectContaining({ storageKey: true }),
			}),
		);
	});
	it("promotes temp -> final via copyFile AFTER reserving, then deletes the temp object", async () => {
		const create = vi.fn().mockResolvedValue({
			id: "a1",
			filename: "spec.pdf",
			designation: "LOCKED",
			source: "FABRIC",
			sizeBytes: 1234,
			mimeType: "application/pdf",
		});
		vi.mocked(db.$transaction).mockImplementation(txOk({ create }));
		await handler({ input, context: ctx });
		expect(prov.copyFile).toHaveBeenCalledWith(tempKey, finalKey, {
			bucket: "project-contexts",
		});
		expect(prov.deleteFile).toHaveBeenCalledWith(tempKey, {
			bucket: "project-contexts",
		});
		// Insert MUST happen before the copy (reserve-then-promote ordering, spec §5).
		expect(create.mock.invocationCallOrder[0]).toBeLessThan(
			prov.copyFile.mock.invocationCallOrder[0],
		);
	});

	// --- BLOCKER fix: no overwrite path on a losing reservation ---
	it("CONFLICT on duplicate finalKey (P2002) and NEVER calls copyFile", async () => {
		vi.mocked(db.$transaction).mockRejectedValue(
			Object.assign(new Prisma.PrismaClientKnownRequestError("dup"), {
				code: "P2002",
			}),
		);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(prov.copyFile).not.toHaveBeenCalled();
		expect(prov.deleteFile).toHaveBeenCalledWith(tempKey, {
			bucket: "project-contexts",
		});
	});
	it("BAD_REQUEST when the per-story cap is reached and NEVER calls copyFile", async () => {
		vi.mocked(db.$transaction).mockImplementation(txOk({ count: 20 }));
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(prov.copyFile).not.toHaveBeenCalled();
		expect(prov.deleteFile).toHaveBeenCalledWith(tempKey, {
			bucket: "project-contexts",
		});
	});

	// --- Promote failure: compensate the row, keep temp ---
	it("SERVICE_UNAVAILABLE on copy failure; deletes the reserved row and KEEPS temp", async () => {
		prov = provider({
			copyFile: vi.fn().mockRejectedValue(new Error("AccessDenied")),
		});
		vi.mocked(getStorageProvider).mockReturnValue(prov as never);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
		expect(db.storyAttachment.delete).toHaveBeenCalledWith({
			where: { id: "a1" },
		});
		expect(prov.deleteFile).not.toHaveBeenCalled(); // load-bearing: temp kept so a same-key retry can re-HEAD + re-promote
	});

	// --- Transient reservation error: keep temp ---
	it("rethrows a transient tx error and KEEPS temp (no copy, no temp delete)", async () => {
		vi.mocked(db.$transaction).mockRejectedValue(
			new Error("connection reset"),
		);
		await expect(handler({ input, context: ctx })).rejects.toThrow(
			"connection reset",
		);
		expect(prov.copyFile).not.toHaveBeenCalled();
		expect(prov.deleteFile).not.toHaveBeenCalled();
	});

	// --- Post-copy ownership re-check (closes the promote-after-delete orphan race) ---
	it("row deleted during copy: removes the orphaned final object + temp, throws NOT_FOUND", async () => {
		vi.mocked(db.storyAttachment.findUnique).mockResolvedValue(
			null as never,
		);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		// copyFile ran — that is why there is an orphan to clean up
		expect(prov.copyFile).toHaveBeenCalledWith(tempKey, finalKey, {
			bucket: "project-contexts",
		});
		// compensating delete of the object we just (re)created, plus the temp object
		expect(prov.deleteFile).toHaveBeenCalledWith(finalKey, {
			bucket: "project-contexts",
		});
		expect(prov.deleteFile).toHaveBeenCalledWith(tempKey, {
			bucket: "project-contexts",
		});
	});

	it("row survives: success path untouched (no final-key delete; queries the reserved row)", async () => {
		vi.mocked(db.storyAttachment.findUnique).mockResolvedValue({
			id: "a1",
		} as never);
		const res = await handler({ input, context: ctx });
		expect(res.attachment).toBeDefined();
		// only the temp object is cleaned up; the final object is never deleted
		expect(prov.deleteFile).toHaveBeenCalledWith(tempKey, {
			bucket: "project-contexts",
		});
		expect(prov.deleteFile).not.toHaveBeenCalledWith(finalKey, {
			bucket: "project-contexts",
		});
		// the re-check read the row we reserved
		expect(db.storyAttachment.findUnique).toHaveBeenCalledWith({
			where: { id: "a1" },
			select: { id: true },
		});
	});

	it("re-check read throws: assumes owned, returns success, never deletes the final object", async () => {
		vi.mocked(db.storyAttachment.findUnique).mockRejectedValue(
			new Error("connection reset"),
		);
		const res = await handler({ input, context: ctx });
		expect(res.attachment).toBeDefined();
		// the re-check WAS attempted (this fails before impl: current code never calls findUnique)
		expect(db.storyAttachment.findUnique).toHaveBeenCalled();
		// unconfirmed read must NOT delete the final object; only the temp is cleaned
		expect(prov.deleteFile).not.toHaveBeenCalledWith(finalKey, {
			bucket: "project-contexts",
		});
		expect(prov.deleteFile).toHaveBeenCalledWith(tempKey, {
			bucket: "project-contexts",
		});
	});

	it("cap count excludes soft-deleted rows", async () => {
		let capturedCountMock: ReturnType<typeof vi.fn> | undefined;
		vi.mocked(db.$transaction).mockImplementation(async (fn: Function) =>
			fn({
				$queryRaw: vi.fn().mockResolvedValue([{ id: "s1" }]),
				storyAttachment: {
					count: (capturedCountMock = vi.fn().mockResolvedValue(0)),
					create: vi.fn().mockResolvedValue({
						id: "a1",
						filename: "spec.pdf",
						designation: "LOCKED",
						source: "FABRIC",
						sizeBytes: 1234,
						mimeType: "application/pdf",
					}),
				},
			}),
		);
		await handler({ input, context: ctx });
		expect(capturedCountMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					storyId: "s1",
					deletedAt: null,
				}),
			}),
		);
	});
});

describe("createAttachment — excalidraw content validation (#1942)", () => {
	const EX_MIME = "application/vnd.excalidraw+json";
	const exKey = "story-attachments-tmp/p1/s1/d.excalidraw";
	const validDoc = JSON.stringify({
		type: "excalidraw",
		version: 2,
		elements: [],
	});

	function exProvider(over: Record<string, unknown> = {}) {
		return provider({
			getFileMetadata: vi
				.fn()
				.mockResolvedValue({ size: 1234, contentType: EX_MIME }),
			downloadFile: vi.fn().mockResolvedValue({
				data: Buffer.from(validDoc, "utf-8"),
				contentType: EX_MIME,
				size: 1234,
			}),
			...over,
		});
	}

	function exCreate() {
		return vi.fn().mockResolvedValue({
			id: "a1",
			filename: "d.excalidraw",
			designation: "LOCKED",
			source: "FABRIC",
			sizeBytes: 1234,
			mimeType: EX_MIME,
		});
	}

	it("downloads + validates the body, then promotes a valid .excalidraw", async () => {
		prov = exProvider();
		vi.mocked(getStorageProvider).mockReturnValue(prov as never);
		vi.mocked(db.$transaction).mockImplementation(
			txOk({ create: exCreate() }),
		);
		const res = await handler({
			input: { ...input, storageKey: exKey, filename: "d.excalidraw" },
			context: ctx,
		});
		expect(res.attachment).toBeDefined();
		expect(prov.downloadFile).toHaveBeenCalledWith(exKey, {
			bucket: "project-contexts",
		});
		expect(prov.copyFile).toHaveBeenCalled();
	});

	it("BAD_REQUEST + temp deleted when the body is malformed JSON", async () => {
		prov = exProvider({
			downloadFile: vi.fn().mockResolvedValue({
				data: Buffer.from("{ not json", "utf-8"),
				contentType: EX_MIME,
				size: 10,
			}),
		});
		vi.mocked(getStorageProvider).mockReturnValue(prov as never);
		await expect(
			handler({
				input: {
					...input,
					storageKey: exKey,
					filename: "d.excalidraw",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(prov.copyFile).not.toHaveBeenCalled();
		expect(prov.deleteFile).toHaveBeenCalledWith(exKey, {
			bucket: "project-contexts",
		});
	});

	it("BAD_REQUEST when the body is valid JSON but not an excalidraw doc (renamed file)", async () => {
		prov = exProvider({
			downloadFile: vi.fn().mockResolvedValue({
				data: Buffer.from(JSON.stringify({ hello: 1 }), "utf-8"),
				contentType: EX_MIME,
				size: 10,
			}),
		});
		vi.mocked(getStorageProvider).mockReturnValue(prov as never);
		await expect(
			handler({
				input: {
					...input,
					storageKey: exKey,
					filename: "d.excalidraw",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(prov.copyFile).not.toHaveBeenCalled();
	});

	it("SERVICE_UNAVAILABLE + temp KEPT when downloadFile throws (transient)", async () => {
		prov = exProvider({
			downloadFile: vi
				.fn()
				.mockRejectedValue(
					new Error("Could not download file from S3"),
				),
		});
		vi.mocked(getStorageProvider).mockReturnValue(prov as never);
		await expect(
			handler({
				input: {
					...input,
					storageKey: exKey,
					filename: "d.excalidraw",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(prov.copyFile).not.toHaveBeenCalled();
		expect(prov.deleteFile).not.toHaveBeenCalled();
	});

	it("BAD_REQUEST + temp deleted when a .excalidraw exceeds the content-sniff ceiling", async () => {
		prov = exProvider({
			getFileMetadata: vi.fn().mockResolvedValue({
				size: 6 * 1024 * 1024,
				contentType: EX_MIME,
			}),
		});
		vi.mocked(getStorageProvider).mockReturnValue(prov as never);
		await expect(
			handler({
				input: {
					...input,
					storageKey: exKey,
					filename: "d.excalidraw",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(prov.downloadFile).not.toHaveBeenCalled();
		expect(prov.deleteFile).toHaveBeenCalledWith(exKey, {
			bucket: "project-contexts",
		});
	});
});
