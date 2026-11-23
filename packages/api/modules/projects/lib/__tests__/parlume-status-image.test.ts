import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParlumeAttendeeSettings } from "../parlume-attendee";
import {
	outputParlumeStatusImage,
	PARLUME_TILE_STATES,
	parlumeStatusImage,
} from "../parlume-status-image";

const attendee: ParlumeAttendeeSettings = {
	apiKey: "operator-key",
	baseUrl: "https://app.attendee.dev",
	teamsLoginMode: null,
	teamsLoginGroup: null,
	webhookSecret: null,
	source: "environment",
};

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
	fetchMock.mockReset();
});

/** The RGB of one pixel of an 8-bit RGB PNG with one IDAT chunk. */
function pixelAt(png: Buffer, x: number, y: number): number[] {
	const width = png.readUInt32BE(16);
	let offset = 8;
	for (;;) {
		const length = png.readUInt32BE(offset);
		const type = png.toString("ascii", offset + 4, offset + 8);
		if (type === "IDAT") {
			const pixels = inflateSync(
				png.subarray(offset + 8, offset + 8 + length),
			);
			const at = y * (1 + width * 3) + 1 + x * 3;
			return [
				pixels[at] ?? -1,
				pixels[at + 1] ?? -1,
				pixels[at + 2] ?? -1,
			];
		}
		offset += 12 + length;
	}
}

describe("parlumeStatusImage", () => {
	it("draws a 640×360 PNG per state, each with its own glyph colour on the same background", () => {
		const centres = PARLUME_TILE_STATES.map((state) => {
			const png = parlumeStatusImage(state);
			expect(png.subarray(0, 8)).toEqual(
				Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			);
			expect(png.readUInt32BE(16)).toBe(640);
			expect(png.readUInt32BE(20)).toBe(360);
			expect(pixelAt(png, 0, 0)).toEqual([24, 24, 27]);
			return pixelAt(png, state === "PAUSED" ? 300 : 320, 180);
		});

		expect(centres).toEqual([
			[52, 211, 153],
			[251, 191, 36],
			[196, 85, 106],
		]);
		// The pause sign is two bars with a gap between them.
		expect(pixelAt(parlumeStatusImage("PAUSED"), 320, 180)).toEqual([
			24, 24, 27,
		]);
	});

	it("draws each image once", () => {
		expect(parlumeStatusImage("LISTENING")).toBe(
			parlumeStatusImage("LISTENING"),
		);
	});
});

describe("outputParlumeStatusImage", () => {
	it("shows the state's PNG on the bot's video tile", async () => {
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

		await outputParlumeStatusImage({
			attendee,
			providerBotId: "bot_abc123",
			state: "PAUSED",
		});

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe(
			"https://app.attendee.dev/api/v1/bots/bot_abc123/output_image",
		);
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			Authorization: "Token operator-key",
			"content-type": "application/json",
		});
		expect(JSON.parse(String(init.body))).toEqual({
			type: "image/png",
			data: parlumeStatusImage("PAUSED").toString("base64"),
		});
	});

	it("reports a refusal", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ error: "Bot not found" }), {
				status: 404,
			}),
		);

		await expect(
			outputParlumeStatusImage({
				attendee,
				providerBotId: "bot_abc123",
				state: "LISTENING",
			}),
		).rejects.toThrow();
	});
});
