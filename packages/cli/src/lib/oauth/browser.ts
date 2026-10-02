/**
 * Open a URL in the person's default browser.
 *
 * No shell is involved: the URL is passed as one argument to the platform's
 * opener, so nothing in it can be read as a command. Failure is silent by
 * design; the login command always prints the URL as well.
 */

import { spawn } from "node:child_process";

function openerFor(
	platform: NodeJS.Platform,
	url: string,
): { command: string; args: string[] } {
	if (platform === "win32") {
		return {
			command: "rundll32",
			args: ["url.dll,FileProtocolHandler", url],
		};
	}
	if (platform === "darwin") {
		return { command: "open", args: [url] };
	}
	return { command: "xdg-open", args: [url] };
}

export function openBrowser(url: string): void {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("Refusing to open a non-web URL.");
	}

	const { command, args } = openerFor(process.platform, url);
	const child = spawn(command, args, { stdio: "ignore", detached: true });
	child.on("error", () => {});
	child.unref();
}
