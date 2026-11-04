import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	createWorkspaceDocumentContentReader,
	WorkspaceDocumentContentError,
	type WorkspaceDocumentPageRow,
} from "../src/workspace-document-content";

const actor = { userId: "example-user", organizationId: "example-org" };
const input = {
	workspaceId: "example-workspace",
	documentId: "example-document",
};
function fixture(
	content = "A😀éBC",
	override: Partial<WorkspaceDocumentPageRow> = {},
) {
	const revision = createHash("sha256").update(content).digest("hex");
	const authorize = vi.fn(async () => {});
	const readPage = vi.fn(
		async (request: { offset: number; limit: number }) => ({
			id: input.documentId,
			workspaceId: input.workspaceId,
			filename: "example.txt",
			mimeType: "text/plain",
			status: "READY",
			text: Array.from(content)
				.slice(request.offset, request.offset + request.limit)
				.join(""),
			revision,
			totalCharacters: Array.from(content).length,
			totalBytes: Buffer.byteLength(content),
			...override,
		}),
	);
	return {
		revision,
		authorize,
		readPage,
		read: createWorkspaceDocumentContentReader({ authorize, readPage }),
	};
}

describe("revision-consistent bounded Workspace content", () => {
	it("returns a code-point page, exact content hash/bytes and truthful capabilities without splitting emoji", async () => {
		const f = fixture();
		const first = await f.read(actor, { ...input, limit: 2 });
		expect(first).toMatchObject({
			text: "A😀",
			offset: 0,
			limit: 2,
			nextOffset: 2,
			totalCharacters: 5,
			totalBytes: 9,
			contentHash: f.revision,
			revision: f.revision,
			offsetUnit: "unicode_code_points",
			readMode: "direct",
			historicalVersionsAvailable: false,
		});
		const second = await f.read(actor, {
			...input,
			offset: first.nextOffset,
			limit: 3,
			expectedRevision: first.revision,
		});
		expect(second).toMatchObject({
			text: "éBC",
			nextOffset: null,
			truncated: false,
			revision: first.revision,
		});
		expect(f.authorize).toHaveBeenCalledTimes(4);
	});
	it("requires a pinned revision for continuations before reading any body", async () => {
		const f = fixture();
		await expect(
			f.read(actor, { ...input, offset: 1 }),
		).rejects.toMatchObject({ code: "REVISION_REQUIRED", status: 400 });
		expect(f.readPage).not.toHaveBeenCalled();
	});
	it("refuses changed revisions without returning new content", async () => {
		const f = fixture("new content");
		await expect(
			f.read(actor, {
				...input,
				offset: 1,
				expectedRevision: "a".repeat(64),
			}),
		).rejects.toMatchObject({ code: "STALE_REVISION", status: 409 });
	});
	it.each([0, 20_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -1])(
		"refuses invalid limit %s instead of silently clamping",
		async (limit) => {
			const f = fixture();
			await expect(
				f.read(actor, { ...input, limit }),
			).rejects.toMatchObject({ code: "INVALID_INPUT" });
			expect(f.readPage).not.toHaveBeenCalled();
		},
	);
	it.each([-1, 0.5, 2147483647, Number.POSITIVE_INFINITY])(
		"refuses invalid offset %s",
		async (offset) => {
			await expect(
				fixture().read(actor, { ...input, offset }),
			).rejects.toMatchObject({ code: "INVALID_INPUT" });
		},
	);
	it.each(["PENDING", "PROCESSING", "FAILED"])(
		"never returns old extracted text while status is %s",
		async (status) => {
			await expect(
				fixture("old body", { status }).read(actor, input),
			).rejects.toMatchObject({ code: "NOT_READY", status: 409 });
		},
	);
	it("distinguishes a valid empty READY document from missing extraction", async () => {
		expect(await fixture("").read(actor, input)).toMatchObject({
			text: "",
			totalCharacters: 0,
			nextOffset: null,
			truncated: false,
		});
		await expect(
			fixture("", { text: null }).read(actor, input),
		).rejects.toMatchObject({ code: "NOT_READY" });
	});
	it("rejects missing or incorrectly bound rows identically", async () => {
		for (const override of [
			{ id: "other-document" },
			{ workspaceId: "other-workspace" },
		]) {
			await expect(
				fixture("secret", override).read(actor, input),
			).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
		}
		const read = createWorkspaceDocumentContentReader({
			authorize: vi.fn(),
			readPage: vi.fn(async () => null),
		});
		await expect(read(actor, input)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});
	it("checks live actor/object access before reading; a grant revoked during read withholds content", async () => {
		const f = fixture();
		f.authorize.mockRejectedValueOnce(
			new WorkspaceDocumentContentError("NOT_FOUND"),
		);
		await expect(f.read(actor, input)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(f.readPage).not.toHaveBeenCalled();
		f.authorize
			.mockResolvedValueOnce()
			.mockRejectedValueOnce(
				new WorkspaceDocumentContentError("FORBIDDEN"),
			);
		await expect(f.read(actor, input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(f.readPage).toHaveBeenCalledTimes(1);
	});
	it("refuses past-end offsets but permits an exact-end page", async () => {
		const f = fixture("abc");
		await expect(
			f.read(actor, {
				...input,
				offset: 4,
				expectedRevision: f.revision,
			}),
		).rejects.toMatchObject({ code: "OUT_OF_RANGE" });
		expect(
			await f.read(actor, {
				...input,
				offset: 3,
				expectedRevision: f.revision,
			}),
		).toMatchObject({ text: "", nextOffset: null });
	});
	it("rejects malformed actor, unknown fields and malformed hashes", async () => {
		const f = fixture();
		for (const raw of [
			{ ...input, expectedRevision: "not-a-hash" },
			{ ...input, extra: true },
		])
			await expect(f.read(actor, raw)).rejects.toMatchObject({
				code: "INVALID_INPUT",
			});
		await expect(
			f.read({ ...actor, organizationId: "" }, input),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		expect(f.readPage).not.toHaveBeenCalled();
	});
	it("fails closed if an adapter returns an oversized or incomplete page", async () => {
		await expect(
			fixture("abc", { text: "abc" }).read(actor, { ...input, limit: 1 }),
		).rejects.toThrow("Invalid bounded");
		await expect(
			fixture("abc", { text: "" }).read(actor, input),
		).rejects.toThrow("Invalid bounded");
	});
});
