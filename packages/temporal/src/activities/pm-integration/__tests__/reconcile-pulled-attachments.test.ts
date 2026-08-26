/**
 * Pull-half reconcile engine (Fizzy #1745, AC-5..AC-9).
 *
 * Transport-free like its push sibling: the adapter, the existing rows, and
 * both write callbacks are injected, so every rule below is exercised with no
 * database and no network.
 */
import { describe, expect, it, vi } from "vitest";
import type { RemoteAttachment } from "../reconcile-story-attachments";
import {
	type PullAdapter,
	type PullRow,
	reconcilePulledStoryAttachments,
} from "../reconcile-story-attachments";

const S1 = "1".repeat(32);
const S2 = "2".repeat(32);

const remote = (over: Partial<RemoteAttachment> = {}): RemoteAttachment => ({
	filename: "spec.pdf",
	path: `/uploads/${S1}/spec.pdf`,
	secret: S1,
	...over,
});

const existing = (over: Partial<PullRow> = {}): PullRow => ({
	id: "att_1",
	filename: "spec.pdf",
	contentHash: "hash-remote",
	source: "PM_SYNCED",
	externalAttachmentId: `/uploads/${S1}/spec.pdf`,
	...over,
});

type Issue = { filename: string; kind: string; detail: string };

/** Typed so a test can read back the issue that was recorded, not just count. */
const issueRecorder = () => vi.fn<(i: Issue) => Promise<void>>(async () => {});

function adapter(over: Partial<PullAdapter> = {}): PullAdapter {
	return {
		listRemote: vi.fn(() => [remote()]),
		download: vi.fn(async () => ({
			data: Buffer.from([1, 2, 3]),
			contentType: "application/pdf",
			contentHash: "hash-remote",
		})),
		...over,
	} as PullAdapter;
}

const run = (
	over: Partial<Parameters<typeof reconcilePulledStoryAttachments>[0]> = {},
) =>
	reconcilePulledStoryAttachments({
		rows: [],
		adapter: adapter(),
		description: "body",
		limits: {
			maxBytes: 1024,
			maxPerStory: 20,
			allowlist: ["application/pdf"],
		},
		importAttachment: vi.fn(async () => {}),
		recordIssue: vi.fn(async () => {}),
		...over,
	});

describe("reconcilePulledStoryAttachments (Fizzy #1745)", () => {
	// AC-5
	it("imports an attachment that is on GitLab but not in Fabric", async () => {
		const importAttachment = vi.fn(async () => {});
		const res = await run({ importAttachment });
		expect(importAttachment).toHaveBeenCalledTimes(1);
		expect(importAttachment).toHaveBeenCalledWith(
			expect.objectContaining({
				filename: "spec.pdf",
				contentHash: "hash-remote",
				externalAttachmentId: `/uploads/${S1}/spec.pdf`,
			}),
		);
		expect(res.imported).toEqual(["spec.pdf"]);
	});

	// AC-3 of the card's pull section: imported attachments land UNLOCKED so a
	// user can lock them afterwards. Importing them LOCKED would silently
	// withhold them from the AI context they were pulled in to feed.
	it("imports as UNLOCKED and marked PM_SYNCED, never as a Fabric-origin row", async () => {
		const importAttachment = vi.fn(async () => {});
		await run({ importAttachment });
		expect(importAttachment).toHaveBeenCalledWith(
			expect.objectContaining({
				designation: "UNLOCKED",
				source: "PM_SYNCED",
			}),
		);
	});

	// AC-6, the cheap path. A re-pull of an unchanged issue is the common case;
	// recognising the upload by the handle Fabric already stored avoids paying
	// for the bytes just to discover we have them.
	it("skips an upload Fabric already holds, without downloading it", async () => {
		const a = adapter();
		const importAttachment = vi.fn(async () => {});
		const res = await run({
			rows: [existing()],
			adapter: a,
			importAttachment,
		});
		expect(a.download).not.toHaveBeenCalled();
		expect(importAttachment).not.toHaveBeenCalled();
		expect(res.imported).toEqual([]);
		expect(res.skipped).toEqual(["spec.pdf"]);
	});

	// AC-6, the content path. The same bytes re-uploaded to GitLab get a NEW
	// secret, so the handle above will not match — only the hash catches it.
	it("skips a re-uploaded copy whose bytes match a row Fabric already has", async () => {
		const importAttachment = vi.fn(async () => {});
		const res = await run({
			rows: [
				existing({ externalAttachmentId: `/uploads/${S2}/spec.pdf` }),
			],
			importAttachment,
		});
		expect(importAttachment).not.toHaveBeenCalled();
		expect(res.skipped).toEqual(["spec.pdf"]);
	});

	// AC-8. Same name, different bytes: importing would silently shadow the
	// Fabric copy, and NOT importing without saying so would silently drop the
	// GitLab one. Neither side is touched and the discrepancy is recorded.
	it("records a conflict and imports nothing when a name matches but the bytes differ", async () => {
		const importAttachment = vi.fn(async () => {});
		const recordIssue = vi.fn(async () => {});
		const res = await run({
			rows: [
				existing({
					contentHash: "hash-fabric",
					externalAttachmentId: null,
					source: "FABRIC",
				}),
			],
			importAttachment,
			recordIssue,
		});
		expect(importAttachment).not.toHaveBeenCalled();
		expect(recordIssue).toHaveBeenCalledWith(
			expect.objectContaining({ filename: "spec.pdf", kind: "CONFLICT" }),
		);
		expect(res.imported).toEqual([]);
	});

	// AC-9. The limit is #1702's per-item cap, injected rather than hardcoded:
	// GitLab's own 25MB upload cap is a different number owned by a different
	// system, and conflating them would enforce the wrong one.
	it("skips a file over the size limit and names both the file and the limit", async () => {
		const importAttachment = vi.fn(async () => {});
		const recordIssue = issueRecorder();
		const res = await run({
			limits: {
				maxBytes: 2,
				maxPerStory: 20,
				allowlist: ["application/pdf"],
			},
			adapter: adapter({
				download: vi.fn(async () => ({
					data: Buffer.from([1, 2, 3, 4, 5]),
					contentType: "application/pdf",
					contentHash: "hash-big",
				})),
			}),
			importAttachment,
			recordIssue,
		});
		expect(importAttachment).not.toHaveBeenCalled();
		expect(res.skipped).toEqual(["spec.pdf"]);
		const issue = recordIssue.mock.calls[0]?.[0] as Issue;
		// The schema's documented vocabulary already had a name for this.
		expect(issue.kind).toBe("TOO_LARGE");
		expect(issue.filename).toBe("spec.pdf");
		// The AC requires the user be told WHICH file and WHAT limit; a bare
		// "too large" leaves them unable to act.
		expect(issue.detail).toMatch(/2/);
		expect(issue.detail).toMatch(/5/);
	});

	// AC-7. The Fabric copy is retained — this engine has no delete path at
	// all, so retention is structural — but the discrepancy still has to be
	// reported or the user never learns the two sides diverged.
	it("records a discrepancy when a previously-pulled upload has gone from GitLab", async () => {
		const recordIssue = vi.fn(async () => {});
		await run({
			rows: [
				existing({
					externalAttachmentId: `/uploads/${S2}/old.pdf`,
					filename: "old.pdf",
				}),
			],
			adapter: adapter({ listRemote: vi.fn(() => []) }),
			recordIssue,
		});
		expect(recordIssue).toHaveBeenCalledWith(
			expect.objectContaining({
				filename: "old.pdf",
				kind: "REMOTE_DELETED",
			}),
		);
	});

	// The mirror-image trap. A FABRIC-origin row's externalAttachmentId points
	// into Fabric's OWN attachment block, which `listRemote` strips by design —
	// so every pushed attachment would look "deleted on GitLab" on every single
	// pull if this were keyed on the handle alone rather than on the source.
	it("does not call a pushed Fabric attachment deleted just because listRemote skips our own block", async () => {
		const recordIssue = vi.fn(async () => {});
		await run({
			rows: [
				existing({
					source: "FABRIC",
					filename: "ours.pdf",
					externalAttachmentId: `/uploads/${S2}/ours.pdf`,
				}),
			],
			adapter: adapter({ listRemote: vi.fn(() => []) }),
			recordIssue,
		});
		expect(recordIssue).not.toHaveBeenCalled();
	});

	// AC-4's rule, applied to the pull direction: one bad file must not cost
	// the user the others.
	it("keeps importing the rest when one download fails", async () => {
		const importAttachment = vi.fn(async () => {});
		const res = await run({
			adapter: adapter({
				listRemote: vi.fn(() => [
					remote({ filename: "bad.pdf", secret: S1 }),
					remote({
						filename: "good.pdf",
						secret: S2,
						path: `/uploads/${S2}/good.pdf`,
					}),
				]),
				download: vi.fn(async ({ filename }) => {
					if (filename === "bad.pdf") {
						throw new Error(
							"it is no longer present on GitLab (HTTP 404)",
						);
					}
					return {
						data: Buffer.from([1]),
						contentType: "application/pdf",
						contentHash: "hash-good",
					};
				}),
			}),
			importAttachment,
		});
		expect(res.imported).toEqual(["good.pdf"]);
		expect(res.failures).toEqual([
			{
				filename: "bad.pdf",
				message: "it is no longer present on GitLab (HTTP 404)",
			},
		]);
	});

	// Parity with the upload path, not an AC. `create-attachment.ts` enforces
	// the MIME allowlist on the way in; importing from GitLab without it would
	// be a second door into the same store with the control missing.
	it("refuses a type the allowlist does not permit", async () => {
		const importAttachment = vi.fn(async () => {});
		const recordIssue = issueRecorder();
		await run({
			adapter: adapter({
				download: vi.fn(async () => ({
					data: Buffer.from([1]),
					contentType: "application/x-msdownload",
					contentHash: "hash-exe",
				})),
			}),
			importAttachment,
			recordIssue,
		});
		expect(importAttachment).not.toHaveBeenCalled();
		expect(recordIssue.mock.calls[0]?.[0].kind).toBe("DISALLOWED_TYPE");
	});

	// Also parity. Without it, one issue linking hundreds of uploads could
	// import past a cap the UI enforces everywhere else.
	it("stops importing once the story hits its attachment cap", async () => {
		const importAttachment = vi.fn(async () => {});
		const recordIssue = issueRecorder();
		await run({
			rows: [
				existing({
					id: "a",
					filename: "one.pdf",
					externalAttachmentId: null,
					source: "FABRIC",
					contentHash: "h1",
				}),
			],
			limits: {
				maxBytes: 1024,
				maxPerStory: 1,
				allowlist: ["application/pdf"],
			},
			importAttachment,
			recordIssue,
		});
		expect(importAttachment).not.toHaveBeenCalled();
		expect(recordIssue.mock.calls[0]?.[0].kind).toBe("STORY_CAP_REACHED");
	});

	// The push half already catches its persist failures; this mirrors that.
	// Without it a single storage hiccup throws out of the activity AFTER the
	// story has already been updated, so the user sees a failed pull for a
	// pull that actually landed — and loses the other files with it.
	it("records a failure and keeps going when writing one import fails", async () => {
		const res = await run({
			adapter: adapter({
				listRemote: vi.fn(() => [
					remote({ filename: "bad.pdf", secret: S1 }),
					remote({
						filename: "good.pdf",
						secret: S2,
						path: `/uploads/${S2}/good.pdf`,
					}),
				]),
			}),
			importAttachment: vi.fn(async ({ filename }) => {
				if (filename === "bad.pdf") {
					throw new Error("R2 unavailable");
				}
			}),
		});
		expect(res.imported).toEqual(["good.pdf"]);
		expect(res.failures).toEqual([
			{
				filename: "bad.pdf",
				message:
					"downloaded from GitLab but could not be saved: R2 unavailable",
			},
		]);
	});
});
