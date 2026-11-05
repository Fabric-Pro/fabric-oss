import { describe, expect, it } from "vitest";
import { frameReadDto } from "../frame-read-dto";

describe("ordinary frame reads", () => {
	it("preserves content and metadata without disclosing bearer links, including owner/public reads", () => {
		const source = {
			id: "example-frame",
			shareToken: "example-secret",
			shareUrl: "https://example.com/share/example-secret",
			shareEmbedUrl: "https://example.com/share/example-secret/embed",
			title: "Example report",
			isPublic: true,
			version: 3,
			document: { blocks: [] },
		};
		const read = frameReadDto(source);
		expect(JSON.stringify(read)).not.toContain("example-secret");
		expect(read).toMatchObject({
			id: source.id,
			title: source.title,
			isPublic: true,
			shareToken: null,
			version: 3,
			document: source.document,
		});
		expect(source.shareToken).toBe("example-secret");
	});
});
