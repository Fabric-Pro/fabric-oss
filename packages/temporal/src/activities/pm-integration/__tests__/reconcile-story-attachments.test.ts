import { describe, expect, it, vi } from "vitest";
import {
	type AttachmentAdapter,
	type ReconcileRow,
	reconcileStoryAttachments,
	summarizeAttachmentFailures,
} from "../reconcile-story-attachments";

const PATH = `/uploads/${"a".repeat(32)}/spec.pdf`;

function row(over: Partial<ReconcileRow> = {}): ReconcileRow {
	return {
		id: "att_1",
		filename: "spec.pdf",
		mimeType: "application/pdf",
		storageKey: "story-attachments/p/s/1.pdf",
		designation: "UNLOCKED",
		source: "FABRIC",
		contentHash: "hash-1",
		externalAttachmentId: null,
		...over,
	};
}

function adapter(over: Partial<AttachmentAdapter> = {}): AttachmentAdapter {
	return {
		upload: vi.fn(async () => ({
			path: PATH,
			contentHash: "computed-hash",
		})),
		list: vi.fn(() => []),
		delete: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		...over,
	} as AttachmentAdapter;
}

type ReconcileInput = Parameters<typeof reconcileStoryAttachments>[0];

const run = (
	rows: ReconcileRow[],
	a: AttachmentAdapter,
	extra: Partial<ReconcileInput> = {},
) =>
	reconcileStoryAttachments({
		rows,
		adapter: a,
		direction: "push",
		isTerminal: false,
		persist: vi.fn(async () => {}),
		...extra,
	});

describe("reconcileStoryAttachments — push half (Fizzy #1745)", () => {
	it("uploads an UNLOCKED FABRIC row and returns its link", async () => {
		const a = adapter();
		const res = await run([row()], a);
		expect(a.upload).toHaveBeenCalledTimes(1);
		expect(res.links).toEqual([{ filename: "spec.pdf", path: PATH }]);
		expect(res.excluded).toEqual([]);
	});

	it("never passes a LOCKED row to the adapter (AC-2)", async () => {
		const a = adapter();
		const res = await run(
			[row({ designation: "LOCKED", filename: "secret.png" })],
			a,
		);
		expect(a.upload).not.toHaveBeenCalled();
		expect(res.links).toEqual([]);
		expect(res.excluded).toEqual(["secret.png"]);
	});

	it("does not re-upload when externalAttachmentId is already set (AC-3)", async () => {
		const a = adapter();
		const res = await run([row({ externalAttachmentId: PATH })], a);
		expect(a.upload).not.toHaveBeenCalled();
		expect(res.links).toEqual([{ filename: "spec.pdf", path: PATH }]);
	});

	it("uploads a row without externalAttachmentId but skips one that already has it", async () => {
		const a = adapter();
		const unlinked = row({
			id: "a",
			filename: "new.pdf",
			externalAttachmentId: null,
		});
		const linked = row({
			id: "b",
			filename: "old.pdf",
			externalAttachmentId: "/uploads/existing/old.pdf",
		});
		const res = await run([unlinked, linked], a);
		expect(a.upload).toHaveBeenCalledTimes(1);
		expect(a.upload).toHaveBeenCalledWith(
			expect.objectContaining({ filename: "new.pdf" }),
		);
		expect(res.links).toEqual(
			expect.arrayContaining([
				{ filename: "new.pdf", path: PATH },
				{ filename: "old.pdf", path: "/uploads/existing/old.pdf" },
			]),
		);
	});

	it("uploads a row with a null contentHash", async () => {
		const a = adapter();
		const res = await run([row({ contentHash: null })], a);
		expect(a.upload).toHaveBeenCalledTimes(1);
		expect(res.links).toEqual([{ filename: "spec.pdf", path: PATH }]);
	});

	it("persists the id and the hash returned by the adapter after a successful upload", async () => {
		const persist = vi.fn(async () => {});
		await run([row()], adapter(), { persist });
		expect(persist).toHaveBeenCalledWith("att_1", {
			externalAttachmentId: PATH,
			contentHash: "computed-hash",
		});
	});

	it("continues past a failing file and records it", async () => {
		const a = adapter({
			upload: vi
				.fn()
				.mockRejectedValueOnce(new Error("413 too large"))
				.mockResolvedValueOnce({
					path: PATH,
					contentHash: "computed-hash",
				}),
		});
		const res = await run(
			[row({ id: "a", filename: "big.bin" }), row({ id: "b" })],
			a,
		);
		expect(res.failures).toEqual([
			{ filename: "big.bin", message: "413 too large", kind: "upload" },
		]);
		expect(res.links).toHaveLength(1);
		// Both rows were candidates this run, so both count as attempted.
		expect(res.attempted).toBe(2);
	});

	it("records a distinguishing message when persist fails after a successful upload", async () => {
		const a = adapter();
		const persist = vi.fn(async () => {
			throw new Error("db down");
		});
		const res = await run([row()], a, { persist });
		expect(a.upload).toHaveBeenCalledTimes(1);
		expect(res.links).toEqual([]);
		expect(res.failures).toHaveLength(1);
		expect(res.failures[0]?.filename).toBe("spec.pdf");
		expect(res.failures[0]?.message).toMatch(
			/uploaded to pm but failed to persist locally/i,
		);
		expect(res.failures[0]?.message).toMatch(/db down/);
		// The kind is what stops the summary from telling a reader the file
		// never reached the PM tool — it did.
		expect(res.failures[0]?.kind).toBe("persist");
	});

	it("skips outbound entirely for a terminal item", async () => {
		const a = adapter();
		const res = await run([row()], a, { isTerminal: true });
		expect(a.upload).not.toHaveBeenCalled();
		expect(res.links).toEqual([]);
	});

	it("reuses an existing link for a terminal item instead of dropping it", async () => {
		const a = adapter();
		const res = await run(
			[row({ externalAttachmentId: "/uploads/existing/spec.pdf" })],
			a,
			{ isTerminal: true },
		);
		expect(a.upload).not.toHaveBeenCalled();
		expect(res.links).toEqual([
			{ filename: "spec.pdf", path: "/uploads/existing/spec.pdf" },
		]);
	});

	it("on a terminal item, keeps the LOCKED note and the already-uploaded UNLOCKED link together", async () => {
		const a = adapter();
		const locked = row({
			id: "a",
			filename: "secret.png",
			designation: "LOCKED",
		});
		const linked = row({
			id: "b",
			filename: "old.pdf",
			externalAttachmentId: "/uploads/existing/old.pdf",
		});
		const res = await run([locked, linked], a, { isTerminal: true });
		expect(a.upload).not.toHaveBeenCalled();
		expect(res.excluded).toEqual(["secret.png"]);
		expect(res.links).toEqual([
			{ filename: "old.pdf", path: "/uploads/existing/old.pdf" },
		]);
	});

	it("ignores PM_SYNCED rows in the push half", async () => {
		const a = adapter();
		const res = await run([row({ source: "PM_SYNCED" })], a);
		expect(a.upload).not.toHaveBeenCalled();
		expect(res.links).toEqual([]);
	});

	it("throws on an unimplemented direction rather than silently doing nothing", async () => {
		await expect(
			// @ts-expect-error deliberately wrong direction
			run([row()], adapter(), { direction: "pull" }),
		).rejects.toThrow(/not implemented/i);
	});
});

describe("summarizeAttachmentFailures (Fizzy #1745, AC-4)", () => {
	it("counts only the files this run actually attempted, not links reused from earlier pushes", () => {
		// A story with ten already-synced attachments and one new file that
		// failed must not read "1 of 11 failed" — ten of those were never
		// uploaded this run, and LOCKED files were never candidates at all.
		const line = summarizeAttachmentFailures({
			attempted: 1,
			failures: [
				{ filename: "new.pdf", message: "boom", kind: "upload" },
			],
		});
		expect(line).toContain("1 of 1");
		expect(line).not.toContain("11");
	});

	it("does not claim a persist failure never reached GitLab — it did, and the next push will duplicate it", () => {
		const line = summarizeAttachmentFailures({
			attempted: 1,
			failures: [
				{
					filename: "spec.pdf",
					message:
						"uploaded to PM but failed to persist locally: db down",
					kind: "persist",
				},
			],
		});
		expect(line).not.toMatch(/failed to upload/i);
		expect(line).toMatch(/reached GitLab/i);
		expect(line).toContain("spec.pdf");
	});

	it("describes an upload failure and a persist failure separately in one line", () => {
		const line = summarizeAttachmentFailures({
			attempted: 2,
			failures: [
				{ filename: "a.pdf", message: "HTTP 403", kind: "upload" },
				{ filename: "b.pdf", message: "db down", kind: "persist" },
			],
		});
		expect(line).toMatch(/failed to upload/i);
		expect(line).toMatch(/reached GitLab/i);
		expect(line).toContain("a.pdf");
		expect(line).toContain("b.pdf");
	});
});
