import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

// `vitest.setup.ts` ships a global next-intl mock whose `useTranslations`
// returns `(key) => key`. AttachmentsField now consumes
// `projects.stories.create.attachments.*`, and the assertions below match
// against the rendered English strings (e.g. `/PNG · JPEG · GIF · WebP/`).
// Override the global mock with one that resolves keys via the English
// dictionary and interpolates `{name}` for the remove-button aria-label.
// `NextIntlClientProvider` remains a no-op pass-through (consistent with
// the global mock); tests wrap renders in it to mirror the production tree
// and to be forward-compatible with future provider-driven helpers.
vi.mock("next-intl", () => {
	const dictionary: Record<string, string> = {
		dropHint: "Drop images here",
		attachButton: "Attach images",
		limitsCaption: "PNG · JPEG · GIF · WebP · up to 5 MB each",
		removeAriaLabel: "Remove attachment {name}",
		dropzoneAriaLabel: "Attach images — drop here or press Enter to browse",
		"validationToast.unsupportedType":
			"Unsupported image type. Use PNG, JPEG, GIF, or WebP.",
		"validationToast.tooLarge": "File too large. Maximum size is 5 MB.",
	};
	const interpolate = (
		template: string,
		params?: Record<string, unknown>,
	) => {
		if (!params) {
			return template;
		}
		return template.replace(/\{(\w+)\}/g, (_m, k: string) =>
			params[k] !== undefined ? String(params[k]) : `{${k}}`,
		);
	};
	return {
		useTranslations:
			(_namespace?: string) =>
			(key: string, params?: Record<string, unknown>) => {
				const template = dictionary[key];
				if (template) {
					return interpolate(template, params);
				}
				return interpolate(key, params);
			},
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => ({}),
		NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
			children,
	};
});

import { NextIntlClientProvider } from "next-intl";
import { AttachmentsField } from "../AttachmentsField";

beforeAll(() => {
	(globalThis.URL.createObjectURL as unknown) = vi.fn(() => "blob:fake-url");
	(globalThis.URL.revokeObjectURL as unknown) = vi.fn();
});

function makeFile(name: string, type: string, sizeBytes = 1024): File {
	return new File([new Uint8Array(sizeBytes)], name, { type });
}

function renderWithI18n(ui: React.ReactElement) {
	return render(
		<NextIntlClientProvider locale="en" messages={{}}>
			{ui}
		</NextIntlClientProvider>,
	);
}

describe("AttachmentsField", () => {
	it("renders a caption when empty and no thumbnails", () => {
		renderWithI18n(<AttachmentsField files={[]} onChange={vi.fn()} />);
		expect(
			screen.getByText(/PNG · JPEG · GIF · WebP · up to 5 MB/i),
		).toBeInTheDocument();
		expect(screen.queryAllByRole("img")).toHaveLength(0);
	});

	it("renders one thumbnail per file in order", () => {
		const a = makeFile("a.png", "image/png");
		const b = makeFile("b.png", "image/png");
		renderWithI18n(<AttachmentsField files={[a, b]} onChange={vi.fn()} />);
		const imgs = screen.getAllByRole("img");
		expect(imgs).toHaveLength(2);
		expect(imgs[0]).toHaveAttribute("alt", "a.png");
		expect(imgs[1]).toHaveAttribute("alt", "b.png");
	});

	it("calls onChange with the picked file via the file picker", async () => {
		const onChange = vi.fn();
		renderWithI18n(<AttachmentsField files={[]} onChange={onChange} />);
		const input = screen.getByTestId(
			"attachments-field-input",
		) as HTMLInputElement;
		const file = makeFile("a.png", "image/png");
		await userEvent.upload(input, file);
		expect(onChange).toHaveBeenCalledWith([file]);
	});

	it("rejects unsupported MIME with a validation callback (does not call onChange)", async () => {
		const onChange = vi.fn();
		const onValidationError = vi.fn();
		renderWithI18n(
			<AttachmentsField
				files={[]}
				onChange={onChange}
				onValidationError={onValidationError}
			/>,
		);
		const input = screen.getByTestId(
			"attachments-field-input",
		) as HTMLInputElement;
		await userEvent.upload(input, makeFile("a.bmp", "image/bmp"), {
			applyAccept: false,
		});
		expect(onChange).not.toHaveBeenCalled();
		expect(onValidationError).toHaveBeenCalledWith(
			expect.stringMatching(/Unsupported image type/),
		);
	});

	it("rejects oversized files", async () => {
		const onChange = vi.fn();
		const onValidationError = vi.fn();
		renderWithI18n(
			<AttachmentsField
				files={[]}
				onChange={onChange}
				onValidationError={onValidationError}
			/>,
		);
		const input = screen.getByTestId(
			"attachments-field-input",
		) as HTMLInputElement;
		await userEvent.upload(
			input,
			makeFile("big.png", "image/png", 6 * 1024 * 1024),
		);
		expect(onChange).not.toHaveBeenCalled();
		expect(onValidationError).toHaveBeenCalledWith(
			expect.stringMatching(/File too large/),
		);
	});

	it("removes a file when the user clicks ✕", async () => {
		const a = makeFile("a.png", "image/png");
		const b = makeFile("b.png", "image/png");
		const onChange = vi.fn();
		renderWithI18n(<AttachmentsField files={[a, b]} onChange={onChange} />);
		const removeButtons = screen.getAllByLabelText(/Remove attachment/i);
		await userEvent.click(removeButtons[0]);
		expect(onChange).toHaveBeenCalledWith([b]);
	});

	it("accepts a drop with multiple images", async () => {
		const onChange = vi.fn();
		renderWithI18n(<AttachmentsField files={[]} onChange={onChange} />);
		const dropzone = screen.getByTestId("attachments-field-dropzone");
		const dt = new DataTransfer();
		dt.items.add(makeFile("a.png", "image/png"));
		dt.items.add(makeFile("b.png", "image/png"));
		fireEvent.drop(dropzone, { dataTransfer: dt });
		await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
		const accepted = onChange.mock.calls[0][0] as File[];
		expect(accepted.map((f) => f.name)).toEqual(["a.png", "b.png"]);
	});

	it("dropzone is keyboard-reachable (role=button, tabIndex=0, aria-label)", () => {
		renderWithI18n(<AttachmentsField files={[]} onChange={vi.fn()} />);
		const dz = screen.getByTestId("attachments-field-dropzone");
		expect(dz).toHaveAttribute("role", "button");
		expect(dz).toHaveAttribute("tabindex", "0");
		expect(dz).toHaveAttribute("aria-label");
	});

	it("opens the file picker when the dropzone receives Enter via keyboard", async () => {
		const onChange = vi.fn();
		renderWithI18n(<AttachmentsField files={[]} onChange={onChange} />);
		const dz = screen.getByTestId("attachments-field-dropzone");
		const input = screen.getByTestId(
			"attachments-field-input",
		) as HTMLInputElement;

		const clickSpy = vi.spyOn(input, "click");
		dz.focus();
		await userEvent.keyboard("{Enter}");
		expect(clickSpy).toHaveBeenCalledTimes(1);
	});

	it("dropzone is not focusable when disabled (tabIndex=-1)", () => {
		renderWithI18n(
			<AttachmentsField files={[]} onChange={vi.fn()} disabled />,
		);
		const dz = screen.getByTestId("attachments-field-dropzone");
		expect(dz).toHaveAttribute("tabindex", "-1");
	});
});
