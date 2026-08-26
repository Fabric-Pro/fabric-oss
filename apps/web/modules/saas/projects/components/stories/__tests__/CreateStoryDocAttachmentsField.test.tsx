import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { describe, expect, it, vi } from "vitest";

// Resolve the `projects.stories.create.docAttachments.*` keys to English so
// assertions match the rendered strings. Mirrors the AttachmentsField test.
vi.mock("next-intl", () => {
	const dictionary: Record<string, string> = {
		dropHint: "Drop documents here",
		attachButton: "Attach documents",
		limitsCaption: "DOCX · XLSX · MD · TXT · EXCALIDRAW · up to 25 MB each",
		removeAriaLabel: "Remove attachment {name}",
		dropzoneAriaLabel:
			"Attach documents — drop here or press Enter to browse",
		designationAriaLabel: "Designation for {name}",
		designationAsset: "Asset (protected)",
		designationContextOnly: "Context only",
		"validationToast.unsupportedType":
			"Unsupported file type — use DOCX, XLSX, MD, TXT, or EXCALIDRAW.",
		"validationToast.tooLarge": "File too large — maximum size is 25 MB.",
	};
	const interpolate = (t: string, p?: Record<string, unknown>) =>
		!p
			? t
			: t.replace(/\{(\w+)\}/g, (_m, k: string) =>
					p[k] !== undefined ? String(p[k]) : `{${k}}`,
				);
	return {
		useTranslations:
			(_ns?: string) =>
			(key: string, params?: Record<string, unknown>) => {
				const t = dictionary[key];
				return t ? interpolate(t, params) : interpolate(key, params);
			},
		useLocale: () => "en",
		NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
			children,
	};
});

import type { PendingDocAttachment } from "../../../lib/text-attachment-validation";
import { CreateStoryDocAttachmentsField } from "../CreateStoryDocAttachmentsField";

const DOCX =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function makeFile(name: string, type: string, sizeBytes = 1024): File {
	const f = new File([""], name, { type });
	Object.defineProperty(f, "size", { value: sizeBytes });
	return f;
}
function pending(name: string, type = DOCX): PendingDocAttachment {
	return { file: makeFile(name, type), designation: "UNLOCKED" };
}

describe("CreateStoryDocAttachmentsField", () => {
	it("renders the caption when empty", () => {
		render(
			<CreateStoryDocAttachmentsField items={[]} onChange={vi.fn()} />,
		);
		expect(screen.getByText(/DOCX · XLSX · MD · TXT/i)).toBeInTheDocument();
	});

	it("adds a picked .docx with the default Context only designation", async () => {
		const onChange = vi.fn();
		render(
			<CreateStoryDocAttachmentsField items={[]} onChange={onChange} />,
		);
		const input = screen.getByTestId(
			"doc-attachments-field-input",
		) as HTMLInputElement;
		await userEvent.upload(input, makeFile("spec.docx", DOCX), {
			applyAccept: false,
		});
		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0][0] as PendingDocAttachment[];
		expect(next).toHaveLength(1);
		expect(next[0].file.name).toBe("spec.docx");
		expect(next[0].designation).toBe("UNLOCKED");
	});

	it("adds a picked .xlsx — spreadsheets reach ticket AI context now", async () => {
		// The reported gap: xlsx could be attached as a general asset but not as
		// context. Enabling it means the context field admits it too.
		const XLSX =
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
		const onChange = vi.fn();
		render(
			<CreateStoryDocAttachmentsField items={[]} onChange={onChange} />,
		);
		const input = screen.getByTestId(
			"doc-attachments-field-input",
		) as HTMLInputElement;
		await userEvent.upload(input, makeFile("budget.xlsx", XLSX), {
			applyAccept: false,
		});
		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0][0] as PendingDocAttachment[];
		expect(next).toHaveLength(1);
		expect(next[0].file.name).toBe("budget.xlsx");
		expect(next[0].designation).toBe("UNLOCKED");
	});

	it("rejects an unsupported type (pdf) without calling onChange", async () => {
		const onChange = vi.fn();
		const onValidationError = vi.fn();
		render(
			<CreateStoryDocAttachmentsField
				items={[]}
				onChange={onChange}
				onValidationError={onValidationError}
			/>,
		);
		const input = screen.getByTestId(
			"doc-attachments-field-input",
		) as HTMLInputElement;
		await userEvent.upload(input, makeFile("a.pdf", "application/pdf"), {
			applyAccept: false,
		});
		expect(onChange).not.toHaveBeenCalled();
		expect(onValidationError).toHaveBeenCalledWith(
			expect.stringMatching(/Unsupported file type/),
		);
	});

	it("rejects an oversized file (over 25 MB)", async () => {
		const onChange = vi.fn();
		const onValidationError = vi.fn();
		render(
			<CreateStoryDocAttachmentsField
				items={[]}
				onChange={onChange}
				onValidationError={onValidationError}
			/>,
		);
		const input = screen.getByTestId(
			"doc-attachments-field-input",
		) as HTMLInputElement;
		await userEvent.upload(
			input,
			makeFile("big.txt", "text/plain", 26 * 1024 * 1024),
			{ applyAccept: false },
		);
		expect(onChange).not.toHaveBeenCalled();
		expect(onValidationError).toHaveBeenCalledWith(
			expect.stringMatching(/File too large/),
		);
	});

	it("accepts more than 10 files (no client-side count cap)", async () => {
		const onChange = vi.fn();
		const onValidationError = vi.fn();
		const items = Array.from({ length: 10 }, (_, i) =>
			pending(`f${i}.docx`),
		);
		render(
			<CreateStoryDocAttachmentsField
				items={items}
				onChange={onChange}
				onValidationError={onValidationError}
			/>,
		);
		const input = screen.getByTestId(
			"doc-attachments-field-input",
		) as HTMLInputElement;
		await userEvent.upload(input, makeFile("f11.docx", DOCX), {
			applyAccept: false,
		});
		// The 11th valid file is accepted — the server's 20-per-story default
		// is authoritative, not a client cap.
		expect(onValidationError).not.toHaveBeenCalled();
		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0][0] as PendingDocAttachment[];
		expect(next).toHaveLength(11);
		expect(next[10].file.name).toBe("f11.docx");
	});

	it("removes a pending file", async () => {
		const onChange = vi.fn();
		const items = [pending("a.docx"), pending("b.txt", "text/plain")];
		render(
			<CreateStoryDocAttachmentsField
				items={items}
				onChange={onChange}
			/>,
		);
		const removeButtons = screen.getAllByLabelText(/Remove attachment/i);
		await userEvent.click(removeButtons[0]);
		const next = onChange.mock.calls[0][0] as PendingDocAttachment[];
		expect(next.map((p) => p.file.name)).toEqual(["b.txt"]);
	});

	it("dropzone is keyboard-reachable (role=button, tabIndex=0, aria-label)", () => {
		render(
			<CreateStoryDocAttachmentsField items={[]} onChange={vi.fn()} />,
		);
		const dz = screen.getByTestId("doc-attachments-field-dropzone");
		expect(dz).toHaveAttribute("role", "button");
		expect(dz).toHaveAttribute("tabindex", "0");
		expect(dz).toHaveAttribute("aria-label");
	});
});
