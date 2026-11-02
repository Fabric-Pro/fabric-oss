import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { DeferredResponse } from "../../../components/ai-elements/deferred-response";

describe("DeferredResponse", () => {
	it("keeps text safe while loading, then renders real sanitized Markdown", async () => {
		const markdown =
			"[Open document](/app/example-org/documents/example)\n\n[Unsafe](javascript:alert(1))\n\n<script>window.untrusted = true</script>";
		const { container, rerender } = render(
			<DeferredResponse className="reply">{markdown}</DeferredResponse>,
		);
		expect(container.textContent).toContain(markdown);
		expect(container.querySelector("script")).toBeNull();
		await act(async () => {
			await vi.dynamicImportSettled();
		});
		expect(
			await screen.findByRole("link", { name: "Open document" }),
		).toHaveAttribute("href", "/app/example-org/documents/example");
		expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
		expect(container.querySelector("script")).toBeNull();
		rerender(
			<DeferredResponse components={{ img: () => null }} streaming>
				{
					"Updated answer\n\n![Remote image](https://example.com/image.png)"
				}
			</DeferredResponse>,
		);
		await waitFor(() =>
			expect(screen.getByText("Updated answer")).toBeInTheDocument(),
		);
		expect(container.querySelector("img")).toBeNull();
	});
});
