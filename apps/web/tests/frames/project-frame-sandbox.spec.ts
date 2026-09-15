import { expect, test } from "@playwright/test";

/**
 * Browser-level proof of the project-frame sandbox (inverted-loop plan,
 * Slice 3 "Frame rendering — prerequisite"). Uses the internal fixture at
 * `/app/frames/sandbox-check` (dev/test builds only). Skipped unless a dev
 * server is reachable through `E2E_BASE_URL`.
 */

const baseUrl = process.env.E2E_BASE_URL;

test.describe("project frame sandbox", () => {
	test.skip(
		!baseUrl,
		"Set E2E_BASE_URL to a running web dev server to exercise the sandbox fixture",
	);

	test("a project frame cannot reach its parent document or the network", async ({
		page,
	}) => {
		await page.goto(`${baseUrl}/app/frames/sandbox-check`);
		await expect(page.getByTestId("sandbox-check-page")).toBeVisible();

		const iframe = page.locator('iframe[data-frame-scope="project"]');
		await expect(iframe).toHaveCount(1);
		await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
		const sandbox = await iframe.getAttribute("sandbox");
		expect(sandbox ?? "").not.toContain("allow-same-origin");

		const frame = page.frameLocator('iframe[data-frame-scope="project"]');
		await expect(frame.locator("#heading")).toHaveText("Sandbox fixture");

		// The fixture's own script reports what it could do.
		await expect(frame.locator("#parent-access")).toHaveText("blocked");
		await expect(frame.locator("#fetch-access")).toHaveText("blocked");

		// Nested browsing contexts are stripped before the srcdoc is built.
		await expect(frame.locator("iframe")).toHaveCount(0);

		// Independent probes evaluated inside the sandboxed document.
		const probes = await frame.locator("body").evaluate(async () => {
			let parentAccess: string;
			try {
				void window.parent.document;
				parentAccess = "accessible";
			} catch {
				parentAccess = "blocked";
			}
			let fetchAccess: string;
			try {
				await fetch("https://example.com/", { mode: "no-cors" });
				fetchAccess = "allowed";
			} catch {
				fetchAccess = "blocked";
			}
			const csp =
				document
					.querySelector('meta[http-equiv="Content-Security-Policy"]')
					?.getAttribute("content") ?? "";
			return { parentAccess, fetchAccess, csp, origin: window.origin };
		});

		expect(probes.parentAccess).toBe("blocked");
		expect(probes.fetchAccess).toBe("blocked");
		expect(probes.csp).toContain("default-src 'none'");
		// An opaque origin serialises as "null" — the sandbox dropped same-origin.
		expect(probes.origin).toBe("null");
	});
});
