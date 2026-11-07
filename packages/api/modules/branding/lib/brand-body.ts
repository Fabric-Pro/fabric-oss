import { ORPCError } from "@orpc/server";

const MAX_BRAND_BYTES = 16_384;
/** Read the original stream: safe for Next Request instances and chunked JSON. */
export async function readBrandBody(request: Request): Promise<unknown> {
	const declared = request.headers.get("content-length");
	if (
		declared &&
		/^\d+$/.test(declared) &&
		Number(declared) > MAX_BRAND_BYTES
	) {
		throw tooLarge();
	}
	const reader = request.body?.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let text = "";
	let bytes = 0;
	try {
		if (reader) {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				bytes += value.byteLength;
				if (bytes > MAX_BRAND_BYTES) {
					await reader.cancel().catch(() => undefined);
					throw tooLarge();
				}
				text += decoder.decode(value, { stream: true });
			}
			text += decoder.decode();
		}
		return JSON.parse(text);
	} catch (error) {
		if (error instanceof ORPCError) {
			throw error;
		}
		throw new ORPCError("BAD_REQUEST", {
			message: "Supply a valid JSON brand request",
		});
	} finally {
		reader?.releaseLock();
	}
}
function tooLarge() {
	return new ORPCError("PAYLOAD_TOO_LARGE", {
		message: "Brand request exceeds 16 KiB",
	});
}
