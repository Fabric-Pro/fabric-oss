/**
 * Pull-half adapter surface (Fizzy #1745, AC-5..AC-9).
 *
 * Two new capabilities, deliberately built on the LOWEST-privilege GitLab
 * endpoints that can serve them:
 *
 * - `listRemote` needs no endpoint at all. GitLab's own upload listing
 *   (`GET /projects/:id/uploads`, 17.2+) is PROJECT-scoped — it cannot answer
 *   "what is attached to issue #42" — and requires Maintainer/Owner, which the
 *   integration PAT frequently is not. The issue description is the only
 *   issue-scoped record of its attachments, so that is what we read.
 * - `download` uses `GET /projects/:id/uploads/:secret/:filename` (17.4+),
 *   which needs only Guest. Download-by-id would need Maintainer/Owner.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/storage", () => ({
	downloadFile: vi.fn(async () => ({
		data: Buffer.from([1, 2, 3]),
		contentType: "application/pdf",
		size: 3,
	})),
}));

import { createGitLabAttachmentAdapter } from "../gitlab-attachment-adapter";

const SECRET = "d".repeat(32);
const BYTES = Buffer.from([9, 8, 7, 6]);
const BYTES_HASH = createHash("sha256").update(BYTES).digest("hex");

describe("GitLab attachment adapter — pull half (Fizzy #1745)", () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => vi.restoreAllMocks());

	it("downloads by secret and filename, returning the bytes and their sha256", async () => {
		const f = vi.fn<typeof fetch>(
			async () =>
				new Response(new Uint8Array(BYTES), {
					status: 200,
					headers: { "content-type": "image/png" },
				}),
		);
		vi.stubGlobal("fetch", f);
		const a = createGitLabAttachmentAdapter({
			token: "tok",
			projectId: "group/proj",
			baseUrl: "https://gitlab.example.com",
		});
		const out = await a.download({
			secret: SECRET,
			filename: "shot.png",
		});
		const [url, init] = f.mock.calls[0] ?? [];
		// Download-by-secret, NOT download-by-id: the by-id form needs
		// Maintainer/Owner, this one needs only Guest.
		expect(String(url)).toBe(
			`https://gitlab.example.com/api/v4/projects/group%2Fproj/uploads/${SECRET}/shot.png`,
		);
		expect(init?.headers as Record<string, string>).toMatchObject({
			"PRIVATE-TOKEN": "tok",
		});
		// The hash is computed from the bytes we actually received, so it is
		// directly comparable to the `contentHash` the push half stored.
		expect(out.contentHash).toBe(BYTES_HASH);
		expect(Buffer.from(out.data).equals(BYTES)).toBe(true);
		expect(out.contentType).toBe("image/png");
	});

	const failing = (status: number) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status })),
		);
		return createGitLabAttachmentAdapter({
			token: "t",
			projectId: "g/p",
		});
	};

	// AC-7's detection hinge. A 404 is the one download failure that is
	// routinely NOT an error: the upload was deleted on the GitLab side after a
	// prior pull. The engine has to be able to tell that apart from "GitLab is
	// broken" to report a discrepancy instead of a failure, so the message has
	// to say which one happened.
	it("reports a 404 as the file no longer being on GitLab", async () => {
		const err = await failing(404)
			.download({ secret: SECRET, filename: "gone.png" })
			.catch((e: Error) => e);
		expect((err as Error).message).toMatch(
			/no longer|not present|deleted/i,
		);
	});

	// The upload path's 403 means "token lacks the api scope". Reusing that
	// wording here would be actively misleading: download-by-secret needs only
	// Guest, so widening the scope is not the fix.
	it("does not blame the api scope for a 403 on download", async () => {
		const err = await failing(403)
			.download({ secret: SECRET, filename: "x.png" })
			.catch((e: Error) => e);
		expect((err as Error).message).not.toMatch(/scope/i);
		expect((err as Error).message).toMatch(/cannot read|access|project/i);
	});

	it("reports a 401 as an invalid or expired token", async () => {
		const err = await failing(401)
			.download({ secret: SECRET, filename: "x.png" })
			.catch((e: Error) => e);
		expect((err as Error).message).toMatch(/invalid|expired|revoked/i);
	});
});

describe("listRemote — which links on a GitLab issue are Fabric's to import", () => {
	const a = () =>
		createGitLabAttachmentAdapter({ token: "t", projectId: "g/p" });
	const S1 = "1".repeat(32);
	const S2 = "2".repeat(32);
	const S3 = "3".repeat(32);

	it("finds a plain upload link a human attached, with its secret", () => {
		const out = a().listRemote(`see [spec.pdf](/uploads/${S1}/spec.pdf)`);
		expect(out).toEqual([
			{
				filename: "spec.pdf",
				path: `/uploads/${S1}/spec.pdf`,
				secret: S1,
			},
		]);
	});

	// AC-11's boundary, enforced here rather than trusted. `ingestPulledImages`
	// already downloads every `/uploads/` link written as an IMAGE embed and
	// re-hosts it as Fabric story media on each pull. If this also claimed
	// them, one GitLab image would arrive twice on every pull — once as story
	// media and once as a StoryAttachment — and grow without bound.
	it("ignores image embeds, which the existing image-sync path already owns", () => {
		expect(a().listRemote(`![shot](/uploads/${S2}/shot.png)`)).toEqual([]);
	});

	// Fabric's own block lists what THIS side already pushed. Re-importing it
	// would turn every push into a pull of the same bytes back into Fabric.
	it("ignores links inside Fabric's own attachment block", () => {
		const desc = [
			`human [a.pdf](/uploads/${S1}/a.pdf)`,
			"<!-- fabric:attachments -->",
			"### Attachments",
			`- [ours.pdf](/uploads/${S3}/ours.pdf)`,
			"<!-- /fabric:attachments -->",
		].join("\n");
		expect(
			a()
				.listRemote(desc)
				.map((x) => x.filename),
		).toEqual(["a.pdf"]);
	});

	it("returns one entry per upload when the same file is linked twice", () => {
		const desc = `[a.pdf](/uploads/${S1}/a.pdf) and again [a.pdf](/uploads/${S1}/a.pdf)`;
		expect(a().listRemote(desc)).toHaveLength(1);
	});

	it("returns nothing for a description with no uploads", () => {
		expect(a().listRemote("just words")).toEqual([]);
	});
});
