/**
 * `projects.proposalArtifact.getThemeFont` (Fizzy #2946): the live page of a
 * Proposal in artifact mode reads each uploaded Brand kit font through this
 * one call, members and project guests alike, by the file id its tokens
 * carry. Only the slot's current file of the owning organization is read,
 * its key checked before storage is touched, at most 512 KiB of it, and only
 * when its bytes open as the format its key names.
 *
 * The gate middleware, the permission decision and the client-document
 * loader are the real ones, run over the world in
 * `proposal-artifact-harness.ts`. The Brand kit row is a mock over that
 * world's fake `db`; storage is a mock serving the objects each test gives
 * and recording every read.
 */
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	forgedTrueType,
	forgedWoff2,
	realTrueType,
	realWoff2,
} from "../../../../../__tests__/support/font-fixtures";

const font = vi.hoisted(() => ({
	findBrandKit: vi.fn(),
	getFileMetadata: vi.fn(),
	getObjectStream: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	const base = await (
		await import("./proposal-artifact-harness")
	).databaseModule();
	return {
		...base,
		db: {
			...base.db,
			organizationBrandKit: { findUnique: font.findBrandKit },
		},
	};
});
vi.mock("@repo/storage", async () => ({
	...(await vi.importActual<typeof import("@repo/storage")>("@repo/storage")),
	getStorageProvider: () => ({ getFileMetadata: font.getFileMetadata }),
	getObjectStream: font.getObjectStream,
}));
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./proposal-artifact-harness")).proceduresModule(),
);

import { config } from "@repo/config";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { getProposalThemeFontProcedure } from "../get-theme-font";
import {
	call,
	DOC_A,
	declaredPermission,
	declaredRoute,
	inputRefusal,
	ORG_A,
	ORG_B,
	PROJECT_A,
	PROJECT_B,
	PROPOSAL_BODY,
	refusal,
	resetMocks,
	resetWorld,
	USERS,
	usePermissionCheck,
	world,
} from "./proposal-artifact-harness";

usePermissionCheck(assertProjectPermission);

const PROJECT_CONTEXTS = config.storage.bucketNames.projectContexts;
const DOC_BUSINESS_CASE = "doc-business-case";
const DISPLAY_KEY = `organization-brand/${ORG_A}/fonts/font-display-1.woff2`;
const BODY_KEY = `organization-brand/${ORG_A}/fonts/font-body-1.ttf`;
const MAX_BYTES = 512 * 1024;

/** A file that opens as `tag`, padded to `size` bytes. */
function fontBytes(tag: string | number[], size = 64): Buffer {
	const head =
		typeof tag === "string" ? Buffer.from(tag, "latin1") : Buffer.from(tag);
	return Buffer.concat([
		head,
		Buffer.alloc(Math.max(0, size - head.length), 7),
	]);
}

const WOFF2 = realWoff2();
const TTF = realTrueType();

/** A forged TrueType file whose `head` table, its last 16 bytes, lost its magic. */
function headlessTrueType(): Buffer {
	const bytes = forgedTrueType();
	return bytes.fill(0, bytes.length - 4);
}

interface StoredObject {
	bytes: Buffer;
	/** The size the metadata reports; the real length unless given. */
	size?: number;
}

let objects: Map<string, StoredObject>;
let streams: Readable[];

function store(key: string, object: StoredObject): void {
	objects.set(`${PROJECT_CONTEXTS}/${key}`, object);
}

function kit(overrides: Record<string, string | null> = {}) {
	return {
		displayFontFamily: "Example Serif",
		displayFontKey: DISPLAY_KEY,
		bodyFontFamily: "Example Sans",
		bodyFontKey: BODY_KEY,
		...overrides,
	};
}

type FontResult = { family: string; format: string; base64: string };

function getThemeFont(
	input: Partial<{
		projectId: string;
		documentId: string;
		slot: string;
		fileId: string;
	}> = {},
	userId: string = USERS.guestViewer,
) {
	return call(
		getProposalThemeFontProcedure,
		{
			projectId: PROJECT_A,
			documentId: DOC_A,
			slot: "display",
			fileId: "font-display-1",
			...input,
		},
		userId,
	) as Promise<FontResult>;
}

function nothingRead() {
	expect(font.getFileMetadata).not.toHaveBeenCalled();
	expect(font.getObjectStream).not.toHaveBeenCalled();
}

beforeEach(() => {
	resetWorld();
	resetMocks();
	font.findBrandKit.mockReset();
	font.getFileMetadata.mockReset();
	font.getObjectStream.mockReset();
	objects = new Map();
	streams = [];

	world.documents.set(DOC_BUSINESS_CASE, {
		id: DOC_BUSINESS_CASE,
		projectId: PROJECT_A,
		type: "BUSINESS_CASE",
		content: PROPOSAL_BODY,
	});

	font.findBrandKit.mockImplementation(
		async ({ where }: { where: { organizationId: string } }) =>
			where.organizationId === ORG_A ? kit() : null,
	);
	font.getFileMetadata.mockImplementation(
		async (key: string, options: { bucket: string }) => {
			const object = objects.get(`${options.bucket}/${key}`);
			return object
				? {
						size: object.size ?? object.bytes.length,
						contentType: "application/octet-stream",
						uploadedAt: new Date("2026-10-01T00:00:00.000Z"),
						pathname: key,
						url: key,
					}
				: null;
		},
	);
	font.getObjectStream.mockImplementation(
		async (key: string, options: { bucket: string }) => {
			const object = objects.get(`${options.bucket}/${key}`);
			if (!object) {
				throw new Error("NoSuchKey");
			}
			// Served in 64 KiB chunks, as a network read would arrive.
			const chunks: Buffer[] = [];
			for (let at = 0; at < object.bytes.length; at += 64 * 1024) {
				chunks.push(object.bytes.subarray(at, at + 64 * 1024));
			}
			const stream = Readable.from(chunks);
			vi.spyOn(stream, "destroy");
			streams.push(stream);
			return stream;
		},
	);
	store(DISPLAY_KEY, { bytes: WOFF2 });
	store(BODY_KEY, { bytes: TTF });
});

describe("declared chain", () => {
	it("runs the rollout gate, then DOCUMENT_READ, on its own GET route", () => {
		const chain = (getProposalThemeFontProcedure as { __chain: unknown[] })
			.__chain;
		expect(chain).toHaveLength(2);
		expect(typeof chain[0]).toBe("function");
		expect(declaredPermission(getProposalThemeFontProcedure)).toBe(
			"document:read",
		);
		expect(declaredRoute(getProposalThemeFontProcedure)).toMatchObject({
			method: "GET",
			path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/theme-font",
		});
	});

	it("takes only the display and body slots", async () => {
		const result = await inputRefusal(getThemeFont({ slot: "mono" }));

		expect(result.code).toBe("BAD_REQUEST");
		nothingRead();
	});
});

describe("getThemeFont: the slot's current file", () => {
	it.each([
		["a project guest with a VIEWER role", USERS.guestViewer],
		["a project guest with an EDITOR role", USERS.guestEditor],
		["an organization member", USERS.editor],
		["the owner", USERS.owner],
	])(
		"gives %s the display font, with its family and format",
		async (_label, userId) => {
			const result = await getThemeFont({}, userId);

			expect(result).toEqual({
				family: "Example Serif",
				format: "woff2",
				base64: WOFF2.toString("base64"),
			});
		},
	);

	it("reads the Brand kit of the owning organization, never the guest's own, and the file from the project contexts bucket", async () => {
		await getThemeFont();

		expect(font.findBrandKit).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ where: { organizationId: ORG_A } }),
		);
		expect(font.getFileMetadata).toHaveBeenCalledExactlyOnceWith(
			DISPLAY_KEY,
			{ bucket: PROJECT_CONTEXTS },
		);
		expect(font.getObjectStream).toHaveBeenCalledExactlyOnceWith(
			DISPLAY_KEY,
			{ bucket: PROJECT_CONTEXTS },
		);
		expect(streams[0]?.destroy).toHaveBeenCalled();
	});

	it("selects only the font columns of the Brand kit", async () => {
		await getThemeFont();

		const [args] = font.findBrandKit.mock.calls[0] as [
			{ select: Record<string, boolean> },
		];
		expect(Object.keys(args.select).sort()).toEqual([
			"bodyFontFamily",
			"bodyFontKey",
			"displayFontFamily",
			"displayFontKey",
		]);
	});

	it("gives the body font as TrueType, by either of its opening tags", async () => {
		expect(
			await getThemeFont({ slot: "body", fileId: "font-body-1" }),
		).toEqual({
			family: "Example Sans",
			format: "ttf",
			base64: TTF.toString("base64"),
		});

		const tagged = realTrueType();
		tagged.write("true", 0, "latin1");
		store(BODY_KEY, { bytes: tagged });
		expect(
			await getThemeFont({ slot: "body", fileId: "font-body-1" }),
		).toMatchObject({ format: "ttf", base64: tagged.toString("base64") });
	});

	it("carries nothing but the family, the format and the bytes", async () => {
		const result = await getThemeFont();

		expect(Object.keys(result).sort()).toEqual([
			"base64",
			"family",
			"format",
		]);
		expect(JSON.stringify(result)).not.toContain("organization-brand/");
	});
});

describe("getThemeFont: refusals", () => {
	it("answers NOT_FOUND to every caller with the gate off, reading nothing", async () => {
		world.flags.set(ORG_A, false);

		for (const userId of [
			USERS.owner,
			USERS.editor,
			USERS.guestEditor,
			USERS.guestViewer,
			USERS.outsider,
		]) {
			expect((await refusal(getThemeFont({}, userId))).code).toBe(
				"NOT_FOUND",
			);
		}
		expect(font.findBrandKit).not.toHaveBeenCalled();
		nothingRead();
	});

	it("refuses a caller without access to the project", async () => {
		expect((await refusal(getThemeFont({}, USERS.outsider))).code).toBe(
			"NOT_FOUND",
		);
		expect(
			(
				await refusal(
					getThemeFont(
						{ projectId: PROJECT_B, documentId: DOC_A },
						USERS.outsider,
					),
				)
			).code,
		).toBe("NOT_FOUND");
		expect(font.findBrandKit).not.toHaveBeenCalled();
		nothingRead();
	});

	it("refuses a document that is not a client-document Proposal", async () => {
		expect(
			await refusal(getThemeFont({ documentId: DOC_BUSINESS_CASE })),
		).toMatchObject({ code: "NOT_FOUND", message: "Document not found" });
		expect(font.findBrandKit).not.toHaveBeenCalled();
		nothingRead();
	});

	it.each([
		["an older upload's id", { fileId: "font-display-0" }],
		["the other slot's id", { fileId: "font-body-1" }],
		["a guessed id", { fileId: "font" }],
		["the whole key", { fileId: DISPLAY_KEY }],
	])("refuses %s before storage is touched", async (_label, input) => {
		expect(await refusal(getThemeFont(input))).toMatchObject({
			code: "NOT_FOUND",
			message: "Font not found",
		});
		nothingRead();
	});

	it.each([
		[
			"another organization's",
			`organization-brand/${ORG_B}/fonts/font-display-1.woff2`,
		],
		[
			"a pending upload",
			`organization-brand/${ORG_A}/pending/font-display-1.woff2`,
		],
		["a hero", `organization-brand/${ORG_A}/hero/font-display-1.png`],
		[
			"a nested path",
			`organization-brand/${ORG_A}/fonts/a/font-display-1.woff2`,
		],
		[
			"another extension",
			`organization-brand/${ORG_A}/fonts/font-display-1.otf`,
		],
	])(
		"refuses a Brand kit font key that is %s before any read, even with its id",
		async (_label, key) => {
			font.findBrandKit.mockResolvedValue(kit({ displayFontKey: key }));
			store(key, { bytes: WOFF2 });

			expect((await refusal(getThemeFont())).code).toBe("NOT_FOUND");
			nothingRead();
		},
	);

	it.each([
		["no Brand kit", null],
		["no font file for the slot", kit({ displayFontKey: null })],
		["no family for the file", kit({ displayFontFamily: null })],
		[
			"a family the theme may not write",
			kit({ displayFontFamily: "Serif;}" }),
		],
	])("refuses when there is %s, before any read", async (_label, row) => {
		font.findBrandKit.mockResolvedValue(row);

		expect((await refusal(getThemeFont())).code).toBe("NOT_FOUND");
		nothingRead();
	});

	it.each([
		["an SVG", fontBytes("<svg")],
		["a WOFF 1.0 file", fontBytes("wOFF")],
		["an OpenType CFF file", fontBytes("OTTO")],
		["a bare WOFF2 signature over filler", fontBytes("wOF2")],
		[
			"a WOFF2 file cut short of the length it declares",
			WOFF2.subarray(0, WOFF2.length - 500),
		],
		["a WOFF2 container whose data does not decode", forgedWoff2()],
		["a TrueType file under a WOFF2 key", TTF],
		["fewer than four bytes", Buffer.from("wO")],
	])(
		"refuses display bytes that are %s, so the page keeps its fallback font",
		async (_label, bytes) => {
			store(DISPLAY_KEY, { bytes });

			expect(await refusal(getThemeFont())).toMatchObject({
				code: "NOT_FOUND",
				message: "Font not found",
			});
		},
	);

	// Under the body font's TrueType key, so only the bytes can refuse them.
	it.each([
		[
			"a TrueType file cut inside its table directory",
			TTF.subarray(0, 100),
		],
		["a TrueType file without its head magic", headlessTrueType()],
		["a TrueType container whose tables do not decode", forgedTrueType()],
		[
			"a TrueType file with a corrupted middle",
			Buffer.from(TTF).fill(0xff, 2000, 6000),
		],
		["a WOFF2 file under a TrueType key", WOFF2],
	])(
		"refuses body bytes that are %s, so the page keeps its fallback font",
		async (_label, bytes) => {
			store(BODY_KEY, { bytes });

			expect(
				await refusal(
					getThemeFont({ slot: "body", fileId: "font-body-1" }),
				),
			).toMatchObject({ code: "NOT_FOUND", message: "Font not found" });
		},
	);

	it("refuses an object whose stored size is over 512 KiB without reading it", async () => {
		store(DISPLAY_KEY, {
			bytes: Buffer.concat([WOFF2, Buffer.alloc(MAX_BYTES)]),
		});

		expect((await refusal(getThemeFont())).code).toBe("NOT_FOUND");
		expect(font.getFileMetadata).toHaveBeenCalledTimes(1);
		expect(font.getObjectStream).not.toHaveBeenCalled();
	});

	it("reads a file of exactly 512 KiB", async () => {
		const bytes = realTrueType(MAX_BYTES);
		store(BODY_KEY, { bytes });

		expect(
			(await getThemeFont({ slot: "body", fileId: "font-body-1" }))
				.base64,
		).toBe(bytes.toString("base64"));
	});

	it("abandons a read that passes 512 KiB whatever the stored size said", async () => {
		store(DISPLAY_KEY, {
			bytes: Buffer.concat([WOFF2, Buffer.alloc(MAX_BYTES * 2)]),
			size: 1024,
		});

		expect((await refusal(getThemeFont())).code).toBe("NOT_FOUND");
		expect(streams[0]?.destroy).toHaveBeenCalled();
	});

	it.each([
		["missing", () => objects.clear()],
		["empty", () => store(DISPLAY_KEY, { bytes: Buffer.alloc(0) })],
		[
			"unreadable",
			() =>
				font.getFileMetadata.mockRejectedValue(
					new Error("Access Denied"),
				),
		],
		[
			"gone between the size check and the read",
			() =>
				font.getObjectStream.mockRejectedValue(new Error("NoSuchKey")),
		],
	])("refuses a stored file that is %s", async (_label, arrange) => {
		arrange();

		expect(await refusal(getThemeFont())).toMatchObject({
			code: "NOT_FOUND",
			message: "Font not found",
		});
	});
});
