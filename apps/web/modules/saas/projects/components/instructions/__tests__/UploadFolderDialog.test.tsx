import en from "@repo/i18n/translations/en.json";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Fragment, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// Resolve `t()`/`t.rich()` to the REAL shipped copy (not the raw key the
// repo's global `vitest.setup.ts` mock echoes back) so assertions below
// target actual rendered English, the same way
// `DiffReviewBar.test.tsx`/`CreateDocumentDialog.test.tsx` do for their own
// components.
const uploadDialogCopy = en.projects.codingInstructions.uploadDialog as Record<
	string,
	string
>;

function interpolate(template: string, values?: Record<string, unknown>) {
	if (!values) {
		return template;
	}
	return template.replace(/\{(\w+)\}/g, (_, name) => String(values[name]));
}

/** Minimal `t.rich` stand-in: replaces `<tag>inner</tag>` with `tags[tag](inner)`. */
function richRender(
	template: string,
	tags: Record<string, (chunks: string) => ReactNode>,
): ReactNode[] {
	const nodes: ReactNode[] = [];
	const re = /<(\w+)>(.*?)<\/\1>/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;
	let key = 0;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
	while ((match = re.exec(template))) {
		if (match.index > lastIndex) {
			nodes.push(
				<Fragment key={key++}>
					{template.slice(lastIndex, match.index)}
				</Fragment>,
			);
		}
		const render = tags[match[1]];
		nodes.push(
			<Fragment key={key++}>
				{render ? render(match[2]) : match[2]}
			</Fragment>,
		);
		lastIndex = re.lastIndex;
	}
	if (lastIndex < template.length) {
		nodes.push(
			<Fragment key={key++}>{template.slice(lastIndex)}</Fragment>,
		);
	}
	return nodes;
}

vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (key: string, values?: Record<string, unknown>) =>
			interpolate(uploadDialogCopy[key] ?? key, values);
		t.rich = (
			key: string,
			tags: Record<string, (chunks: string) => ReactNode>,
		) => richRender(uploadDialogCopy[key] ?? key, tags);
		t.raw = (key: string) => uploadDialogCopy[key] ?? key;
		return t;
	},
}));

const uploadSnapshot = vi
	.fn()
	.mockResolvedValue({ snapshotId: "snap_1", serverExcludedPaths: [] });
vi.mock("../../../lib/upload-snapshot", () => ({
	uploadSnapshot: (...a: unknown[]) => uploadSnapshot(...a),
}));

import { UploadFolderDialog } from "../UploadFolderDialog";

function pick(path: string, content = "x") {
	const f = new File([content], path.slice(path.lastIndexOf("/") + 1));
	Object.defineProperty(f, "webkitRelativePath", { value: path });
	return f;
}

describe("UploadFolderDialog", () => {
	it("previews kept and excluded rows, then uploads only what is kept", async () => {
		const onUploaded = vi.fn();
		render(
			<UploadFolderDialog
				projectId="proj_1"
				open
				onOpenChange={() => undefined}
				onUploaded={onUploaded}
			/>,
		);
		const input = screen.getByLabelText(
			"Choose folder",
		) as HTMLInputElement;
		await userEvent.upload(input, [
			pick("repo/CLAUDE.md", "# x"),
			pick("repo/tasks/a.md"),
		]);
		await waitFor(() =>
			expect(
				screen.getByText(
					/1 files, .* will be uploaded\. 1 files will be left out\./,
				),
			).toBeInTheDocument(),
		);
		expect(screen.getByText("default rule")).toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: /Upload 1 files/ }),
		);
		await waitFor(() => expect(onUploaded).toHaveBeenCalledWith("snap_1"));
		expect(uploadSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj_1",
				publishOnReady: true,
			}),
		);
	});

	it("warns that a credential file will be rejected, naming it, while leaving Upload enabled (R28)", async () => {
		render(
			<UploadFolderDialog
				projectId="proj_1"
				open
				onOpenChange={() => undefined}
				onUploaded={vi.fn()}
			/>,
		);
		await userEvent.upload(
			screen.getByLabelText("Choose folder") as HTMLInputElement,
			[pick("repo/CLAUDE.md", "# x"), pick("repo/.env", "PORT=3000")],
		);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("1 files will be rejected");
		expect(alert).toHaveTextContent(".env");
		expect(screen.getByText("will be rejected")).toBeInTheDocument();
		// The server is the authority; a client-side guess must never be able
		// to block an upload the server would have accepted.
		expect(
			screen.getByRole("button", { name: /Upload 2 files/ }),
		).toBeEnabled();
	});

	it("clicking the visible 'Choose folder' button clicks the (sr-only, not display:none) file input", async () => {
		// The regression this guards: Chromium 124+ silently refuses to open
		// the OS folder picker for a programmatic `.click()` on an input
		// with `display: none` (`className="hidden"`); `sr-only` (visually
		// hidden, still in the layout/accessibility tree) does not have that
		// restriction. jsdom doesn't enforce the Chromium-specific block
		// either way, so this test can only prove the button-to-input WIRING
		// (that clicking the button calls `.click()` on the real input
		// element) and that the input is not `display:none` — actual
		// Chromium behavior needs a browser, per the review that raised
		// this.
		const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click");
		render(
			<UploadFolderDialog
				projectId="proj_1"
				open
				onOpenChange={() => undefined}
				onUploaded={vi.fn()}
			/>,
		);
		const input = screen.getByLabelText("Choose folder");
		expect(input).not.toHaveClass("hidden");
		await userEvent.click(
			screen.getByRole("button", { name: "Choose folder" }),
		);
		expect(clickSpy).toHaveBeenCalled();
		clickSpy.mockRestore();
	});
});
