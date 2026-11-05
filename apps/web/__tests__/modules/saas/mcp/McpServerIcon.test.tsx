/**
 * A stored icon URL can 404 (a server-provided icon whose site moved it, or
 * one behind a routing gap). McpServerIcon must then move to the next
 * candidate, and once all fail, show the initial, never a broken image.
 */
import { McpServerIcon } from "@saas/mcp/components/McpServerIcon";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("McpServerIcon broken-image fallback", () => {
	it("tries each candidate in order, then shows the server's initial", () => {
		const { container } = render(
			<McpServerIcon
				name="Example server"
				iconUrl="https://example.com/brand/missing.svg"
				defaultUrl="https://mcp.example.com/mcp"
			/>,
		);

		const seen: string[] = [];
		for (let guard = 0; guard < 10; guard++) {
			const img = container.querySelector("img");
			if (!img) {
				break;
			}
			seen.push(img.getAttribute("src") ?? "");
			fireEvent.error(img);
		}

		expect(seen).toEqual([
			"https://example.com/brand/missing.svg",
			"https://www.google.com/s2/favicons?domain=mcp.example.com&sz=64",
			"https://mcp.example.com/favicon.ico",
		]);
		expect(container.querySelector("img")).toBeNull();
		expect(container.textContent).toBe("E");
	});

	it("starts again from the stored icon when the icon URL changes", () => {
		const { container, rerender } = render(
			<McpServerIcon
				name="Example server"
				iconUrl="https://example.com/old.svg"
				defaultUrl="https://example.com/mcp"
			/>,
		);
		fireEvent.error(container.querySelector("img") as HTMLImageElement);
		rerender(
			<McpServerIcon
				name="Example server"
				iconUrl="https://example.com/new.svg"
				defaultUrl="https://example.com/mcp"
			/>,
		);
		expect(container.querySelector("img")?.getAttribute("src")).toBe(
			"https://example.com/new.svg",
		);
	});
});
