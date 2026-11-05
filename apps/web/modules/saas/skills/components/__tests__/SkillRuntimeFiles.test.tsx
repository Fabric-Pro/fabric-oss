import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { SkillRuntimeFiles } from "../SkillRuntimeFiles";

function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			{children}
		</QueryClientProvider>
	);
}
it("only reads a runtime file after it is selected and never treats content as executable markup", async () => {
	const read = vi.fn().mockResolvedValue({
		path: "assets/example.html",
		contentType: "text/html",
		sizeBytes: 10,
		sha256: "a".repeat(64),
		encoding: "utf-8",
		data: '<iframe src="https://example.com"></iframe><script>example()</script>',
	});
	const v = render(
		<SkillRuntimeFiles
			identity="example-org:example-skill:2"
			files={[
				{
					path: "assets/example.html",
					contentType: "text/html",
					sizeBytes: 10,
					version: 2,
				},
			]}
			readFile={read}
		/>,
		{ wrapper },
	);
	expect(read).not.toHaveBeenCalled();
	fireEvent.click(v.getByText("1 supporting file"));
	fireEvent.click(v.getByText("assets"));
	fireEvent.click(v.getByRole("button", { name: "example.html" }));
	await v.findByText(
		'<iframe src="https://example.com"></iframe><script>example()</script>',
	);
	expect(read).toHaveBeenCalledExactlyOnceWith("assets/example.html");
	expect(document.querySelector("iframe")).toBeNull();
	expect(document.querySelector("script")).toBeNull();
});
it("creates binary downloads as local Blob attachments without iframe navigation", async () => {
	const create = vi.fn().mockReturnValue("blob:example-safe-download");
	const revoke = vi.fn();
	const priorCreate = URL.createObjectURL;
	const priorRevoke = URL.revokeObjectURL;
	URL.createObjectURL = create;
	URL.revokeObjectURL = revoke;
	const anchor = vi
		.spyOn(HTMLAnchorElement.prototype, "click")
		.mockImplementation(() => undefined);
	try {
		const read = vi.fn().mockResolvedValue({
			path: "assets/example.bin",
			contentType: "application/octet-stream",
			sizeBytes: 3,
			sha256: "a".repeat(64),
			encoding: "base64",
			data: "YWJj",
		});
		const v = render(
			<SkillRuntimeFiles
				identity="example-org:example-skill:2"
				files={[
					{
						path: "assets/example.bin",
						contentType: "application/octet-stream",
						sizeBytes: 3,
					},
				]}
				readFile={read}
			/>,
			{ wrapper },
		);
		fireEvent.click(v.getByText("1 supporting file"));
		fireEvent.click(v.getByText("assets"));
		fireEvent.click(v.getByRole("button", { name: "example.bin" }));
		await v.findByText(/Binary file/);
		fireEvent.click(v.getByRole("button", { name: "Download file" }));
		expect(create).toHaveBeenCalledWith(expect.any(Blob));
		expect(anchor).toHaveBeenCalledTimes(1);
		expect(document.querySelector("iframe")).toBeNull();
	} finally {
		anchor.mockRestore();
		URL.createObjectURL = priorCreate;
		URL.revokeObjectURL = priorRevoke;
	}
});
it("shows a denied read instead of cached file bytes and reports incomplete manifests honestly", async () => {
	const read = vi.fn().mockRejectedValue(
		Object.assign(new Error("Current access is required"), {
			code: "FORBIDDEN",
		}),
	);
	const v = render(
		<SkillRuntimeFiles
			identity="example-org:example-skill:2"
			complete={false}
			files={[
				{
					path: "references/example.txt",
					contentType: "text/plain",
					sizeBytes: 10,
				},
			]}
			readFile={read}
		/>,
		{ wrapper },
	);
	expect(v.getByText(/file manifest is incomplete/)).toBeInTheDocument();
	fireEvent.click(v.getByText("1 supporting file"));
	fireEvent.click(v.getByText("references"));
	fireEvent.click(v.getByRole("button", { name: "example.txt" }));
	await v.findByText("Current access is required");
	expect(
		v.queryByRole("button", { name: "Download file" }),
	).not.toBeInTheDocument();
	await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
});
