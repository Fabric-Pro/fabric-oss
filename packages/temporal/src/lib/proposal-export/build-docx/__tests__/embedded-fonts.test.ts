/**
 * The faces the Word export embeds (Fizzy #2946): each a committed TrueType
 * file under the family name its own name table gives, packed into the DOCX
 * and filed into its family's slots the way Word reads embedded fonts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
	DOCX_EMBEDDED_FAMILIES,
	DOCX_MONO_MEDIUM_FAMILY,
	type DocxFontRole,
	docxEmbeddedFonts,
	finishEmbeddedFonts,
} from "../embedded-fonts";

/** The sfnt version of a TrueType-outline font. */
const TRUETYPE = [0x00, 0x01, 0x00, 0x00];
/** Word obfuscates the first 32 bytes of each embedded face. */
const OBFUSCATED_BYTES = 32;

const FONT_DIR = join(__dirname, "..", "..", "fonts");

function committedFace(file: string): Buffer {
	return readFileSync(join(FONT_DIR, file));
}

/** The offset of a font's table `tag`. */
function tableOffset(font: Buffer, tag: string): number {
	const tables = font.readUInt16BE(4);
	let offset = -1;
	for (let i = 0; i < tables; i++) {
		const record = 12 + i * 16;
		if (font.toString("latin1", record, record + 4) === tag) {
			offset = font.readUInt32BE(record + 8);
		}
	}
	expect(offset).toBeGreaterThan(0);
	return offset;
}

/** The Windows, US English records of a font's `name` table, by name id. */
function nameRecords(font: Buffer): Map<number, string> {
	const offset = tableOffset(font, "name");
	const count = font.readUInt16BE(offset + 2);
	const strings = offset + font.readUInt16BE(offset + 4);
	const records = new Map<number, string>();
	for (let i = 0; i < count; i++) {
		const record = offset + 6 + i * 12;
		const platform = font.readUInt16BE(record);
		const language = font.readUInt16BE(record + 4);
		if (platform !== 3 || language !== 0x409) {
			continue;
		}
		const start = strings + font.readUInt16BE(record + 10);
		const utf16be = font.subarray(
			start,
			start + font.readUInt16BE(record + 8),
		);
		records.set(
			font.readUInt16BE(record + 6),
			Buffer.from(utf16be).swap16().toString("utf16le"),
		);
	}
	return records;
}

/**
 * An embedded part as Word reads it: the first 32 bytes XORed with the
 * font key's 16 bytes in reverse order (ECMA-376 Part 1, 17.8.1).
 */
function deobfuscate(part: Buffer, fontKey: string): Buffer {
	const key = (fontKey.replace(/[{}-]/g, "").match(/../g) ?? [])
		.map((pair) => Number.parseInt(pair, 16))
		.reverse();
	expect(key).toHaveLength(16);
	const out = Buffer.from(part);
	for (let i = 0; i < OBFUSCATED_BYTES; i++) {
		out[i] = (out[i] ?? 0) ^ (key[i % key.length] ?? 0);
	}
	return out;
}

function packedFace(name: string): Buffer {
	const face = docxEmbeddedFonts().find((font) => font.name === name);
	if (face === undefined) {
		throw new Error(`No embedded face packed as ${name}`);
	}
	return face.data;
}

async function packWithFonts(roles?: readonly DocxFontRole[]): Promise<Buffer> {
	const document = new Document({
		fonts: docxEmbeddedFonts(roles),
		sections: [
			{
				children: [
					new Paragraph({
						children: [
							new TextRun({
								text: "Example body",
								font: DOCX_EMBEDDED_FAMILIES.body,
							}),
						],
					}),
				],
			},
		],
	});
	return Packer.toBuffer(document);
}

/** A finished package's font table, relationships and parts. */
async function readFonts(docx: Buffer) {
	const zip = await JSZip.loadAsync(docx);
	const fontTable =
		(await zip.file("word/fontTable.xml")?.async("string")) ?? "";
	const rels =
		(await zip.file("word/_rels/fontTable.xml.rels")?.async("string")) ??
		"";
	const targets = new Map(
		[...rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map(
			([, id, target]) => [id ?? "", target ?? ""],
		),
	);
	const entries = new Map(
		[
			...fontTable.matchAll(
				/<w:font w:name="([^"]+)">([\s\S]*?)<\/w:font>/g,
			),
		].map(([, name, content]) => [name ?? "", content ?? ""]),
	);
	const parts = Object.values(zip.files)
		.filter((entry) => !entry.dir && entry.name.startsWith("word/fonts/"))
		.map((entry) => entry.name)
		.sort();
	/** The face in `slot` of the entry `family`, as Word decodes it. */
	const face = async (family: string, slot: string) => {
		const match = new RegExp(
			`<w:${slot} r:id="([^"]+)" w:fontKey="([^"]+)"/>`,
		).exec(entries.get(family) ?? "");
		if (match?.[1] === undefined || match[2] === undefined) {
			return undefined;
		}
		const part = await zip
			.file(`word/${targets.get(match[1])}`)
			?.async("nodebuffer");
		return part && deobfuscate(part, match[2]);
	};
	return { fontTable, entries, targets, parts, face };
}

describe("docxEmbeddedFonts", () => {
	it("returns the five neutral faces as TrueType files", () => {
		const fonts = docxEmbeddedFonts();

		expect(fonts.map((font) => font.name)).toEqual([
			"Inter",
			"Inter Bold",
			"Poppins",
			"JetBrains Mono",
			"JetBrains Mono Medium",
		]);
		for (const font of fonts) {
			expect(font.data.length).toBeGreaterThan(100_000);
			expect([...font.data.subarray(0, 4)]).toEqual(TRUETYPE);
		}
	});

	it("returns only the faces of the roles asked for", () => {
		const names = (roles: DocxFontRole[]) =>
			docxEmbeddedFonts(roles).map((font) => font.name);

		expect(names(["body"])).toEqual(["Inter", "Inter Bold"]);
		expect(names(["display"])).toEqual(["Poppins"]);
		expect(names(["mono"])).toEqual([
			"JetBrains Mono",
			"JetBrains Mono Medium",
		]);
		expect(names([])).toEqual([]);
	});

	it("reads the files once", () => {
		expect(docxEmbeddedFonts()[0]?.data).toBe(
			docxEmbeddedFonts(["body"])[0]?.data,
		);
	});

	it("names each family as its file's name table does", () => {
		const { body, display, mono } = DOCX_EMBEDDED_FAMILIES;
		const names = (packedAs: string) => nameRecords(packedFace(packedAs));

		expect(names(body).get(1)).toBe(body);
		expect(names(body).get(2)).toBe("Regular");
		expect(names(display).get(1)).toBe(display);
		expect(names(display).get(2)).toBe("Bold");
		expect(names(mono).get(1)).toBe(mono);
		expect(names(mono).get(2)).toBe("Regular");
		// Inter's bold face is a member of the Inter family, not one of its own.
		expect(names(`${body} Bold`).get(1)).toBe(body);
		expect(names(`${body} Bold`).get(2)).toBe("Bold");
		for (const packedAs of [body, `${body} Bold`, display, mono]) {
			expect(names(packedAs).has(16)).toBe(false);
		}
		// JetBrains Mono's Medium face is a family of its own, set regular;
		// only its typographic names (16, 17) group it with the regular face.
		const medium = names(DOCX_MONO_MEDIUM_FAMILY);
		expect(medium.get(1)).toBe(DOCX_MONO_MEDIUM_FAMILY);
		expect(medium.get(2)).toBe("Regular");
		expect(medium.get(16)).toBe(mono);
		expect(medium.get(17)).toBe("Medium");
	});

	it("embeds JetBrains Mono's Medium face as the file declares it: regular, between 400 and 700", () => {
		const font = packedFace(DOCX_MONO_MEDIUM_FAMILY);
		const os2 = tableOffset(font, "OS/2");
		const head = tableOffset(font, "head");

		const weight = font.readUInt16BE(os2 + 4);
		expect(weight).toBeGreaterThan(400);
		expect(weight).toBeLessThan(700);
		// fsSelection: the REGULAR bit set, the BOLD bit clear.
		expect(font.readUInt16BE(os2 + 62) & 0x40).toBe(0x40);
		expect(font.readUInt16BE(os2 + 62) & 0x20).toBe(0);
		// macStyle: not bold.
		expect(font.readUInt16BE(head + 44) & 0x01).toBe(0);
		// fsType 0: installable embedding.
		expect(font.readUInt16BE(os2 + 8)).toBe(0);
	});
});

describe("a DOCX packed with the embedded faces", () => {
	it("holds an obfuscated part and a font table entry for each name", async () => {
		const zip = await JSZip.loadAsync(await packWithFonts());
		const fontTable = await zip.file("word/fontTable.xml")?.async("string");
		const rels = await zip
			.file("word/_rels/fontTable.xml.rels")
			?.async("string");

		for (const { name, data } of docxEmbeddedFonts()) {
			const part = await zip
				.file(`word/fonts/${name}.odttf`)
				?.async("nodebuffer");
			expect(part?.length).toBe(data.length);
			expect(part?.subarray(OBFUSCATED_BYTES)).toEqual(
				data.subarray(OBFUSCATED_BYTES),
			);
			expect(fontTable).toMatch(
				new RegExp(
					`<w:font w:name="${name}">[\\s\\S]*?<w:embedRegular `,
				),
			);
			expect(rels).toContain(`Target="fonts/${name}.odttf"`);
			// The cached face is shared by every export: packing leaves it whole.
			expect([...data.subarray(0, 4)]).toEqual(TRUETYPE);
		}
	});
});

describe("finishEmbeddedFonts", () => {
	it("files each face into its family's slots", async () => {
		const { entries, face } = await readFonts(
			await finishEmbeddedFonts(await packWithFonts()),
		);

		expect([...entries.keys()]).toEqual([
			"Inter",
			"Poppins",
			"JetBrains Mono",
			"JetBrains Mono Medium",
		]);
		expect(await face("Inter", "embedRegular")).toEqual(
			committedFace("Inter-Regular.ttf"),
		);
		expect(await face("Inter", "embedBold")).toEqual(
			committedFace("Inter-Bold.ttf"),
		);
		// Poppins ships bold only: the one face fills both slots.
		expect(await face("Poppins", "embedRegular")).toEqual(
			committedFace("Poppins-Bold.ttf"),
		);
		expect(await face("Poppins", "embedBold")).toEqual(
			committedFace("Poppins-Bold.ttf"),
		);
		expect(await face("JetBrains Mono", "embedRegular")).toEqual(
			committedFace("JetBrainsMono-Regular.ttf"),
		);
		expect(await face("JetBrains Mono", "embedBold")).toBeUndefined();
		// The Medium face is its family's regular face, never a bold one.
		expect(await face("JetBrains Mono Medium", "embedRegular")).toEqual(
			committedFace("JetBrainsMono-Medium.ttf"),
		);
		expect(
			await face("JetBrains Mono Medium", "embedBold"),
		).toBeUndefined();
	});

	it("writes the slots in schema order and hints each family's kind", async () => {
		const { entries, fontTable } = await readFonts(
			await finishEmbeddedFonts(await packWithFonts()),
		);

		// Keys in upper-case hex, as Word writes them.
		const keys = [...fontTable.matchAll(/w:fontKey="([^"]+)"/g)];
		expect(keys).toHaveLength(6);
		for (const [, key] of keys) {
			expect(key).toMatch(
				/^\{[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/,
			);
		}

		expect(entries.get("Inter")).toMatch(
			/<w:family w:val="swiss"\/><w:pitch w:val="variable"\/>[\s\S]*<w:embedRegular [^>]*\/><w:embedBold [^>]*\/>$/,
		);
		expect(entries.get("Poppins")).toMatch(
			/<w:family w:val="swiss"\/>[\s\S]*<w:embedRegular [^>]*\/><w:embedBold [^>]*\/>$/,
		);
		for (const family of ["JetBrains Mono", "JetBrains Mono Medium"]) {
			expect(entries.get(family)).toMatch(
				/<w:family w:val="modern"\/><w:pitch w:val="fixed"\/>[\s\S]*<w:embedRegular [^>]*\/>$/,
			);
			expect(entries.get(family)).not.toContain("<w:embedBold ");
		}
	});

	it("names the parts as Word does, each reached from the font table", async () => {
		const packed = await packWithFonts();
		const before = await JSZip.loadAsync(packed);
		const { fontTable, targets, parts } = await readFonts(
			await finishEmbeddedFonts(packed),
		);

		expect(parts).toEqual([
			"word/fonts/font1.odttf",
			"word/fonts/font2.odttf",
			"word/fonts/font3.odttf",
			"word/fonts/font4.odttf",
			"word/fonts/font5.odttf",
		]);
		const referenced = new Set(
			[...fontTable.matchAll(/r:id="([^"]+)"/g)].map(([, id]) => id),
		);
		// Inter's bold face keeps its relationship, now from Inter's entry.
		expect(referenced.size).toBe(5);
		for (const id of referenced) {
			expect(parts).toContain(`word/${targets.get(id ?? "")}`);
		}
		for (const target of targets.values()) {
			expect(target).not.toContain(" ");
		}
		// Every part keeps its obfuscated bytes.
		const originals = await Promise.all(
			docxEmbeddedFonts().map(({ name }) =>
				before.file(`word/fonts/${name}.odttf`)?.async("nodebuffer"),
			),
		);
		const after = await JSZip.loadAsync(await finishEmbeddedFonts(packed));
		const renamed = await Promise.all(
			parts.map((part) => after.file(part)?.async("nodebuffer")),
		);
		expect(renamed).toEqual(originals);
	});

	it("asks Word to embed the fonts again on save, in the settings' schema order", async () => {
		const settingsOf = async (docx: Buffer) =>
			(await JSZip.loadAsync(docx))
				.file("word/settings.xml")
				?.async("string");
		const packed = await packWithFonts();
		const before = await settingsOf(packed);
		const after = await settingsOf(await finishEmbeddedFonts(packed));

		expect(before).not.toContain("embedTrueTypeFonts");
		// Of the elements the schema puts before it, docx writes only this one.
		expect(after).toContain(
			"<w:displayBackgroundShape/><w:embedTrueTypeFonts/>",
		);
		expect(after?.match(/<w:embedTrueTypeFonts\/>/g)).toHaveLength(1);
		// Finishing twice still writes it once.
		expect(
			(
				await settingsOf(
					await finishEmbeddedFonts(
						await finishEmbeddedFonts(packed),
					),
				)
			)?.match(/<w:embedTrueTypeFonts\/>/g),
		).toHaveLength(1);
	});

	it("files only the faces packed", async () => {
		const { entries, parts, face } = await readFonts(
			await finishEmbeddedFonts(await packWithFonts(["body"])),
		);

		expect([...entries.keys()]).toEqual(["Inter"]);
		expect(parts).toHaveLength(2);
		expect(await face("Inter", "embedBold")).toEqual(
			committedFace("Inter-Bold.ttf"),
		);
	});

	it("leaves Poppins' regular slot empty when a brand's font is named Poppins", async () => {
		// Display left neutral, body chosen by the brand as Poppins: the body
		// runs name the same entry and are not bold.
		for (const brandFamilies of [["Poppins"], ["poppins"]]) {
			const { entries, face } = await readFonts(
				await finishEmbeddedFonts(
					await packWithFonts(["display", "mono"]),
					brandFamilies,
				),
			);

			expect([...entries.keys()]).toEqual([
				"Poppins",
				"JetBrains Mono",
				"JetBrains Mono Medium",
			]);
			expect(await face("Poppins", "embedBold")).toEqual(
				committedFace("Poppins-Bold.ttf"),
			);
			expect(await face("Poppins", "embedRegular")).toBeUndefined();
			expect(entries.get("Poppins")).not.toContain("<w:embedRegular ");
		}
	});

	it("fills Poppins' regular slot with its bold face when no brand's font is named Poppins", async () => {
		for (const brandFamilies of [[], ["Example Sans"]]) {
			const { face } = await readFonts(
				await finishEmbeddedFonts(
					await packWithFonts(["display"]),
					brandFamilies,
				),
			);

			expect(await face("Poppins", "embedRegular")).toEqual(
				committedFace("Poppins-Bold.ttf"),
			);
			expect(await face("Poppins", "embedBold")).toEqual(
				committedFace("Poppins-Bold.ttf"),
			);
		}
	});

	it("keeps both of Inter's faces when a brand's font is named Inter", async () => {
		// Each Inter face is its own weight, so neither stands in for the
		// other and a brand's Inter runs draw in the right one.
		const { entries, face } = await readFonts(
			await finishEmbeddedFonts(await packWithFonts(["body"]), ["Inter"]),
		);

		expect([...entries.keys()]).toEqual(["Inter"]);
		expect(await face("Inter", "embedRegular")).toEqual(
			committedFace("Inter-Regular.ttf"),
		);
		expect(await face("Inter", "embedBold")).toEqual(
			committedFace("Inter-Bold.ttf"),
		);
	});

	it("never files the Medium face in JetBrains Mono's bold slot, whatever font a brand chose", async () => {
		// A brand's bold "JetBrains Mono" runs take the reader's bold face or a
		// thickened regular, never the Medium one.
		for (const brandFamilies of [
			[],
			["JetBrains Mono"],
			["jetbrains mono"],
			["JetBrains Mono Medium"],
		]) {
			const { entries, face } = await readFonts(
				await finishEmbeddedFonts(
					await packWithFonts(["mono"]),
					brandFamilies,
				),
			);

			expect([...entries.keys()]).toEqual([
				"JetBrains Mono",
				"JetBrains Mono Medium",
			]);
			expect(await face("JetBrains Mono", "embedRegular")).toEqual(
				committedFace("JetBrainsMono-Regular.ttf"),
			);
			expect(await face("JetBrains Mono", "embedBold")).toBeUndefined();
			expect(await face("JetBrains Mono Medium", "embedRegular")).toEqual(
				committedFace("JetBrainsMono-Medium.ttf"),
			);
			expect(
				await face("JetBrains Mono Medium", "embedBold"),
			).toBeUndefined();
		}
	});

	it("returns a file with no embedded fonts as it came", async () => {
		const packed = await Packer.toBuffer(
			new Document({
				sections: [{ children: [new Paragraph("Example")] }],
			}),
		);

		expect(await finishEmbeddedFonts(packed)).toBe(packed);
	});
});
