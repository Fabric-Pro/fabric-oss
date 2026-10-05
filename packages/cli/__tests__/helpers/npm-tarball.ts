/**
 * Archives shaped like the ones `npm pack` writes: gzip around ustar, every
 * entry under `package/`.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const BLOCK = 512;

function header(name: string, size: number, type: string): Buffer {
	const block = Buffer.alloc(BLOCK);
	block.write(name, 0, "utf8");
	block.write("0000644\0", 100);
	block.write("0000000\0", 108);
	block.write("0000000\0", 116);
	block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
	block.write("00000000000\0", 136);
	block.write("        ", 148);
	block.write(type, 156);
	block.write("ustar\0", 257);
	block.write("00", 263);
	let sum = 0;
	for (const byte of block) {
		sum += byte;
	}
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return block;
}

export interface TarEntry {
	name: string;
	content: string;
	/** `0` for a file, `5` for a directory. */
	type?: string;
}

/** The tar, before it is compressed. */
export function tarOf(entries: TarEntry[]): Buffer {
	const parts: Buffer[] = [];
	for (const { name, content, type = "0" } of entries) {
		const body = Buffer.from(content);
		parts.push(
			header(name, body.length, type),
			body,
			Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK),
		);
	}
	parts.push(Buffer.alloc(BLOCK * 2));
	return Buffer.concat(parts);
}

export function npmTarball(entries: TarEntry[]): Buffer {
	return gzipSync(tarOf(entries));
}

/** What a manifest's `integrity` holds for these bytes. */
export function sriSha512(bytes: Uint8Array): string {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
