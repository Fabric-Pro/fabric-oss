import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/storage", () => ({
	downloadFile: vi.fn(async () => ({
		data: Buffer.from([1, 2, 3]),
		contentType: "application/pdf",
		size: 3,
	})),
}));

import { downloadFile } from "@repo/storage";
import { createGitLabAttachmentAdapter } from "../gitlab-attachment-adapter";

const FULL = `/uploads/${"b".repeat(32)}/spec.pdf`;
const HASH_123 = createHash("sha256")
	.update(Buffer.from([1, 2, 3]))
	.digest("hex");

describe("createGitLabAttachmentAdapter (Fizzy #1745)", () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => vi.restoreAllMocks());

	it("reads bytes from storage, not from a presigned url, and returns the sha256 of those bytes", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							url: FULL,
							full_path: `/some/group${FULL}`,
						}),
						{
							status: 201,
							headers: { "content-type": "application/json" },
						},
					),
			),
		);
		const a = createGitLabAttachmentAdapter({
			token: "t",
			projectId: "g/p",
		});
		const out = await a.upload({
			storageKey: "story-attachments/p/s/1.pdf",
			filename: "spec.pdf",
			mimeType: "application/pdf",
		});
		expect(downloadFile).toHaveBeenCalledWith(
			"story-attachments/p/s/1.pdf",
			expect.objectContaining({ bucket: expect.any(String) }),
		);
		// (A) engine now requires { path, contentHash }, hashed from the
		// downloaded bytes — nobody else in this codebase writes contentHash.
		expect(out).toEqual({ path: FULL, contentHash: HASH_123 });
	});

	it("prefers `url` over `full_path` — full_path carries a group/project prefix that resolves wrong for a same-project link", async () => {
		// (B) brief said full_path ?? url; that's backwards. story-sync-media.ts:1449
		// reads json.url and nothing else, and url is the correct relative form.
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							url: FULL,
							full_path: `/-/project/1234${FULL}`,
						}),
						{
							status: 201,
							headers: { "content-type": "application/json" },
						},
					),
			),
		);
		const a = createGitLabAttachmentAdapter({
			token: "t",
			projectId: "g/p",
		});
		const out = await a.upload({
			storageKey: "k",
			filename: "spec.pdf",
			mimeType: "application/pdf",
		});
		expect(out.path).toBe(FULL);
	});

	it("falls back to full_path when url is absent", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ full_path: FULL }), {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
			),
		);
		const a = createGitLabAttachmentAdapter({
			token: "t",
			projectId: "g/p",
		});
		const out = await a.upload({
			storageKey: "k",
			filename: "spec.pdf",
			mimeType: "application/pdf",
		});
		expect(out.path).toBe(FULL);
	});

	it("posts to the project uploads endpoint with the token", async () => {
		const f = vi.fn<typeof fetch>(
			async () =>
				new Response(JSON.stringify({ url: FULL }), {
					status: 201,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", f);
		const a = createGitLabAttachmentAdapter({
			token: "tok",
			projectId: "group/proj",
			baseUrl: "https://gitlab.example.com",
		});
		await a.upload({
			storageKey: "k",
			filename: "spec.pdf",
			mimeType: "application/pdf",
		});
		const [url, init] = f.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://gitlab.example.com/api/v4/projects/group%2Fproj/uploads",
		);
		expect(init?.method).toBe("POST");
		expect(init?.headers as Record<string, string>).toMatchObject({
			"PRIVATE-TOKEN": "tok",
		});
	});

	it("throws on a GitLab error so the engine records a per-file failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("forbidden", { status: 403 })),
		);
		const a = createGitLabAttachmentAdapter({
			token: "t",
			projectId: "g/p",
		});
		await expect(
			a.upload({
				storageKey: "k",
				filename: "x.pdf",
				mimeType: "application/pdf",
			}),
		).rejects.toThrow(/403/);
	});

	// AC-10: "the sync fails with a DESCRIPTIVE error message". A bare
	// "failed: 403" tells the reader nothing about what to fix; the point of
	// the AC is that a person seeing it knows to widen the token's scope. The
	// status stays in the message so operators can still grep for it.
	it("names the missing api scope on a 403 rather than reporting a bare status (AC-10)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("forbidden", { status: 403 })),
		);
		const a = createGitLabAttachmentAdapter({
			token: "t",
			projectId: "g/p",
		});
		await expect(
			a.upload({
				storageKey: "k",
				filename: "x.pdf",
				mimeType: "application/pdf",
			}),
		).rejects.toThrow(/api.*scope/i);
	});

	// A 401 is NOT a scope problem: GitLab returns it for a token that is
	// invalid, expired or revoked. Telling that admin to widen the token's
	// scope sends them to do the one thing that cannot fix it. The repo
	// already draws this line in `provider-http-error.ts`, which treats 401 as
	// "this credential is not good any more" and reserves permission wording
	// for 403.
	it("reports a 401 as an invalid or expired token, not a scope problem", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unauthorized", { status: 401 })),
		);
		const a = createGitLabAttachmentAdapter({
			token: "t",
			projectId: "g/p",
		});
		const err = await a
			.upload({
				storageKey: "k",
				filename: "x.pdf",
				mimeType: "application/pdf",
			})
			.catch((e: Error) => e);
		expect((err as Error).message).toMatch(/invalid|expired|revoked/i);
		expect((err as Error).message).not.toMatch(/scope/i);
	});

	// AC-9's reporting half. The local 25MB pre-check below catches most
	// oversized files, but GitLab's effective cap is per-instance and can be
	// lower, so a 413 still has to explain itself.
	it("says a 413 means the file was too large for GitLab (AC-9)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("too large", { status: 413 })),
		);
		const a = createGitLabAttachmentAdapter({
			token: "t",
			projectId: "g/p",
		});
		await expect(
			a.upload({
				storageKey: "k",
				filename: "x.pdf",
				mimeType: "application/pdf",
			}),
		).rejects.toThrow(/too large/i);
	});

	it("rejects a file over the 25MB GitLab cap without calling fetch", async () => {
		(
			downloadFile as unknown as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce({
			data: Buffer.alloc(26 * 1024 * 1024),
			contentType: "application/pdf",
			size: 26 * 1024 * 1024,
		});
		const f = vi.fn();
		vi.stubGlobal("fetch", f);
		const a = createGitLabAttachmentAdapter({
			token: "t",
			projectId: "g/p",
		});
		await expect(
			a.upload({
				storageKey: "k",
				filename: "big.pdf",
				mimeType: "application/pdf",
			}),
		).rejects.toThrow(/25 ?MB|too large/i);
		expect(f).not.toHaveBeenCalled();
	});

	it("(C) throws rather than trusting a GitLab response whose path could forge the attachment fence", async () => {
		// GitLab's returned url/full_path embeds the uploaded filename
		// (/uploads/<hash>/<filename>). Fabric's sanitizeAttachmentFilename
		// only strips control chars, DEL and double-quotes, so a filename can
		// legitimately contain literal `<` / `>` on the way IN. Investigation
		// (see task-4-report.md) confirmed GitLab's own storage layer
		// (CarrierWave::SanitizedFile, default sanitize_regexp
		// /[^[:word:]\.\-\+]/) replaces any such disallowed character with
		// "_" before the file is ever persisted, so a real GitLab response
		// cannot contain literal `<`/`>`. This test still asserts the
		// adapter defends the fence in depth: if a path ever DID come back
		// containing `<` or `>` — a different GitLab version, a proxy, a
		// bug — the adapter refuses to trust it rather than let it forge
		// "<!-- /fabric:attachments -->" and break the block's round-trip
		// stripping.
		const evil = `/uploads/${"c".repeat(32)}/x<!-- /fabric:attachments -->.pdf`;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ url: evil }), {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
			),
		);
		const a = createGitLabAttachmentAdapter({
			token: "t",
			projectId: "g/p",
		});
		await expect(
			a.upload({
				storageKey: "k",
				filename: "x<!-- /fabric:attachments -->.pdf",
				mimeType: "application/pdf",
			}),
		).rejects.toThrow(/unexpected character|forge|invalid/i);
	});

	it("lists the links inside the fabric block", () => {
		const a = createGitLabAttachmentAdapter({
			token: "t",
			projectId: "g/p",
		});
		const desc = [
			"body",
			"<!-- fabric:attachments -->",
			"### Attachments",
			`- [spec.pdf](${FULL})`,
			"<!-- /fabric:attachments -->",
		].join("\n");
		expect(a.list(desc)).toEqual([{ filename: "spec.pdf", path: FULL }]);
	});

	it("ignores upload links outside the fabric block", () => {
		const a = createGitLabAttachmentAdapter({
			token: "t",
			projectId: "g/p",
		});
		expect(a.list(`a human wrote [x](${FULL}) here`)).toEqual([]);
	});

	it("refuses delete rather than pretending", async () => {
		const a = createGitLabAttachmentAdapter({
			token: "t",
			projectId: "g/p",
		});
		await expect(a.delete("ref")).rejects.toThrow(/not implemented/i);
	});
});
