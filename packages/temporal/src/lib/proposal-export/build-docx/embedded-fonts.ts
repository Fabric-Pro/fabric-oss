/**
 * The faces the Word export embeds for the neutral style (Fizzy #2946), so
 * the file is set in the faces the PDF prints in. Word cannot embed woff2,
 * so these are the static TTFs committed beside the print woff2 files in
 * `fonts/`, each under the SIL Open Font License with its own licence file
 * and an entry in THIRD_PARTY_NOTICES.md. A font a brand chose is named, never
 * embedded.
 *
 * Word matches a run's font against the names in the font table, and each
 * entry there holds up to four faces of its family: `w:embedRegular`,
 * `w:embedBold`, `w:embedItalic` and `w:embedBoldItalic`. A bold run takes
 * the bold slot's face; with that slot empty, Word draws the regular face
 * thickened. Each family name follows the file's name table: nameID 1, the
 * family Word lists. Only the Medium file also has a typographic family
 * (nameID 16, "JetBrains Mono", subfamily 17 "Medium"):
 *
 * | File | Family (1) | Subfamily (2) | Full name (4) |
 * |---|---|---|---|
 * | Inter-Regular.ttf | Inter | Regular | Inter Regular |
 * | Inter-Bold.ttf | Inter | Bold | Inter Bold |
 * | Poppins-Bold.ttf | Poppins | Bold | Poppins Bold |
 * | JetBrainsMono-Regular.ttf | JetBrains Mono | Regular | JetBrains Mono Regular |
 * | JetBrainsMono-Medium.ttf | JetBrains Mono Medium | Regular | JetBrains Mono Medium |
 *
 * The slots:
 *
 * - "Inter": Inter-Regular in the regular slot and Inter-Bold in the bold
 *   slot, so bold body text is the real bold face.
 * - "Poppins": the one committed face, bold, in the bold slot, where Word
 *   looks for every display run, since every display run is bold. When no
 *   font a brand chose is named Poppins, the regular slot holds the same
 *   face, so a display run that is not bold, should one appear, is still
 *   Poppins rather than a substitute. When a brand chose Poppins for another
 *   role, that role's runs name this same entry, and a bold face in its
 *   regular slot would set every one of them bold on a machine without
 *   Poppins. The regular slot is then left empty, and those runs take the
 *   reader's Poppins or Word's substitute.
 * - "JetBrains Mono": the regular face, for the mono text print sets at
 *   400.
 * - "JetBrains Mono Medium": the Medium face in its regular slot, for the
 *   eyebrows, labels and header cells print sets at 500. Those runs name
 *   this family and are not bold, as Word names a Medium face itself. The
 *   file declares a regular face (weight class 436, no bold bit), so in the
 *   bold slot of "JetBrains Mono" it would be reached only by a bold run,
 *   which asks for a bold face, and a reader may draw it thickened.
 *
 * docx 9.6.1 writes one face per name, into the regular slot, and names its
 * part after the font. So the file is packed with Inter's bold face under a
 * name of its own, "Inter Bold", and `finishEmbeddedFonts` then moves that
 * face into the bold slot of "Inter", files Poppins' face as above and
 * renames the parts as Word does.
 *
 * All five files allow installable embedding (OS/2 `fsType` 0).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProposalThemePaint } from "@repo/utils/proposal-artifact/theme-tokens";
import type { IPropertiesOptions } from "docx";
import JSZip from "jszip";

/** One embedded face as docx takes it (`new Document({ fonts })`). */
type DocxEmbeddedFont = NonNullable<IPropertiesOptions["fonts"]>[number];

/** A font role of the Word file. */
export type DocxFontRole = keyof ProposalThemePaint["fonts"];

/**
 * The family each neutral role names in the Word file, each embedded, and
 * each the family its file's name table gives.
 */
export const DOCX_EMBEDDED_FAMILIES = {
	display: "Poppins",
	body: "Inter",
	mono: "JetBrains Mono",
} as const satisfies Record<DocxFontRole, string>;

/**
 * The family of the mono role's Medium face, as its file's name table gives
 * it: mono text print sets at 500 names it when the mono role is neutral.
 */
export const DOCX_MONO_MEDIUM_FAMILY = "JetBrains Mono Medium";

/** A slot of a font table entry, by its element name. */
type FontSlot = "embedRegular" | "embedBold";

/** The slots in the order the schema requires within an entry. */
const SLOT_ORDER: readonly FontSlot[] = ["embedRegular", "embedBold"];

interface EmbeddedFace {
	role: DocxFontRole;
	/** The font table entry the face is filed under: its file's family. */
	family: string;
	/**
	 * The name docx packs the face under: the family for a family's first
	 * face, a name of its own for another, since docx writes one face per
	 * name.
	 */
	packedAs: string;
	file: string;
	/** The slot of the face's own weight in its family's entry. */
	slot: FontSlot;
	/**
	 * Slots of another weight the face also fills, since its family has no
	 * face of that weight, unless a font a brand chose is named as the
	 * family: the brand's runs of that weight would then draw in this face.
	 */
	standsInFor?: readonly FontSlot[];
}

const EMBEDDED_FACES: readonly EmbeddedFace[] = [
	{
		role: "body",
		family: DOCX_EMBEDDED_FAMILIES.body,
		packedAs: DOCX_EMBEDDED_FAMILIES.body,
		file: "Inter-Regular.ttf",
		slot: "embedRegular",
	},
	{
		role: "body",
		family: DOCX_EMBEDDED_FAMILIES.body,
		packedAs: `${DOCX_EMBEDDED_FAMILIES.body} Bold`,
		file: "Inter-Bold.ttf",
		slot: "embedBold",
	},
	{
		role: "display",
		family: DOCX_EMBEDDED_FAMILIES.display,
		packedAs: DOCX_EMBEDDED_FAMILIES.display,
		file: "Poppins-Bold.ttf",
		slot: "embedBold",
		standsInFor: ["embedRegular"],
	},
	{
		role: "mono",
		family: DOCX_EMBEDDED_FAMILIES.mono,
		packedAs: DOCX_EMBEDDED_FAMILIES.mono,
		file: "JetBrainsMono-Regular.ttf",
		slot: "embedRegular",
	},
	{
		role: "mono",
		family: DOCX_MONO_MEDIUM_FAMILY,
		packedAs: DOCX_MONO_MEDIUM_FAMILY,
		file: "JetBrainsMono-Medium.ttf",
		slot: "embedRegular",
	},
];

/**
 * The hints a reader that cannot load an embedded face substitutes by:
 * docx writes `auto` and `variable`, and with those Word falls back to its
 * default, often a serif. Inter and Poppins are sans serifs ("swiss"),
 * JetBrains Mono a fixed-pitch face ("modern").
 */
const FAMILY_HINTS: Record<
	DocxFontRole,
	{ family: string; pitch: "variable" | "fixed" }
> = {
	display: { family: "swiss", pitch: "variable" },
	body: { family: "swiss", pitch: "variable" },
	mono: { family: "modern", pitch: "fixed" },
};

/** Beside the print faces: the same directory `fonts.ts` reads. */
const FONT_DIR = join(__dirname, "..", "fonts");

const ALL_ROLES: readonly DocxFontRole[] = ["display", "body", "mono"];

let faceData: ReadonlyMap<string, Buffer> | null = null;

/** Each face's bytes by file, read once per worker process. */
function readFaces(): ReadonlyMap<string, Buffer> {
	if (faceData === null) {
		faceData = new Map(
			EMBEDDED_FACES.map(({ file }) => [
				file,
				readFileSync(join(FONT_DIR, file)),
			]),
		);
	}
	return faceData;
}

/**
 * The faces of `roles` for `new Document({ fonts })`, under the names docx
 * packs them by; `finishEmbeddedFonts` files them into their families' slots
 * after packing. Sharing the buffers between documents is safe: docx
 * obfuscates a copy.
 */
export function docxEmbeddedFonts(
	roles: readonly DocxFontRole[] = ALL_ROLES,
): DocxEmbeddedFont[] {
	const data = readFaces();
	return EMBEDDED_FACES.filter((face) => roles.includes(face.role)).map(
		({ packedAs, file }) => {
			const bytes = data.get(file);
			if (bytes === undefined) {
				throw new Error(`No embedded face read from ${file}`);
			}
			return { name: packedAs, data: bytes };
		},
	);
}

const FONT_TABLE = "word/fontTable.xml";
const FONT_TABLE_RELS = "word/_rels/fontTable.xml.rels";
const FONT_ENTRY = /<w:font w:name="([^"]*)">([\s\S]*?)<\/w:font>/g;
const EMBED_REGULAR = /<w:embedRegular r:id="([^"]+)" w:fontKey="([^"]+)"\/>/;

/** One family's entry as it is rewritten: its leading elements and slots. */
interface FamilyEntry {
	head: string;
	slots: Map<FontSlot, string>;
}

function packedFace(name: string): EmbeddedFace | undefined {
	return EMBEDDED_FACES.find((face) => face.packedAs === name);
}

/**
 * The font table with each embedded face in its family's slots. docx wrote
 * every face in the regular slot of an entry named as it was packed; each
 * face's relationship id and obfuscation key move into the slots the face
 * fills, and an entry left with no face of its own ("Inter Bold") is
 * dropped. Its part and relationship stay, now reached from "Inter".
 *
 * A face fills a slot of another weight only when no family in
 * `brandFamilies` names its family, compared without regard to case: a
 * brand's "poppins" names the same font as "Poppins".
 */
function slotFaces(
	fontTable: string,
	brandFamilies: readonly string[],
): string {
	const named = new Set(brandFamilies.map((family) => family.toLowerCase()));
	const families = new Map<string, FamilyEntry>();
	for (const [, name = "", content = ""] of fontTable.matchAll(FONT_ENTRY)) {
		const face = packedFace(name);
		if (face === undefined) {
			continue;
		}
		const embed = EMBED_REGULAR.exec(content);
		if (embed?.[1] === undefined || embed[2] === undefined) {
			throw new Error(`The font table entry ${name} embeds no face`);
		}
		// Written in upper-case hex, as Word writes it; the key's bytes are
		// the same in either case.
		const reference = `r:id="${embed[1]}" w:fontKey="${embed[2].toUpperCase()}"`;
		const { family } = face;
		const hints = FAMILY_HINTS[face.role];
		const entry = families.get(family) ?? {
			head: content
				.slice(0, embed.index)
				.replace(
					/<w:family w:val="[^"]*"\/>/,
					`<w:family w:val="${hints.family}"/>`,
				)
				.replace(
					/<w:pitch w:val="[^"]*"\/>/,
					`<w:pitch w:val="${hints.pitch}"/>`,
				),
			slots: new Map(),
		};
		const slots = named.has(family.toLowerCase())
			? [face.slot]
			: [face.slot, ...(face.standsInFor ?? [])];
		for (const slot of slots) {
			entry.slots.set(slot, reference);
		}
		families.set(family, entry);
	}
	const written = new Set<string>();
	return fontTable.replace(FONT_ENTRY, (whole, name: string) => {
		const face = packedFace(name);
		if (face === undefined) {
			return whole;
		}
		const { family } = face;
		const entry = families.get(family);
		if (entry === undefined || written.has(family)) {
			return "";
		}
		written.add(family);
		const slots = SLOT_ORDER.flatMap((slot) => {
			const reference = entry.slots.get(slot);
			return reference === undefined ? [] : [`<w:${slot} ${reference}/>`];
		});
		return `<w:font w:name="${family}">${entry.head}${slots.join("")}</w:font>`;
	});
}

/**
 * Renames the embedded font parts to `font1.odttf`, `font2.odttf`, …, as
 * Word names them. docx names each part after its font,
 * `word/fonts/JetBrains Mono.odttf`, and a part name may not hold a space.
 * Word finds each part through the font table's relationships, which are
 * rewritten to match, and reads the obfuscation key from the font table, not
 * the part name. Returns the rewritten relationships, or null when the file
 * embeds no font.
 */
async function renameParts(zip: JSZip, rels: string): Promise<string | null> {
	const renames: { from: string; to: string }[] = [];
	const rewritten = rels.replace(
		/Target="fonts\/([^"]+\.odttf)"/g,
		(_match, part: string) => {
			const to = `font${renames.length + 1}.odttf`;
			renames.push({ from: part, to });
			return `Target="fonts/${to}"`;
		},
	);
	if (renames.length === 0) {
		return null;
	}
	for (const { from, to } of renames) {
		const entry = zip.file(`word/fonts/${from}`);
		if (entry === null) {
			throw new Error(
				`The font table names a missing part: fonts/${from}`,
			);
		}
		const data = await entry.async("uint8array");
		zip.remove(`word/fonts/${from}`);
		zip.file(`word/fonts/${to}`, data);
	}
	return rewritten;
}

const SETTINGS = "word/settings.xml";
const EMBED_TRUE_TYPE_FONTS = "<w:embedTrueTypeFonts/>";

/**
 * The settings with `w:embedTrueTypeFonts`, so Word embeds the faces again
 * when the file is saved: without it, a person who edits the file on a
 * machine without them and sends it on sends it without them. The schema
 * orders the settings' elements; of those before this one, docx writes only
 * `w:displayBackgroundShape`, so the element goes after it, or first when
 * it is absent.
 */
function keepFontsOnSave(settings: string): string {
	if (settings.includes("<w:embedTrueTypeFonts")) {
		return settings;
	}
	const anchor =
		/<w:displayBackgroundShape\/>/.exec(settings) ??
		/<w:settings\b[^>]*>/.exec(settings);
	if (anchor === null) {
		return settings;
	}
	const at = anchor.index + anchor[0].length;
	return `${settings.slice(0, at)}${EMBED_TRUE_TYPE_FONTS}${settings.slice(at)}`;
}

/**
 * Finishes a packed docx's embedded fonts as Word reads them: each face in
 * its family's slots, each part named as Word names it, and the setting
 * that keeps them when the file is saved again. A file with no embedded
 * fonts is returned as it came.
 *
 * `brandFamilies` are the families the file names for the fonts a brand
 * chose. A face never stands in for another weight of one of them, since
 * the brand's runs of that weight would draw in it.
 */
export async function finishEmbeddedFonts(
	docx: Buffer,
	brandFamilies: readonly string[] = [],
): Promise<Buffer> {
	const zip = await JSZip.loadAsync(docx);
	const rels = await zip.file(FONT_TABLE_RELS)?.async("string");
	const fontTable = await zip.file(FONT_TABLE)?.async("string");
	if (rels === undefined || fontTable === undefined) {
		return docx;
	}
	const renamedRels = await renameParts(zip, rels);
	if (renamedRels === null) {
		return docx;
	}
	zip.file(FONT_TABLE_RELS, renamedRels);
	zip.file(FONT_TABLE, slotFaces(fontTable, brandFamilies));
	const settings = await zip.file(SETTINGS)?.async("string");
	if (settings !== undefined) {
		zip.file(SETTINGS, keepFontsOnSave(settings));
	}
	return zip.generateAsync({
		type: "nodebuffer",
		mimeType:
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		compression: "DEFLATE",
	});
}
