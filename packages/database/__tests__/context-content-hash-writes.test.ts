/**
 * Every manual write of `ProjectContext.content` stamps the matching
 * `contentHash` (Fizzy #2619).
 *
 * Before this, only synced files carried a hash, so a pasted note or an
 * uploaded file was invisible to duplicate detection. What this pins:
 *  - `createContext` hashes the content it stores, and stores null for empty
 *    content (a row waiting on extraction is not a copy of every other one);
 *  - `updateContextExtractionStatus` — where every extraction pipeline lands
 *    its text — writes the hash with the content, null with empty content,
 *    and leaves the column alone when it is not writing content at all;
 *  - `updateContext` keeps the hash in step with a content rewrite.
 *
 * Run with: pnpm --filter @repo/database test -- __tests__/context-content-hash-writes.test.ts
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMock, updateMock } = vi.hoisted(() => ({
	createMock: vi.fn(),
	updateMock: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		projectContext: {
			create: (args: unknown) => createMock(args),
			update: (args: unknown) => updateMock(args),
		},
	},
	Prisma: { sql: vi.fn(), join: vi.fn() },
}));

import {
	contextContentHashOrNull,
	hashContextContent,
} from "../prisma/queries/projects/context-content-hash";
import {
	createContext,
	updateContext,
	updateContextExtractionStatus,
} from "../prisma/queries/projects/contexts";

function sha256(text: string) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function lastData(mock: ReturnType<typeof vi.fn>) {
	const args = mock.mock.calls.at(-1)?.[0] as {
		data: Record<string, unknown>;
	};
	return args.data;
}

beforeEach(() => {
	createMock.mockReset().mockResolvedValue({ id: "ctx-1" });
	updateMock.mockReset().mockResolvedValue({ id: "ctx-1" });
});

describe("contextContentHashOrNull", () => {
	it("is the content hash for non-empty content and null for empty content", () => {
		expect(contextContentHashOrNull("notes")).toBe(sha256("notes"));
		expect(contextContentHashOrNull("notes")).toBe(
			hashContextContent("notes"),
		);
		expect(contextContentHashOrNull("")).toBeNull();
	});
});

describe("createContext — contentHash", () => {
	it("stores the hash of the content it writes", async () => {
		await createContext({
			projectId: "proj-1",
			type: "TEXT",
			content: "Pasted release notes",
			userId: "user-1",
			organizationId: "org-1",
		});

		const data = lastData(createMock);
		expect(data.content).toBe("Pasted release notes");
		expect(data.contentHash).toBe(sha256("Pasted release notes"));
	});

	it("stores null for empty content (an integration stub, nothing to compare)", async () => {
		await createContext({
			projectId: "proj-1",
			type: "INTEGRATION",
			content: "",
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(lastData(createMock).contentHash).toBeNull();
	});
});

describe("updateContextExtractionStatus — contentHash", () => {
	it("writes the hash alongside extracted content", async () => {
		await updateContextExtractionStatus("ctx-1", "COMPLETED", {
			content: "Extracted PDF text",
		});

		const data = lastData(updateMock);
		expect(data.content).toBe("Extracted PDF text");
		expect(data.contentHash).toBe(sha256("Extracted PDF text"));
	});

	it("writes a null hash when the content written is empty", async () => {
		await updateContextExtractionStatus("ctx-1", "PENDING", {
			content: "",
		});

		const data = lastData(updateMock);
		expect(data.content).toBe("");
		expect(data).toHaveProperty("contentHash", null);
	});

	it("leaves contentHash untouched when no content is written", async () => {
		await updateContextExtractionStatus("ctx-1", "FAILED", {
			extractionError: "Extraction failed",
		});
		expect(lastData(updateMock)).not.toHaveProperty("contentHash");

		await updateContextExtractionStatus("ctx-1", "EXTRACTING");
		expect(lastData(updateMock)).not.toHaveProperty("contentHash");
		expect(lastData(updateMock)).not.toHaveProperty("content");
	});
});

describe("updateContext — contentHash", () => {
	it("rewrites the hash with the content", async () => {
		await updateContext("ctx-1", { content: "Revised decision record" });

		const data = lastData(updateMock);
		expect(data.content).toBe("Revised decision record");
		expect(data.contentHash).toBe(sha256("Revised decision record"));
	});

	it("leaves contentHash untouched when only other fields change", async () => {
		await updateContext("ctx-1", { qdrantId: "point-1" });

		expect(lastData(updateMock)).toEqual({ qdrantId: "point-1" });
	});
});
