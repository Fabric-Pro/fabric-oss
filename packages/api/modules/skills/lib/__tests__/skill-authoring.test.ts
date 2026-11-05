import { createHash } from "node:crypto";
import archiver from "archiver";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	create: vi.fn(),
	get: vi.fn(),
	model: vi.fn(),
	generate: vi.fn(),
	usage: vi.fn(),
	upload: vi.fn(),
	remove: vi.fn(),
	download: vi.fn(),
	find: vi.fn(),
	file: vi.fn(),
	count: vi.fn(),
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: mocks.model,
	generateObject: mocks.generate,
	zodSchema: (s: unknown) => s,
}));
vi.mock("ai", () => ({
	generateObject: mocks.generate,
	zodSchema: (s: unknown) => s,
}));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "example-skills" } } },
}));
vi.mock("@repo/database", () => ({
	db: {
		skill: { findFirst: mocks.find },
		skillFile: { findFirst: mocks.file, count: mocks.count },
	},
}));
vi.mock("@repo/storage", () => ({
	uploadFile: mocks.upload,
	deleteFile: mocks.remove,
	downloadFile: mocks.download,
}));
vi.mock("../skill-commands", () => ({
	assertSkillAuthoringAccess: mocks.access,
	createSkillCommand: mocks.create,
	getSkillCommand: mocks.get,
}));

import { SkillError } from "@repo/ai/skill-contracts";
import {
	assistSkillCommand,
	createSkillImportCommand,
	previewSkillImportCommand,
	readSkillFileCommand,
	readSkillImportFileCommand,
} from "../skill-authoring";

const actor = { userId: "example-user", organizationId: "example-org" };
const audit = vi.fn();
const md =
	"---\nname: delivery-brief\ndescription: Use for weekly delivery updates.\n---\n# Delivery brief\nRead references/check.md and cite your sources.";
const source = (bytes: Buffer, fileName = "example.skill") => ({
	kind: "file" as const,
	fileName,
	base64: bytes.toString("base64"),
});
async function bundle() {
	const a = archiver("zip");
	const chunks: Buffer[] = [];
	const done = new Promise<Buffer>((resolve, reject) => {
		a.on("data", (c: Buffer) => chunks.push(c));
		a.on("end", () => resolve(Buffer.concat(chunks)));
		a.on("error", reject);
	});
	a.append(md, { name: "delivery/SKILL.md" });
	a.append("# Review risks", { name: "delivery/references/check.md" });
	await a.finalize();
	return source(await done);
}
const assist = {
	draft: { name: "", slug: "", description: "", content: "", tags: [] },
	message: "Help me write delivery updates",
	history: [],
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.access.mockResolvedValue(undefined);
	mocks.model.mockResolvedValue({ model: {}, trackUsage: mocks.usage });
	mocks.usage.mockResolvedValue(undefined);
	mocks.generate.mockResolvedValue({
		object: {
			message: "What sources should the brief use?",
			proposal: null,
		},
	});
	mocks.upload.mockResolvedValue(undefined);
	mocks.remove.mockResolvedValue(undefined);
	mocks.create.mockResolvedValue({
		skill: { id: "example-draft", isPublished: false },
	});
	mocks.find.mockResolvedValue(null);
	mocks.get.mockResolvedValue({ skill: { id: "example-skill", version: 2 } });
	mocks.count.mockResolvedValue(1);
});
describe("reviewed skill authoring commands", () => {
	it("checks current creation permission before a model call or package fetch", async () => {
		mocks.access.mockRejectedValue(
			new SkillError("FORBIDDEN", "Not permitted"),
		);
		await expect(assistSkillCommand(actor, assist)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		const fetcher = vi.spyOn(globalThis, "fetch");
		await expect(
			previewSkillImportCommand(actor, {
				source: {
					kind: "github",
					url: "https://github.com/example/skills",
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.model).not.toHaveBeenCalled();
		expect(fetcher).not.toHaveBeenCalled();
		fetcher.mockRestore();
	});
	it("returns a reviewed proposal without writing, publishing or uploading", async () => {
		mocks.generate.mockResolvedValue({
			object: {
				message: "Review these instructions.",
				proposal: {
					name: "Delivery brief",
					slug: "delivery-brief",
					description: "Use weekly",
					content: "Cite approved sources.",
					tags: [],
				},
			},
		});
		expect(await assistSkillCommand(actor, assist)).toMatchObject({
			proposal: { slug: "delivery-brief" },
		});
		expect(mocks.usage).toHaveBeenCalledOnce();
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.upload).not.toHaveBeenCalled();
		expect(mocks.access).toHaveBeenCalledTimes(2);
	});
	it("withholds model output after current permission is revoked", async () => {
		mocks.access
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(
				new SkillError("FORBIDDEN", "Not permitted"),
			);
		await expect(assistSkillCommand(actor, assist)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.usage).toHaveBeenCalledOnce();
	});
	it("does not echo provider failure details into the UI", async () => {
		mocks.generate.mockRejectedValue(
			new Error("example-provider-private-response"),
		);
		await expect(assistSkillCommand(actor, assist)).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			message: expect.not.stringContaining(
				"example-provider-private-response",
			),
		});
	});
	it("previews runtime files without writes and refuses changed source before upload", async () => {
		const s = await bundle();
		const p = await previewSkillImportCommand(actor, { source: s });
		expect(p.candidates[0].files[0].path).toBe("references/check.md");
		expect(mocks.create).not.toHaveBeenCalled();
		await expect(
			createSkillImportCommand(
				actor,
				{
					source: s,
					candidateKey: p.candidates[0].key,
					expectedHash: "0".repeat(64),
				},
				audit,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.upload).not.toHaveBeenCalled();
	});
	it("creates only a private draft with reviewed bytes in private storage", async () => {
		const s = await bundle();
		const p = await previewSkillImportCommand(actor, { source: s });
		await createSkillImportCommand(
			actor,
			{
				source: s,
				candidateKey: p.candidates[0].key,
				expectedHash: p.source.sha256,
			},
			audit,
		);
		expect(mocks.upload).toHaveBeenCalledWith(
			expect.stringMatching(/^skills\/skill-import-/),
			Buffer.from("# Review risks"),
			{
				bucket: "example-skills",
				contentType: "text/markdown",
				access: "private",
			},
		);
		expect(mocks.create).toHaveBeenCalledWith(
			actor,
			expect.objectContaining({
				isPublished: false,
				isDiscoverable: false,
				slug: "delivery-brief",
			}),
			audit,
			expect.objectContaining({
				preparedFiles: [
					expect.objectContaining({
						path: "references/check.md",
						sha256: createHash("sha256")
							.update("# Review risks")
							.digest("hex"),
					}),
				],
			}),
		);
	});
	it("cleans an attempted upload when no draft creation could have committed", async () => {
		const s = await bundle();
		const p = await previewSkillImportCommand(actor, { source: s });
		mocks.upload.mockRejectedValue(new Error("write failed"));
		await expect(
			createSkillImportCommand(
				actor,
				{
					source: s,
					candidateKey: p.candidates[0].key,
					expectedHash: p.source.sha256,
				},
				audit,
			),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(mocks.remove).toHaveBeenCalledOnce();
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it.each([true, false, null])(
		"preserves files after an uncertain commit regardless of a separate row lookup (%s)",
		async (rowExists) => {
			const s = await bundle();
			const p = await previewSkillImportCommand(actor, { source: s });
			mocks.create.mockRejectedValue(new Error("lost acknowledgement"));
			if (rowExists === true) {
				mocks.find.mockResolvedValue({ id: "example-draft" });
			} else if (rowExists === false) {
				mocks.find.mockRejectedValue(new Error("db unavailable"));
			}
			await expect(
				createSkillImportCommand(
					actor,
					{
						source: s,
						candidateKey: p.candidates[0].key,
						expectedHash: p.source.sha256,
					},
					audit,
				),
			).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
			expect(mocks.remove).not.toHaveBeenCalled();
			expect(mocks.find).not.toHaveBeenCalled();
		},
	);
	it("reads escaped data for a reviewed package file without executing it", async () => {
		const s = await bundle();
		const p = await previewSkillImportCommand(actor, { source: s });
		expect(
			await readSkillImportFileCommand(actor, {
				source: s,
				candidateKey: p.candidates[0].key,
				expectedHash: p.source.sha256,
				path: "references/check.md",
			}),
		).toMatchObject({ encoding: "utf-8", data: "# Review risks" });
		expect(mocks.upload).not.toHaveBeenCalled();
		await expect(
			readSkillImportFileCommand(actor, {
				source: s,
				candidateKey: p.candidates[0].key,
				expectedHash: p.source.sha256,
				path: "../secret",
			}),
		).rejects.toThrow();
	});
	it("checks saved file bytes, current permission and revision after storage access", async () => {
		const bytes = Buffer.from("# runtime reference");
		mocks.file.mockResolvedValue({
			id: "example-file",
			skillId: "example-skill",
			path: "references/check.md",
			version: 1,
			contentType: "text/markdown",
			sizeBytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			storageKey: "private/example",
		});
		mocks.download.mockResolvedValue({ data: bytes });
		expect(
			await readSkillFileCommand(actor, {
				id: "example-skill",
				path: "references/check.md",
				expectedVersion: 2,
			}),
		).toMatchObject({ data: "# runtime reference" });
		expect(mocks.get).toHaveBeenCalledTimes(2);
		mocks.get
			.mockResolvedValueOnce({
				skill: { id: "example-skill", version: 2 },
			})
			.mockRejectedValueOnce(
				new SkillError("NOT_FOUND", "Access denied"),
			);
		await expect(
			readSkillFileCommand(actor, {
				id: "example-skill",
				path: "references/check.md",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("refuses corrupt stored bytes before returning content", async () => {
		mocks.file.mockResolvedValue({
			id: "example-file",
			path: "references/check.md",
			sizeBytes: 3,
			sha256: "0".repeat(64),
			storageKey: "private/example",
		});
		mocks.download.mockResolvedValue({ data: Buffer.from("abc") });
		await expect(
			readSkillFileCommand(actor, {
				id: "example-skill",
				path: "references/check.md",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});
