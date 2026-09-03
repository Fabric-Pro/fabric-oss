import { afterEach, describe, expect, it, vi } from "vitest";
import {
	adoAttachmentId,
	appendAdoAttachmentLinks,
	buildAdoIngestOptions,
	buildFizzyIngestOptions,
	buildGitLabIngestOptions,
	fetchAdoAttachmentRelations,
	fizzyBlobId,
	gitlabUploadId,
	ingestPulledImages,
	type PulledImageStore,
	resolveAdoPat,
	resolveFizzyApiKey,
	stripFailedMediaPlaceholders,
	stripGitLabImageAttributes,
} from "../pull-image-ingest";

const ADO_GUID = "abc12345-0000-0000-0000-000000000001";
const ADO_URL = `https://dev.azure.com/example-org/_apis/wit/attachments/${ADO_GUID}?fileName=shot.png`;

function makeStore(
	overrides: Partial<PulledImageStore> = {},
): PulledImageStore & {
	puts: Array<{ key: string; contentType: string; size: number }>;
} {
	const puts: Array<{ key: string; contentType: string; size: number }> = [];
	return {
		exists: vi.fn(async () => false),
		put: vi.fn(async (key: string, data: Buffer, contentType: string) => {
			puts.push({ key, contentType, size: data.length });
		}),
		signedUrl: vi.fn(
			async (key: string) => `https://signed.example/${key}?sig=1`,
		),
		puts,
		...overrides,
	} as PulledImageStore & {
		puts: Array<{ key: string; contentType: string; size: number }>;
	};
}

function imageResponse(
	opts: {
		ok?: boolean;
		contentType?: string;
		size?: number;
		/** Leading "magic" bytes; remainder zero-padded to `size`. */
		bytes?: number[];
	} = {},
): Response {
	const { ok = true, contentType = "image/png", size = 128, bytes } = opts;
	const buf = new Uint8Array(Math.max(size, bytes?.length ?? 0));
	if (bytes) {
		buf.set(bytes);
	}
	return {
		ok,
		status: ok ? 200 : 404,
		headers: {
			get: (h: string) =>
				h.toLowerCase() === "content-type" ? contentType : null,
		},
		arrayBuffer: async () => buf.buffer,
	} as unknown as Response;
}

const adoOpts = () => buildAdoIngestOptions("PAT-123");
const EXPECTED_KEY = `story-media/p1/s1/pull-${ADO_GUID}`;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("ingestPulledImages — ADO", () => {
	it("downloads an ADO image, stores it, and rewrites to a Fabric <img>", async () => {
		const fetchMock = vi.fn(async () => imageResponse());
		vi.stubGlobal("fetch", fetchMock);
		const store = makeStore();

		const result = await ingestPulledImages({
			description: `<p><img src="${ADO_URL}" alt="Diagram"></p>`,
			projectId: "p1",
			storyId: "s1",
			store,
			...adoOpts(),
		});

		expect(result.ingested).toBe(1);
		expect(result.failed).toBe(0);
		expect(store.puts).toEqual([
			{ key: EXPECTED_KEY, contentType: "image/png", size: 128 },
		]);
		expect(result.description).toContain(`data-s3-key="${EXPECTED_KEY}"`);
		expect(result.description).toContain(
			'src="https://signed.example/story-media/p1/s1/pull-',
		);
		expect(result.description).toContain('alt="Diagram"');
		expect(result.description).not.toContain("dev.azure.com");

		// Download used the PAT Basic auth header.
		const [, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect((init.headers as Record<string, string>).Authorization).toMatch(
			/^Basic /,
		);
	});

	it("reuses an already-stored object on re-pull (no re-download)", async () => {
		const fetchMock = vi.fn(async () => imageResponse());
		vi.stubGlobal("fetch", fetchMock);
		const store = makeStore({ exists: vi.fn(async () => true) });

		const result = await ingestPulledImages({
			description: `<img src="${ADO_URL}">`,
			projectId: "p1",
			storyId: "s1",
			store,
			...adoOpts(),
		});

		expect(result.reused).toBe(1);
		expect(result.ingested).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(store.put).not.toHaveBeenCalled();
		expect(result.description).toContain(`data-s3-key="${EXPECTED_KEY}"`);
	});

	it("emits a placeholder (not a broken icon) when the fetch fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => imageResponse({ ok: false })),
		);
		const store = makeStore();

		const result = await ingestPulledImages({
			description: `<img src="${ADO_URL}" alt="missing">`,
			projectId: "p1",
			storyId: "s1",
			store,
			...adoOpts(),
		});

		expect(result.failed).toBe(1);
		expect(result.description).toContain(
			"[Image could not be imported from Azure DevOps: missing]",
		);
		expect(result.description).not.toContain("<img");
	});

	it("treats a non-image content type as a failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => imageResponse({ contentType: "text/html" })),
		);
		const store = makeStore();

		const result = await ingestPulledImages({
			description: `<img src="${ADO_URL}">`,
			projectId: "p1",
			storyId: "s1",
			store,
			...adoOpts(),
		});

		expect(result.failed).toBe(1);
		expect(store.put).not.toHaveBeenCalled();
		expect(result.description).toContain("could not be imported");
	});

	it("accepts application/octet-stream by inferring type from the ADO fileName", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				imageResponse({ contentType: "application/octet-stream" }),
			),
		);
		const store = makeStore();

		const result = await ingestPulledImages({
			// ADO_URL carries ?fileName=shot.png → inferred image/png
			description: `<img src="${ADO_URL}">`,
			projectId: "p1",
			storyId: "s1",
			store,
			...adoOpts(),
		});

		expect(result.ingested).toBe(1);
		expect(store.puts).toEqual([
			{ key: EXPECTED_KEY, contentType: "image/png", size: 128 },
		]);
	});

	it("sniffs magic bytes when octet-stream + the filename has no usable extension (WI #228 re-upload)", async () => {
		// A RE-UPLOADED ADO attachment returns octet-stream and carries only
		// `?fileName=image-0.bin` (the real name is lost across a push→pull
		// round-trip), so header + URL inference both fail — but the bytes are a
		// real JPEG. The byte-sniff must recover `image/jpeg` so the image
		// re-ingests instead of dropping to a placeholder.
		const jpegMagic = [
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
			0x01,
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				imageResponse({
					contentType: "application/octet-stream",
					bytes: jpegMagic,
				}),
			),
		);
		const store = makeStore();
		const binUrl = `https://dev.azure.com/example-org/projGUID/_apis/wit/attachments/${ADO_GUID}?fileName=image-0.bin`;

		const result = await ingestPulledImages({
			description: `<img src="${binUrl}">`,
			projectId: "p1",
			storyId: "s1",
			store,
			...adoOpts(),
		});

		expect(result.ingested).toBe(1);
		expect(result.failed).toBe(0);
		expect(store.puts[0]?.contentType).toBe("image/jpeg");
	});

	it("rejects octet-stream when the filename has no image extension AND the bytes are not an image", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				imageResponse({ contentType: "application/octet-stream" }),
			),
		);
		const store = makeStore();
		const noExtUrl = `https://dev.azure.com/example-org/_apis/wit/attachments/${ADO_GUID}`;

		const result = await ingestPulledImages({
			description: `<img src="${noExtUrl}">`,
			projectId: "p1",
			storyId: "s1",
			store,
			...adoOpts(),
		});

		expect(result.failed).toBe(1);
		expect(store.put).not.toHaveBeenCalled();
	});

	it("rejects an oversized image", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => imageResponse({ size: 5 * 1024 * 1024 + 1 })),
		);
		const store = makeStore();

		const result = await ingestPulledImages({
			description: `<img src="${ADO_URL}">`,
			projectId: "p1",
			storyId: "s1",
			store,
			...adoOpts(),
		});

		expect(result.failed).toBe(1);
		expect(store.put).not.toHaveBeenCalled();
	});

	it("leaves an already-Fabric story-media image untouched", async () => {
		const fetchMock = vi.fn(async () => imageResponse());
		vi.stubGlobal("fetch", fetchMock);
		const store = makeStore();
		const original = `<img src="https://signed.example/story-media/p1/s1/pull-x?sig=1" data-s3-key="story-media/p1/s1/pull-x">`;

		const result = await ingestPulledImages({
			description: original,
			projectId: "p1",
			storyId: "s1",
			store,
			...adoOpts(),
		});

		expect(result.skipped).toBeGreaterThanOrEqual(1);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.description).toBe(original);
	});

	it("leaves non-matching external URLs untouched (urlFilter)", async () => {
		const fetchMock = vi.fn(async () => imageResponse());
		vi.stubGlobal("fetch", fetchMock);
		const store = makeStore();
		const original = `<img src="https://example.com/foo.png">`;

		const result = await ingestPulledImages({
			description: original,
			projectId: "p1",
			storyId: "s1",
			store,
			...adoOpts(),
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.description).toBe(original);
	});

	it("handles markdown image syntax too", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => imageResponse()),
		);
		const store = makeStore();

		const result = await ingestPulledImages({
			description: `![pic](${ADO_URL})`,
			projectId: "p1",
			storyId: "s1",
			store,
			...adoOpts(),
		});

		expect(result.ingested).toBe(1);
		expect(result.description).toContain(`data-s3-key="${EXPECTED_KEY}"`);
		expect(result.description).toContain('alt="pic"');
	});

	it("is a no-op for empty description", async () => {
		const store = makeStore();
		const result = await ingestPulledImages({
			description: "",
			projectId: "p1",
			storyId: "s1",
			store,
			...adoOpts(),
		});
		expect(result.ingested).toBe(0);
		expect(result.description).toBe("");
	});
});

describe("adoAttachmentId", () => {
	it("extracts the attachment GUID", () => {
		expect(adoAttachmentId(ADO_URL)).toBe(ADO_GUID);
	});
	it("returns null when there is no attachment segment", () => {
		expect(adoAttachmentId("https://example.com/x.png")).toBeNull();
	});
});

describe("buildAdoIngestOptions", () => {
	it("matches ADO attachment URLs and supplies Basic auth", () => {
		const opts = buildAdoIngestOptions("PAT");
		expect(opts.urlFilter?.(ADO_URL)).toBe(true);
		expect(opts.urlFilter?.("https://example.com/x.png")).toBe(false);
		expect(opts.fetchAuth?.(ADO_URL)?.Authorization).toMatch(/^Basic /);
		expect(opts.fetchAuth?.("https://example.com/x.png")).toBeNull();
		expect(opts.deriveKeyId?.(ADO_URL)).toBe(ADO_GUID);
		expect(opts.providerLabel).toBe("Azure DevOps");
	});

	it("also matches relations attachment URLs with a project-GUID segment", () => {
		const opts = buildAdoIngestOptions("PAT");
		const relUrl = `https://dev.azure.com/example-org/00000000-0000-0000-0000-000000000000/_apis/wit/attachments/${ADO_GUID}`;
		expect(opts.urlFilter?.(relUrl)).toBe(true);
		expect(opts.fetchAuth?.(relUrl)?.Authorization).toMatch(/^Basic /);
		expect(adoAttachmentId(relUrl)).toBe(ADO_GUID);
	});

	it("does not match a dev.azure.com URL without the attachments API segment", () => {
		const opts = buildAdoIngestOptions("PAT");
		expect(
			opts.urlFilter?.(
				"https://dev.azure.com/example-org/_apis/wit/workitems/1",
			),
		).toBe(false);
	});

	it("does not send the PAT to a foreign host that merely mentions the ADO path", () => {
		// The old substring test matched anywhere in the string, so this URL
		// passed the filter and the `Basic <PAT>` header went to the attacker's
		// host. The host is now compared exactly.
		const opts = buildAdoIngestOptions("PAT");
		const spoofed =
			"https://other.example/?u=https://dev.azure.com/example-org/_apis/wit/attachments/g1";
		expect(opts.urlFilter?.(spoofed)).toBe(false);
		expect(opts.fetchAuth?.(spoofed)).toBeNull();
		expect(
			opts.urlFilter?.(
				"https://dev.azure.com.example.test/example-org/_apis/wit/attachments/g1",
			),
		).toBe(false);
	});

	it("stays linear on a huge non-matching src value (js/polynomial-redos)", () => {
		// A single `<img src>` in a work-item description can carry the whole
		// 200,000-char scan budget; the unbounded `[^\s?#]*` span was re-scanned
		// from every candidate start position. Speed is enforced by the
		// runner's normal timeout.
		const opts = buildAdoIngestOptions("PAT");
		expect(
			opts.urlFilter?.(`https://${"dev.azure.com/".repeat(14_000)}`),
		).toBe(false);
	});
});

describe("fetchAdoAttachmentRelations", () => {
	it("returns AttachedFile relations (name + url) via $expand=relations", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			json: async () => ({
				relations: [
					{
						rel: "AttachedFile",
						url: "https://dev.azure.com/org/proj/_apis/wit/attachments/g1",
						attributes: { name: "Test.xlsx" },
					},
					{
						rel: "Hyperlink",
						url: "https://example.com",
						attributes: {},
					},
				],
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const out = await fetchAdoAttachmentRelations(221, {
			pat: "PAT",
			org: "org",
		});

		expect(out).toEqual([
			{
				name: "Test.xlsx",
				url: "https://dev.azure.com/org/proj/_apis/wit/attachments/g1",
			},
		]);
		const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(calledUrl).toContain("/org/_apis/wit/workitems/221");
		expect(calledUrl).toContain("$expand=relations");
		expect((init.headers as Record<string, string>).Authorization).toMatch(
			/^Basic /,
		);
	});

	it("returns [] on a non-ok response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				status: 404,
				text: async () => "",
			})),
		);
		expect(
			await fetchAdoAttachmentRelations(1, { pat: "P", org: "o" }),
		).toEqual([]);
	});
});

describe("appendAdoAttachmentLinks", () => {
	const att = {
		name: "Test.xlsx",
		url: "https://dev.azure.com/org/proj/_apis/wit/attachments/g1",
	};

	const taggedLink =
		"[Test.xlsx](https://dev.azure.com/org/proj/_apis/wit/attachments/g1?fileName=Test.xlsx)";

	it("appends a fileName-tagged link with NO Attachments heading", () => {
		const out = appendAdoAttachmentLinks("Body text", [att]);
		expect(out.startsWith("Body text")).toBe(true);
		expect(out).toContain(taggedLink);
		expect(out).not.toContain("## Attachments");
		expect(out).not.toContain("Attachments");
	});

	it("inserts the link BEFORE the 'View in Fabric' back-link", () => {
		const desc =
			'Body\n\n<p><a href="https://fabric.pro/x">View in Fabric</a></p>';
		const out = appendAdoAttachmentLinks(desc, [att]);
		expect(out.indexOf(taggedLink)).toBeGreaterThanOrEqual(0);
		expect(out.indexOf(taggedLink)).toBeLessThan(
			out.indexOf("View in Fabric"),
		);
		expect(out).not.toContain("## Attachments");
	});

	it("is idempotent — does not re-append an already-linked attachment", () => {
		const first = appendAdoAttachmentLinks("Body", [att]);
		const second = appendAdoAttachmentLinks(first, [att]);
		expect(second).toBe(first);
	});

	it("returns the description unchanged for no attachments", () => {
		expect(appendAdoAttachmentLinks("Body", [])).toBe("Body");
	});

	it("inserts the link BEFORE a back-link past 200,000 chars — the anchor is found by locating its fixed label, not by scanning a bounded prefix (js/polynomial-redos)", () => {
		// No content-length cap on the back-link search: the anchor is found
		// via a linear `lastIndexOf` on its fixed "View in Fabric" label, then
		// only a small window around that index is regex-scanned. The insert-
		// before-the-anchor contract must hold no matter how long the
		// description is.
		const filler = "x".repeat(200_010);
		const desc = `${filler}\n\n<p><a href="https://fabric.pro/x">View in Fabric</a></p>`;
		const out = appendAdoAttachmentLinks(desc, [att]);
		expect(out.indexOf(taggedLink)).toBeGreaterThanOrEqual(0);
		expect(out.indexOf(taggedLink)).toBeLessThan(
			out.indexOf("View in Fabric"),
		);
		// The filler itself is preserved untouched ahead of the inserted link.
		expect(out.startsWith(filler)).toBe(true);
	});

	it("inserts the link before the real back-link even when later prose repeats its label", () => {
		// The label ("View in Fabric") is plain text, so nothing stops it
		// from also appearing in a user's own prose — most naturally AFTER
		// the real back-link, since that's where new edits land. A naive
		// single `lastIndexOf` would find that later, non-anchor occurrence,
		// fail its window check, and fall back to appending at the very end
		// — after the back-link instead of before it.
		const desc =
			'Body\n\n<p><a href="https://fabric.pro/x">View in Fabric</a></p>' +
			"\n\nEditor note: see the View in Fabric link above for context.";
		const out = appendAdoAttachmentLinks(desc, [att]);
		const linkIdx = out.indexOf(taggedLink);
		const anchorIdx = out.indexOf(
			'<a href="https://fabric.pro/x">View in Fabric</a>',
		);
		const proseIdx = out.indexOf("Editor note:");
		expect(linkIdx).toBeGreaterThanOrEqual(0);
		// Inserted before the real anchor — not after it, and not after the
		// trailing prose that also happens to contain the label.
		expect(linkIdx).toBeLessThan(anchorIdx);
		expect(anchorIdx).toBeLessThan(proseIdx);
		// The trailing prose (and its own "View in Fabric" occurrence) is
		// preserved untouched.
		expect(out).toContain(
			"Editor note: see the View in Fabric link above for context.",
		);
	});
});

describe("resolveAdoPat", () => {
	it("returns null for missing keys", () => {
		expect(resolveAdoPat(null)).toBeNull();
		expect(resolveAdoPat(undefined)).toBeNull();
	});
});

// =============================================================================
// Fizzy
// =============================================================================

const FIZZY_SIGNED = "eyJfcmFpbHMiSIGNED--944425bcc699921e808df8b36022dbbbd";
const FIZZY_URL = `https://app.fizzy.do/000000/rails/active_storage/blobs/redirect/${FIZZY_SIGNED}/image.png`;
const fizzyOpts = () => buildFizzyIngestOptions("FZ-KEY", "000000");
const FIZZY_KEY = `story-media/p1/s1/pull-${FIZZY_SIGNED}`;

describe("buildFizzyIngestOptions", () => {
	it("matches Fizzy ActiveStorage URLs, supplies Bearer auth, derives the signed id", () => {
		const opts = buildFizzyIngestOptions("FZ-KEY", "000000");
		expect(opts.urlFilter?.(FIZZY_URL)).toBe(true);
		expect(opts.urlFilter?.("https://example.com/x.png")).toBe(false);
		expect(opts.fetchAuth?.(FIZZY_URL)?.Authorization).toBe(
			"Bearer FZ-KEY",
		);
		expect(opts.fetchAuth?.("https://example.com/x.png")).toBeNull();
		expect(opts.deriveKeyId?.(FIZZY_URL)).toBe(FIZZY_SIGNED);
		expect(opts.providerLabel).toBe("Fizzy");
	});

	it("also matches account-relative ActiveStorage URLs", () => {
		const opts = buildFizzyIngestOptions("FZ-KEY", "000000");
		expect(
			opts.urlFilter?.(
				`/000000/rails/active_storage/blobs/redirect/${FIZZY_SIGNED}/image.png`,
			),
		).toBe(true);
	});

	it("resolves account-relative Fizzy URLs to absolute app.fizzy.do URLs", () => {
		const opts = buildFizzyIngestOptions("FZ-KEY", "000000");
		expect(
			opts.resolveFetchUrl?.(
				`/000000/rails/active_storage/blobs/redirect/${FIZZY_SIGNED}/image.png`,
			),
		).toBe(
			`https://app.fizzy.do/000000/rails/active_storage/blobs/redirect/${FIZZY_SIGNED}/image.png`,
		);
		expect(opts.resolveFetchUrl?.(FIZZY_URL)).toBe(FIZZY_URL);
	});

	it("injects the account slug for a slug-less rails ActiveStorage URL", () => {
		// Fizzy file attachments expose a slug-LESS wrapper url
		// (`/rails/active_storage/blobs/redirect/{sgid}/Test.xlsx`); without the
		// account slug the download 404s. resolveFetchUrl must insert it.
		const opts = buildFizzyIngestOptions("FZ-KEY", "000000");
		expect(
			opts.resolveFetchUrl?.(
				`/rails/active_storage/blobs/redirect/${FIZZY_SIGNED}/Test.xlsx`,
			),
		).toBe(
			`https://app.fizzy.do/000000/rails/active_storage/blobs/redirect/${FIZZY_SIGNED}/Test.xlsx`,
		);
	});

	it("does not send the API key to a foreign host that merely mentions the Fizzy attachment path", () => {
		// FIZZY_ATTACHMENT_RE is path-only, with no host component — before the
		// host pin, an <img src> pointing at this URL satisfied the filter and
		// the `Bearer <apiKey>` header (plus resolveFetchUrl's absolute-URL
		// passthrough) would have sent the Fizzy API key to the attacker's host.
		const opts = buildFizzyIngestOptions("FZ-KEY", "000000");
		const spoofed = `https://attacker.example/rails/active_storage/blobs/redirect/${FIZZY_SIGNED}/image.png`;
		expect(opts.urlFilter?.(spoofed)).toBe(false);
		expect(opts.fetchAuth?.(spoofed)).toBeNull();
		// A lookalike subdomain of the real host must not qualify either.
		expect(
			opts.urlFilter?.(
				`https://app.fizzy.do.attacker.example/rails/active_storage/blobs/redirect/${FIZZY_SIGNED}/image.png`,
			),
		).toBe(false);
	});

	it("still matches a same-host absolute Fizzy URL", () => {
		const opts = buildFizzyIngestOptions("FZ-KEY", "000000");
		expect(opts.urlFilter?.(FIZZY_URL)).toBe(true);
		expect(opts.fetchAuth?.(FIZZY_URL)?.Authorization).toBe(
			"Bearer FZ-KEY",
		);
	});
});

describe("ingestPulledImages — Fizzy", () => {
	it("fetches a Fizzy blob image with Bearer auth and stores it", async () => {
		const fetchMock = vi.fn(async () => imageResponse());
		vi.stubGlobal("fetch", fetchMock);
		const store = makeStore();

		const result = await ingestPulledImages({
			description: `<p><img src="${FIZZY_URL}" alt="pic"></p>`,
			projectId: "p1",
			storyId: "s1",
			store,
			...fizzyOpts(),
		});

		expect(result.ingested).toBe(1);
		const [, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer FZ-KEY",
		);
		expect(store.puts[0]?.key).toBe(FIZZY_KEY);
		expect(result.description).toContain(`data-s3-key="${FIZZY_KEY}"`);
		expect(result.description).not.toContain("app.fizzy.do");
	});

	it("resolves an account-relative Fizzy image with the slug and fetches it with Bearer auth", async () => {
		const fetchMock = vi.fn(async () => imageResponse());
		vi.stubGlobal("fetch", fetchMock);
		const store = makeStore();
		const relativeSrc = `/rails/active_storage/blobs/redirect/${FIZZY_SIGNED}/image.png`;

		const result = await ingestPulledImages({
			description: `<p><img src="${relativeSrc}" alt="pic"></p>`,
			projectId: "p1",
			storyId: "s1",
			store,
			...fizzyOpts(),
		});

		expect(result.ingested).toBe(1);
		const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(calledUrl).toBe(
			`https://app.fizzy.do/000000/rails/active_storage/blobs/redirect/${FIZZY_SIGNED}/image.png`,
		);
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer FZ-KEY",
		);
		expect(store.puts[0]?.key).toBe(FIZZY_KEY);
		expect(result.description).toContain(`data-s3-key="${FIZZY_KEY}"`);
	});

	it("leaves a lookalike-host Fizzy-path image untouched and never fetches it", async () => {
		// Same bug as the buildFizzyIngestOptions unit test, exercised through
		// the full ingest pipeline: the attacker host must never be fetched,
		// with or without auth, and the img tag must be left as-is (skipped),
		// not rewritten to a Fabric-hosted reference or a placeholder.
		const fetchMock = vi.fn(async () => imageResponse());
		vi.stubGlobal("fetch", fetchMock);
		const store = makeStore();
		const spoofed = `https://attacker.example/rails/active_storage/blobs/redirect/${FIZZY_SIGNED}/image.png`;

		const result = await ingestPulledImages({
			description: `<p><img src="${spoofed}" alt="pic"></p>`,
			projectId: "p1",
			storyId: "s1",
			store,
			...fizzyOpts(),
		});

		expect(result.ingested).toBe(0);
		expect(result.skipped).toBe(1);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.description).toContain(`src="${spoofed}"`);
	});
});

// =============================================================================
// GitLab
// =============================================================================

const GL_HASH = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const GL_REL = `/uploads/${GL_HASH}/screenshot.png`;
const GL_ABS = `https://gitlab.com/uploads/${GL_HASH}/screenshot.png`;
const glOpts = () =>
	buildGitLabIngestOptions("GL-TOKEN", "42", "https://gitlab.com");
const GL_KEY = `story-media/p1/s1/pull-${GL_HASH}`;

describe("buildGitLabIngestOptions", () => {
	it("matches /uploads/ URLs, supplies Bearer auth, derives the upload hash", () => {
		const opts = buildGitLabIngestOptions(
			"GL-TOKEN",
			"42",
			"https://gitlab.com",
		);
		expect(opts.urlFilter?.(GL_REL)).toBe(true);
		expect(opts.urlFilter?.("https://example.com/x.png")).toBe(false);
		expect(opts.fetchAuth?.(GL_REL)?.Authorization).toBe("Bearer GL-TOKEN");
		expect(opts.fetchAuth?.("https://example.com/x.png")).toBeNull();
		expect(opts.deriveKeyId?.(GL_REL)).toBe(GL_HASH);
		expect(opts.providerLabel).toBe("GitLab");
	});

	it("resolves a /uploads/ URL to the GitLab REST download endpoint", () => {
		const opts = buildGitLabIngestOptions(
			"GL-TOKEN",
			"42",
			"https://gitlab.com",
		);
		// GET /api/v4/projects/:id/uploads/:secret/:filename — the documented
		// upload-download endpoint that accepts the OAuth Bearer token. The
		// web route (`/-/project/...`) needs a session cookie and 401s.
		expect(opts.resolveFetchUrl?.(GL_REL)).toBe(
			`https://gitlab.com/api/v4/projects/42/uploads/${GL_HASH}/screenshot.png`,
		);
		// An absolute web-form upload URL normalizes to the same API endpoint.
		expect(opts.resolveFetchUrl?.(GL_ABS)).toBe(
			`https://gitlab.com/api/v4/projects/42/uploads/${GL_HASH}/screenshot.png`,
		);
	});

	it("URL-encodes a path-style projectId in the download endpoint", () => {
		const opts = buildGitLabIngestOptions(
			"GL-TOKEN",
			"group/sub/project",
			"https://gitlab.com",
		);
		expect(opts.resolveFetchUrl?.(GL_REL)).toBe(
			`https://gitlab.com/api/v4/projects/group%2Fsub%2Fproject/uploads/${GL_HASH}/screenshot.png`,
		);
	});
});

describe("ingestPulledImages — GitLab", () => {
	it("resolves a relative /uploads/ image, fetches with Bearer, stores it", async () => {
		const fetchMock = vi.fn(async () => imageResponse());
		vi.stubGlobal("fetch", fetchMock);
		const store = makeStore();

		const result = await ingestPulledImages({
			description: `![shot](${GL_REL})`,
			projectId: "p1",
			storyId: "s1",
			store,
			...glOpts(),
		});

		expect(result.ingested).toBe(1);
		const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(calledUrl).toBe(
			`https://gitlab.com/api/v4/projects/42/uploads/${GL_HASH}/screenshot.png`,
		);
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer GL-TOKEN",
		);
		expect(store.puts[0]?.key).toBe(GL_KEY);
		expect(result.description).toContain(`data-s3-key="${GL_KEY}"`);
	});
});

describe("resolveFizzyApiKey", () => {
	it("returns null for missing keys", () => {
		expect(resolveFizzyApiKey(null)).toBeNull();
		expect(resolveFizzyApiKey(undefined)).toBeNull();
	});
});

describe("id extractors", () => {
	it("extracts the Fizzy signed blob id", () => {
		expect(fizzyBlobId(FIZZY_URL)).toBe(FIZZY_SIGNED);
		expect(fizzyBlobId("https://example.com/x.png")).toBeNull();
	});
	it("extracts the GitLab upload hash", () => {
		expect(gitlabUploadId(GL_REL)).toBe(GL_HASH);
		expect(gitlabUploadId("https://example.com/x.png")).toBeNull();
	});
});

// =============================================================================
// File attachments (non-image) — links, not <img>
// =============================================================================

describe("ingestPulledImages — file attachments", () => {
	it("ingests a GitLab markdown file link and rewrites to a Fabric <a download>", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				imageResponse({ contentType: "application/pdf" }),
			),
		);
		const store = makeStore();

		const result = await ingestPulledImages({
			description: `See [report.pdf](/uploads/${GL_HASH}/report.pdf) for details.`,
			projectId: "p1",
			storyId: "s1",
			store,
			...glOpts(),
		});

		expect(result.ingested).toBe(1);
		// The file key ends with the original filename so the browser names the
		// download correctly (the signed-URL's last path segment IS the name).
		expect(store.puts[0]?.key).toBe(`${GL_KEY}/report.pdf`);
		expect(store.puts[0]?.contentType).toBe("application/pdf");
		expect(result.description).toContain(
			`data-s3-key="${GL_KEY}/report.pdf"`,
		);
		expect(result.description).toContain("download");
		expect(result.description).toContain("report.pdf");
		expect(result.description).not.toContain(`(/uploads/${GL_HASH}`);
	});

	it("ingests an HTML <a> file link", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				imageResponse({ contentType: "application/pdf" }),
			),
		);
		const store = makeStore();

		const result = await ingestPulledImages({
			description: `<p><a href="https://gitlab.com/uploads/${GL_HASH}/spec.pdf">spec.pdf</a></p>`,
			projectId: "p1",
			storyId: "s1",
			store,
			...glOpts(),
		});

		expect(result.ingested).toBe(1);
		expect(result.description).toContain("download");
		expect(result.description).toContain(
			`data-s3-key="${GL_KEY}/spec.pdf"`,
		);
		expect(result.description).toContain("spec.pdf");
	});

	it("treats a markdown image as an image, not a file link", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => imageResponse()),
		);
		const store = makeStore();

		const result = await ingestPulledImages({
			description: `![pic](/uploads/${GL_HASH}/pic.png)`,
			projectId: "p1",
			storyId: "s1",
			store,
			...glOpts(),
		});

		expect(result.ingested).toBe(1);
		expect(result.description).toContain("<img");
		expect(result.description).not.toContain("download");
	});

	it("leaves a non-matching link (the Fabric back-link) untouched", async () => {
		const fetchMock = vi.fn(async () => imageResponse());
		vi.stubGlobal("fetch", fetchMock);
		const store = makeStore();
		const desc = "[View in Fabric](https://fabric.pro/app/x/stories/y)";

		const result = await ingestPulledImages({
			description: desc,
			projectId: "p1",
			storyId: "s1",
			store,
			...glOpts(),
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.description).toBe(desc);
	});

	it("rejects an oversized file with a placeholder", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				imageResponse({
					contentType: "application/pdf",
					size: 25 * 1024 * 1024 + 1,
				}),
			),
		);
		const store = makeStore();

		const result = await ingestPulledImages({
			description: `[big.pdf](/uploads/${GL_HASH}/big.pdf)`,
			projectId: "p1",
			storyId: "s1",
			store,
			...glOpts(),
		});

		expect(result.failed).toBe(1);
		expect(store.put).not.toHaveBeenCalled();
		expect(result.description).toContain("could not be imported");
	});

	it("caps a runaway-long attachment display name before sanitizing it into the S3 key (redos bound)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				imageResponse({ contentType: "application/pdf" }),
			),
		);
		const store = makeStore();
		const longName = "a".repeat(5000);

		const result = await ingestPulledImages({
			description: `[${longName}](/uploads/${GL_HASH}/report.pdf)`,
			projectId: "p1",
			storyId: "s1",
			store,
			...glOpts(),
		});

		expect(result.ingested).toBe(1);
		const key = store.puts[0]?.key ?? "";
		const sanitizedName = key.slice(`${GL_KEY}/`.length);
		// Capped to MAX_ATTACHMENT_NAME_CHARS (255), not the full 5000-char name.
		expect(sanitizedName).toBe("a".repeat(255));
	});
});

describe("stripGitLabImageAttributes", () => {
	it("removes a {width=… height=…} block attached to a markdown image", () => {
		const out = stripGitLabImageAttributes(
			"![download.jpg](/uploads/abc/download.jpg){width=301 height=167}",
		);
		expect(out).toBe("![download.jpg](/uploads/abc/download.jpg)");
	});

	it("removes a {…} block attached to an <img> tag", () => {
		const out = stripGitLabImageAttributes(
			'<img src="/uploads/abc/x.png">{width=50%}',
		);
		expect(out).toBe('<img src="/uploads/abc/x.png">');
	});

	it("leaves standalone {…} prose and plain images untouched", () => {
		const input =
			"set {width=10} in config\n\n![a](/uploads/abc/a.png) trailing";
		expect(stripGitLabImageAttributes(input)).toBe(input);
	});

	it("only processes the leading bounded span; a block beyond it passes through untouched (redos bound)", () => {
		// Beyond MAX_DESCRIPTION_REGEX_SCAN_CHARS (200_000) the sizing-attribute
		// regex no longer runs, so this trailing {…} block is left in place.
		const filler = "a".repeat(200_010);
		const untouchedTail = "![x.jpg](/uploads/abc/x.jpg){width=10}";
		const input = `${filler}${untouchedTail}`;
		expect(stripGitLabImageAttributes(input)).toContain(untouchedTail);
	});
});

describe("stripFailedMediaPlaceholders", () => {
	it("removes the raw HTML attachment placeholder the ingester emits", () => {
		const out = stripFailedMediaPlaceholders(
			"before<p><em>[Attachment could not be imported from GitLab: MapScript.txt]</em></p>after",
		);
		expect(out).toBe("beforeafter");
	});

	it("removes the raw HTML image placeholder", () => {
		const out = stripFailedMediaPlaceholders(
			"<p><em>[Image could not be imported from Azure DevOps: missing]</em></p>",
		);
		expect(out).toBe("");
	});

	it("removes the markdown/italic form a frontend round-trip produces", () => {
		const out = stripFailedMediaPlaceholders(
			"text *[Attachment could not be imported from GitLab: notes.txt]* more",
		);
		expect(out).toBe("text  more");
	});

	it("removes the markdown-escaped bracket form (e.g. as stored in GitLab)", () => {
		const out = stripFailedMediaPlaceholders(
			"*\\[Attachment could not be imported from GitLab: MapScript.txt\\]*",
		);
		expect(out).toBe("");
	});

	it("leaves ordinary brackets and prose untouched", () => {
		const input =
			"See [the docs](https://x.test) and the list [1] [2] here.";
		expect(stripFailedMediaPlaceholders(input)).toBe(input);
	});

	it("is a no-op on empty input", () => {
		expect(stripFailedMediaPlaceholders("")).toBe("");
	});

	it("only processes the leading bounded span; a placeholder beyond it passes through untouched (redos bound)", () => {
		// Beyond MAX_DESCRIPTION_REGEX_SCAN_CHARS (200_000) the strip regexes no
		// longer run, so this trailing placeholder is left in place verbatim.
		const filler = "a".repeat(200_010);
		const untouchedTail =
			"<p><em>[Image could not be imported: x]</em></p>";
		const input = `${filler}${untouchedTail}`;
		expect(stripFailedMediaPlaceholders(input)).toContain(untouchedTail);
	});
});

describe("ingestPulledImages — empty (0-byte) attachments", () => {
	const GL_SECRET = "a".repeat(32);
	const glOpts = () =>
		buildGitLabIngestOptions(
			"glpat-x",
			"group/project",
			"https://gitlab.com",
		);

	it("stores an empty FILE attachment instead of dropping it to a placeholder (GitLab #16 MapScript.txt)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				imageResponse({
					size: 0,
					contentType: "application/octet-stream",
				}),
			),
		);
		const store = makeStore();
		const result = await ingestPulledImages({
			description: `[MapScript.txt](/uploads/${GL_SECRET}/MapScript.txt)`,
			projectId: "p1",
			storyId: "s1",
			store,
			...glOpts(),
		});
		expect(result.failed).toBe(0);
		expect(result.ingested).toBe(1);
		expect(store.puts).toHaveLength(1);
		expect(store.puts[0].size).toBe(0);
		expect(store.puts[0].contentType).toBe("text/plain");
		expect(result.description).toContain("data-s3-key=");
		expect(result.description).toContain("MapScript.txt");
		expect(result.description).not.toContain("could not be imported");
	});

	it("still drops an empty IMAGE to a placeholder (a 0-byte image is invalid)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				imageResponse({ size: 0, contentType: "image/png" }),
			),
		);
		const store = makeStore();
		const result = await ingestPulledImages({
			description: `![](/uploads/${GL_SECRET}/pic.png)`,
			projectId: "p1",
			storyId: "s1",
			store,
			...glOpts(),
		});
		expect(result.ingested).toBe(0);
		expect(result.failed).toBe(1);
		expect(store.put).not.toHaveBeenCalled();
		expect(result.description).toContain("could not be imported");
	});
});
