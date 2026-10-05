/**
 * One file out of an npm tarball, read in memory.
 *
 * `npm pack` writes a gzip-compressed ustar archive. Nothing here touches the
 * filesystem: the entry is matched by its exact name and returned as bytes, so
 * a hostile archive cannot name a path to write to, and the sizes are bounded
 * before anything large is allocated (`maxOutputLength` stops the gunzip
 * itself, not just the result).
 */
import { gunzipSync } from "node:zlib";

const BLOCK = 512;
const REGULAR_FILE = [0x30, 0x00];

export class TarballError extends Error {
	constructor(
		readonly kind: "unreadable" | "too-large" | "missing",
		message: string,
	) {
		super(message);
		this.name = "TarballError";
	}
}

export interface TarballLimits {
	/** The most the archive may hold once gunzipped. */
	maxUnpackedBytes: number;
	/** The most the wanted file may be. */
	maxFileBytes: number;
}

function text(header: Uint8Array, start: number, length: number): string {
	const field = header.subarray(start, start + length);
	const end = field.indexOf(0);
	return Buffer.from(end === -1 ? field : field.subarray(0, end)).toString(
		"utf8",
	);
}

function octal(header: Uint8Array, start: number, length: number): number {
	const value = text(header, start, length).trim();
	if (!/^[0-7]+$/.test(value)) {
		throw new TarballError("unreadable", "a tar header field is not octal");
	}
	return Number.parseInt(value, 8);
}

/** The header's own checksum: its bytes summed with the checksum field read as spaces. */
function checksumMatches(header: Uint8Array): boolean {
	let sum = 0;
	for (let index = 0; index < BLOCK; index++) {
		sum += index >= 148 && index < 156 ? 0x20 : (header[index] as number);
	}
	return sum === octal(header, 148, 8);
}

function entryName(header: Uint8Array): string {
	const name = text(header, 0, 100);
	const prefix = text(header, 345, 155);
	return prefix === "" ? name : `${prefix}/${name}`;
}

/** The bytes of the regular file called `wanted`, which must appear exactly once. */
export function readPackedFile(
	tarball: Uint8Array,
	wanted: string,
	limits: TarballLimits,
): Uint8Array {
	let archive: Uint8Array;
	try {
		archive = gunzipSync(tarball, {
			maxOutputLength: limits.maxUnpackedBytes,
		});
	} catch (error) {
		const tooLarge =
			(error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE";
		throw new TarballError(
			tooLarge ? "too-large" : "unreadable",
			tooLarge
				? "the archive unpacks to more than the limit"
				: "the archive is not gzip",
		);
	}

	let found: Uint8Array | undefined;
	let offset = 0;
	while (offset + BLOCK <= archive.length) {
		const header = archive.subarray(offset, offset + BLOCK);
		if (header.every((byte) => byte === 0)) {
			break;
		}
		if (!checksumMatches(header)) {
			throw new TarballError("unreadable", "a tar header is damaged");
		}
		const size = octal(header, 124, 12);
		const start = offset + BLOCK;
		if (start + size > archive.length) {
			throw new TarballError("unreadable", "the archive is cut short");
		}
		if (
			REGULAR_FILE.includes(header[156] as number) &&
			entryName(header) === wanted
		) {
			if (found !== undefined) {
				throw new TarballError(
					"unreadable",
					`${wanted} appears more than once`,
				);
			}
			if (size > limits.maxFileBytes) {
				throw new TarballError(
					"too-large",
					`${wanted} is larger than the limit`,
				);
			}
			found = archive.subarray(start, start + size);
		}
		offset = start + Math.ceil(size / BLOCK) * BLOCK;
	}

	if (found === undefined) {
		throw new TarballError("missing", `${wanted} is not in the archive`);
	}
	return found;
}
