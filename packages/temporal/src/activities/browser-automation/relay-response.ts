import type { Page } from "playwright";
import { fulfillableSetCookies } from "./redirect-chain-cookies";

const RESPONSE_HEADERS_NOT_RELAYED = new Set([
	"connection",
	"content-encoding",
	"content-length",
	"keep-alive",
	"transfer-encoding",
]);

/** Origin and path only; URLs can carry credentials in several other fields. */
export function urlForLog(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return "a relayed response";
	}
}

function passableSetCookies(
	setCookies: readonly string[],
	from: string,
): string[] {
	const { kept, droppedPartitioned } = fulfillableSetCookies(setCookies);
	if (droppedPartitioned > 0) {
		console.warn(
			`[Browser] Dropped ${droppedPartitioned} Partitioned cookie(s) from ${urlForLog(from)}: Chromium cannot store them partitioned through the relay`,
		);
	}
	return kept;
}

export async function toFulfillment(
	response: Response,
	setCookies: readonly string[],
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, name) => {
		const key = name.toLowerCase();
		if (key !== "set-cookie" && !RESPONSE_HEADERS_NOT_RELAYED.has(key)) {
			headers[key] = value;
		}
	});
	// Chromium splits this header on newlines and applies its own cookie rules.
	const cookies = passableSetCookies(setCookies, response.url);
	if (cookies.length > 0) {
		headers["set-cookie"] = cookies.join("\n");
	}
	return {
		status: response.status,
		headers,
		body: Buffer.from(await response.arrayBuffer()),
	};
}

function escapeHtmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** A fresh navigation returns through the route guard, unlike a fulfilled 3xx. */
export function toRefreshFulfillment(
	redirect: Response,
	target: string,
): { status: number; headers: Record<string, string>; body: Buffer } {
	const headers: Record<string, string> = {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
	};
	const cookies = passableSetCookies(
		redirect.headers.getSetCookie(),
		redirect.url,
	);
	if (cookies.length > 0) {
		headers["set-cookie"] = cookies.join("\n");
	}
	const attribute = escapeHtmlAttribute(target);
	return {
		status: 200,
		headers,
		body: Buffer.from(
			`<!doctype html><meta http-equiv="refresh" content="0;url=${attribute}" data-fabric-relay-refresh><title>Redirecting</title><a href="${attribute}">Redirecting</a>`,
		),
	};
}

/** Wait past our intermediate redirect document before judging the destination. */
export async function settleNavigation(page: Page): Promise<void> {
	await page.waitForFunction(
		() => !document.querySelector("meta[data-fabric-relay-refresh]"),
	);
}
