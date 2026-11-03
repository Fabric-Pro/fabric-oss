import { beforeEach, describe, expect, it, vi } from "vitest";

const { upsert, findUnique } = vi.hoisted(() => ({
	upsert: vi.fn(),
	findUnique: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: { projectRagSettings: { upsert, findUnique } },
}));

import {
	getProjectChunkingSettings,
	isChunkingChange,
	saveProjectChunkingChange,
} from "../prisma/queries/projects/chunking";

const current = {
	chunkByContentType: false,
	chunkProfiles: null,
	chunkingVersion: 3,
	chunkSize: 3000,
	chunkOverlap: 500,
	splitMethod: "DOCUMENT" as const,
};

describe("isChunkingChange", () => {
	it("is false for an empty or equal change", () => {
		expect(isChunkingChange(current, {})).toBe(false);
		expect(
			isChunkingChange(current, {
				chunkSize: 3000,
				chunkByContentType: false,
			}),
		).toBe(false);
		expect(isChunkingChange(current, { chunkProfiles: null })).toBe(false);
	});

	it("is true for any chunking field that changes", () => {
		expect(isChunkingChange(current, { chunkByContentType: true })).toBe(
			true,
		);
		expect(isChunkingChange(current, { chunkSize: 2000 })).toBe(true);
		expect(isChunkingChange(current, { chunkOverlap: 100 })).toBe(true);
		expect(isChunkingChange(current, { splitMethod: "RECURSIVE" })).toBe(
			true,
		);
		expect(
			isChunkingChange(current, {
				chunkProfiles: { prd: { target: 1500 } },
			}),
		).toBe(true);
	});
});

describe("project chunking settings", () => {
	beforeEach(() => {
		upsert.mockReset();
		findUnique.mockReset();
	});

	it("reads a project without settings as off, version 0", async () => {
		findUnique.mockResolvedValue(null);
		const settings = await getProjectChunkingSettings("p1");
		expect(settings.chunkByContentType).toBe(false);
		expect(settings.chunkingVersion).toBe(0);
	});

	it("bumps the version on every saved change", async () => {
		upsert.mockResolvedValue({ chunkingVersion: 4 });
		const result = await saveProjectChunkingChange({
			projectId: "p1",
			userId: "u1",
			organizationId: "org-example",
			change: { chunkByContentType: true },
		});
		expect(result.chunkingVersion).toBe(4);
		const args = upsert.mock.calls[0]?.[0];
		expect(args.update).toEqual({
			chunkByContentType: true,
			chunkingVersion: { increment: 1 },
		});
		expect(args.create).toMatchObject({
			projectId: "p1",
			organizationId: "org-example",
			chunkByContentType: true,
			chunkingVersion: 1,
		});
	});
});
