import { crc32, deflateSync } from "node:zlib";
import {
	type ParlumeAttendeeSettings,
	postParlumeBotAction,
} from "./parlume-attendee";

/** What the bot's video tile shows: Parlume listening, paused or answering. */
export const PARLUME_TILE_STATES = [
	"LISTENING",
	"PAUSED",
	"ANSWERING",
] as const;
export type ParlumeTileState = (typeof PARLUME_TILE_STATES)[number];

const WIDTH = 640;
const HEIGHT = 360;
type Rgb = readonly [number, number, number];
// The design system's dark background and its secondary, highlight and
// primary colours: listening, paused, answering.
const BACKGROUND: Rgb = [24, 24, 27];
const EMERALD: Rgb = [52, 211, 153];
const AMBER: Rgb = [251, 191, 36];
const ROSE: Rgb = [196, 85, 106];

/** A filled shape, by whether it covers the pixel at (x, y). */
type Shape = (x: number, y: number) => boolean;

function rect(left: number, top: number, width: number, height: number): Shape {
	return (x, y) =>
		x >= left && x < left + width && y >= top && y < top + height;
}

function circle(cx: number, cy: number, radius: number): Shape {
	return (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/**
 * One glyph per state, centred, no text: a dot while Parlume listens, the
 * pause sign while it is paused, and a sound wave while it answers.
 */
function glyph(state: ParlumeTileState): { color: Rgb; shapes: Shape[] } {
	const cx = WIDTH / 2;
	const cy = HEIGHT / 2;
	switch (state) {
		case "LISTENING":
			return { color: EMERALD, shapes: [circle(cx, cy, 48)] };
		case "PAUSED":
			return {
				color: AMBER,
				shapes: [
					rect(cx - 44, cy - 60, 30, 120),
					rect(cx + 14, cy - 60, 30, 120),
				],
			};
		case "ANSWERING":
			return {
				color: ROSE,
				shapes: [50, 90, 130, 90, 50].map((height, index) =>
					rect(cx - 91 + index * 40, cy - height / 2, 22, height),
				),
			};
		default: {
			const unreachable: never = state;
			throw new Error(`Unknown tile state: ${String(unreachable)}`);
		}
	}
}

function pngChunk(type: string, data: Buffer): Buffer {
	const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(typed));
	return Buffer.concat([length, typed, checksum]);
}

function renderPng(state: ParlumeTileState): Buffer {
	const { color, shapes } = glyph(state);
	// Each row opens with filter type 0, then three bytes per pixel.
	const rowBytes = 1 + WIDTH * 3;
	const pixels = Buffer.alloc(rowBytes * HEIGHT);
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const [r, g, b] = shapes.some((shape) => shape(x, y))
				? color
				: BACKGROUND;
			const at = y * rowBytes + 1 + x * 3;
			pixels[at] = r;
			pixels[at + 1] = g;
			pixels[at + 2] = b;
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(WIDTH, 0);
	header.writeUInt32BE(HEIGHT, 4);
	// 8-bit RGB, deflate, no interlace.
	header.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(pixels)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

const rendered = new Map<ParlumeTileState, Buffer>();

/** The PNG the bot's video tile shows for `state`; drawn once per process. */
export function parlumeStatusImage(state: ParlumeTileState): Buffer {
	let png = rendered.get(state);
	if (!png) {
		png = renderPng(state);
		rendered.set(state, png);
	}
	return png;
}

/**
 * Shows `state` on the bot's video tile (Attendee `output_image`); the
 * bridge sends one each time the state changes.
 */
export function outputParlumeStatusImage(input: {
	attendee: ParlumeAttendeeSettings;
	providerBotId: string;
	state: ParlumeTileState;
}): Promise<void> {
	return postParlumeBotAction(input, "output_image", {
		type: "image/png",
		data: parlumeStatusImage(input.state).toString("base64"),
	});
}
