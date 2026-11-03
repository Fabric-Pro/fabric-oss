import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	chunkKnowledgeEntry,
	knowledgeEmbeddingText,
	knowledgePointKey,
	knowledgeTruncatedChars,
} from "../knowledge";

const { mockIsFeatureEnabled } = vi.hoisted(() => ({
	mockIsFeatureEnabled: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: mockIsFeatureEnabled,
}));

const LONG = {
	title: "Release checklist",
	body: Array.from(
		{ length: 60 },
		(_, i) =>
			`## Step ${i + 1}\n\n${`Detail for step ${i + 1}. `.repeat(30)}`,
	).join("\n\n"),
};

describe("chunkKnowledgeEntry", () => {
	beforeEach(() => mockIsFeatureEnabled.mockReset());

	it("is today's single 24,000-character vector when the flag is off", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);
		const chunks = await chunkKnowledgeEntry({
			...LONG,
			chunkByContentType: true,
		});
		expect(chunks).toEqual([
			{ index: 0, text: knowledgeEmbeddingText(LONG), payload: {} },
		]);
		expect(chunks[0]?.text).toBe(
			`${LONG.title}\n\n${LONG.body}`.slice(0, 24_000),
		);
	});

	it("is today's single vector when the project toggle is off", async () => {
		mockIsFeatureEnabled.mockResolvedValue(true);
		const chunks = await chunkKnowledgeEntry({ ...LONG });
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.text).toBe(knowledgeEmbeddingText(LONG));
		expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
	});

	it("embeds all of a long entry when on", async () => {
		mockIsFeatureEnabled.mockResolvedValue(true);
		expect(knowledgeTruncatedChars(LONG)).toBeGreaterThan(0);
		const chunks = await chunkKnowledgeEntry({
			...LONG,
			chunkByContentType: true,
		});
		expect(chunks.length).toBeGreaterThan(1);
		const all = chunks.map((c) => c.text).join("\n");
		expect(all).toContain("Detail for step 60.");
		for (const c of chunks) {
			expect(c.text.startsWith(LONG.title)).toBe(true);
			expect(c.payload.profile).toBe("sectioned");
		}
	});

	it("keeps a short entry whole when on", async () => {
		mockIsFeatureEnabled.mockResolvedValue(true);
		const chunks = await chunkKnowledgeEntry({
			title: "Short",
			body: "One fact.",
			chunkByContentType: true,
		});
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.payload.profile).toBe("whole");
	});

	it("keys points per chunk", () => {
		expect(knowledgePointKey("entry-1", 2)).toBe("knowledge:entry-1:2");
	});
});
