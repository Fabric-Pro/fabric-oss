import { afterEach, describe, expect, it, vi } from "vitest";
import {
	looksFabricAuthored,
	replaceHtmlImagesWithMarkdown,
	uploadGitLabImagesAndRewriteDescription,
} from "../story-sync-media";

const R2_URL =
	"https://acct.r2.cloudflarestorage.com/project-contexts/story-media/p/s/x.png?X-Amz-Signature=abc";
const HTML_IMG = `<p>x</p><p><img src="${R2_URL}" data-s3-key="story-media/p/s/x.png" alt="probe"></p>`;

describe("GitLab inline-image push pipeline (Fizzy #1745 P6)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("treats a story-media <img> as Fabric-authored", () => {
		expect(looksFabricAuthored(HTML_IMG)).toBe(true);
	});

	it("converts that <img> to a markdown image", () => {
		const md = replaceHtmlImagesWithMarkdown(HTML_IMG);
		expect(md).toMatch(/!\[[^\]]*\]\(/);
	});

	it("KEEPS the R2 url when the outbound fetch fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 403 })),
		);
		const md = replaceHtmlImagesWithMarkdown(HTML_IMG);
		const out = await uploadGitLabImagesAndRewriteDescription(md, {
			token: "t",
			projectId: "g/p",
			baseUrl: "https://gitlab.com",
		});
		expect(out).toContain("r2.cloudflarestorage.com");
		expect(out).not.toMatch(/\/uploads\/[0-9a-f]{32}\//);
	});

	it("rewrites to /uploads when the fetch succeeds", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				String(url).includes("/uploads")
					? new Response(
							JSON.stringify({
								full_path: `/uploads/${"a".repeat(32)}/x.png`,
								url: `/uploads/${"a".repeat(32)}/x.png`,
							}),
							{
								status: 201,
								headers: { "content-type": "application/json" },
							},
						)
					: new Response(Buffer.from([1, 2, 3]), {
							status: 200,
							headers: { "content-type": "image/png" },
						}),
			),
		);
		const md = replaceHtmlImagesWithMarkdown(HTML_IMG);
		const out = await uploadGitLabImagesAndRewriteDescription(md, {
			token: "t",
			projectId: "g/p",
			baseUrl: "https://gitlab.com",
		});
		expect(out).toMatch(/\/uploads\/[0-9a-f]{32}\//);
	});
});
