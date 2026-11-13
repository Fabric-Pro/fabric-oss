/**
 * The review dialog's image writes: each one calls its procedure, refetches
 * the pending list on success, and turns a refusal into the right toast. A
 * CONFLICT (the send left review) refetches and closes the dialog.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";

const { client, toastMock, prepareMock } = vi.hoisted(() => ({
	client: {
		createUploadUrl: vi.fn(),
		add: vi.fn(),
		replace: vi.fn(),
		update: vi.fn(),
		includeAll: vi.fn(),
		remove: vi.fn(),
		regenerate: vi.fn(),
		capture: vi.fn(),
	},
	toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
	prepareMock: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { newsletter: { sends: { images: client } } },
}));

// Canvas decoding does not exist in jsdom; the shrink step has no logic the
// dialog owns, so it is replaced by its result.
vi.mock("../../lib/newsletter-image-prepare", () => ({
	prepareNewsletterImage: (file: File) => prepareMock(file),
}));

import { reviewFocusFallback } from "../../lib/newsletter-review-focus";
import { NewsletterReviewDialog } from "../NewsletterReviewDialog";

type DialogProps = ComponentProps<typeof NewsletterReviewDialog>;
type Send = NonNullable<DialogProps["send"]>;
type Image = Send["images"][number];

class OrpcError extends Error {
	code: string;
	data: unknown;
	constructor(code: string, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

function image(over: Partial<Image> = {}): Image {
	return {
		id: "img-1",
		highlightIndex: 0,
		position: 0,
		captureState: "READY",
		included: true,
		source: "UPLOAD",
		altText: "Search results page",
		placement: "BELOW",
		width: 1200,
		height: 680,
		bytes: 120_000,
		prompt: null,
		errorMessage: null,
		createdAt: new Date("2026-11-10T09:00:00.000Z"),
		updatedAt: new Date("2026-11-10T09:00:00.000Z"),
		url: "https://storage.example.com/signed/img-1.png",
		downloadUrl: "https://storage.example.com/signed/img-1.png?download",
		...over,
	};
}

function send(images: Image[]): Send {
	return {
		id: "send-1",
		status: "PENDING_APPROVAL",
		createdAt: new Date("2026-11-10T09:00:00.000Z"),
		timeWindowStart: new Date("2026-11-03T09:00:00.000Z"),
		timeWindowEnd: new Date("2026-11-10T09:00:00.000Z"),
		deliveryDestination: "EMAIL",
		screenshotsEnabled: true,
		screenshotEnvironmentId: null,
		content: {
			headline: "This week's release notes",
			intro: "Two changes shipped.",
			highlights: [
				{ title: "Faster search", description: "Twice as fast." },
				{ title: "New dashboard", description: "A new overview." },
			],
		},
		images,
	};
}

function renderDialog(over: Partial<DialogProps> = {}) {
	const props: DialogProps = {
		send: send([image()]),
		projectId: "p-1",
		organizationId: null,
		removed: new Set<number>(),
		order: [0, 1],
		reviewInFlight: false,
		onToggle: vi.fn(),
		onOrderChange: vi.fn(),
		onApprove: vi.fn(),
		onReject: vi.fn(),
		onRefetch: vi.fn(),
		onOpenChange: vi.fn(),
		...over,
	};
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<NewsletterReviewDialog {...props} />
		</QueryClientProvider>,
	);
	return { props, dialog: screen.getByRole("dialog") };
}

function sendWithTags(tags: Array<string | undefined>): Send {
	const base = send([]);
	return {
		...base,
		content: {
			headline: "This week's release notes",
			intro: "Changes shipped.",
			highlights: tags.map((tag, i) =>
				tag
					? {
							title: `Highlight ${i}`,
							description: "Details.",
							releaseTag: tag,
						}
					: { title: `Highlight ${i}`, description: "Details." },
			),
		},
	};
}

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
	vi.clearAllMocks();
	client.update.mockResolvedValue({ image: image() });
	client.remove.mockResolvedValue({ imageId: "img-1", removed: true });
	client.createUploadUrl.mockResolvedValue({
		signedUploadUrl: "https://storage.example.com/put",
		uploadToken: "token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	});
	client.add.mockResolvedValue({ image: image({ id: "img-2" }) });
	prepareMock.mockImplementation(async (file: File) => ({
		ok: true,
		file,
		contentType: "image/png",
		width: 1200,
		height: 600,
	}));
	fetchSpy = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(new Response(null, { status: 200 }));
});

afterEach(() => {
	fetchSpy.mockRestore();
});

describe("NewsletterReviewDialog — the approve button says what will go out", () => {
	it.each([
		{ images: [], label: "Approve & send as text" },
		{ images: [image()], label: "Approve & send with 1 image" },
		{
			images: [image(), image({ id: "img-2", highlightIndex: 1 })],
			label: "Approve & send with 2 images",
		},
		{
			images: [image({ included: false })],
			label: "Approve & send as text",
		},
	])("$label", ({ images, label }) => {
		const { dialog, props } = renderDialog({ send: send(images) });

		fireEvent.click(within(dialog).getByRole("button", { name: label }));

		expect(props.onApprove).toHaveBeenCalledTimes(1);
	});

	it("disables approve and reject while a decision is in flight", () => {
		const { dialog } = renderDialog({ reviewInFlight: true });

		expect(
			within(dialog).getByRole("button", {
				name: "Approve & send with 1 image",
			}),
		).toBeDisabled();
		expect(
			within(dialog).getByRole("button", { name: "Reject" }),
		).toBeDisabled();
	});

	it("omits the image count when there are no images", () => {
		const { dialog } = renderDialog({ send: send([]) });

		expect(within(dialog).queryByText(/images? included/)).toBeNull();
	});
});

describe("NewsletterReviewDialog — shows the order the email will use", () => {
	it("groups by release, newest first, whatever the reviewer's order", () => {
		const { dialog } = renderDialog({
			send: sendWithTags(["v1.0.0", "v1.1.0"]),
			order: [0, 1],
		});

		const text = dialog.textContent ?? "";
		expect(text.indexOf("v1.1.0")).toBeLessThan(text.indexOf("v1.0.0"));
		expect(text.indexOf("Highlight 1")).toBeLessThan(
			text.indexOf("Highlight 0"),
		);
	});

	it("shows no grip and no drag hint when every release has one highlight", () => {
		const { dialog } = renderDialog({
			send: sendWithTags(["v1.0.0", "v1.1.0"]),
			order: [0, 1],
		});

		expect(
			within(dialog).queryByRole("button", { name: /^Reorder / }),
		).toBeNull();
		expect(
			within(dialog).getByText("Tick what should go out."),
		).toBeInTheDocument();
	});

	it("offers reordering within a release that has several highlights", () => {
		const { dialog } = renderDialog({
			send: sendWithTags(["v1.0.0", "v1.0.0", "v1.1.0"]),
			order: [0, 1, 2],
		});

		expect(
			within(dialog).getByRole("button", { name: "Reorder Highlight 0" }),
		).toBeInTheDocument();
		expect(
			within(dialog).getByRole("button", { name: "Reorder Highlight 1" }),
		).toBeInTheDocument();
		expect(
			within(dialog).queryByRole("button", {
				name: "Reorder Highlight 2",
			}),
		).toBeNull();
		expect(
			within(dialog).getByText(
				"Tick what should go out. Drag to change the order within a release.",
			),
		).toBeInTheDocument();
	});

	it("labels an untagged group only when there are other groups", () => {
		const { dialog } = renderDialog({
			send: sendWithTags(["v1.0.0", undefined]),
			order: [0, 1],
		});

		expect(within(dialog).getByText("Other changes")).toBeInTheDocument();
	});

	it("gives a lone untagged group no heading", () => {
		const { dialog } = renderDialog({
			send: sendWithTags([undefined, undefined]),
			order: [0, 1],
		});

		expect(within(dialog).queryByText("Other changes")).toBeNull();
	});
});

describe("NewsletterReviewDialog — Escape during a keyboard reorder", () => {
	// dnd-kit's keyboard sensor adds its keydown listener (the one that cancels
	// on Escape) in a timeout after the drag starts, so the pick-up waits a tick.
	async function pickUpFirstHighlight(dialog: HTMLElement) {
		const grip = within(dialog).getByRole("button", {
			name: "Reorder Highlight 0",
		});
		grip.focus();
		fireEvent.keyDown(grip, { key: " ", code: "Space" });
		await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
	}

	function pressEscape() {
		const target = document.activeElement ?? document.body;
		fireEvent.keyDown(target, { key: "Escape", code: "Escape" });
	}

	it("cancels the drag and keeps the review open", async () => {
		const { dialog, props } = renderDialog({
			send: sendWithTags(["v1.0.0", "v1.0.0"]),
			order: [0, 1],
		});
		await pickUpFirstHighlight(dialog);

		pressEscape();

		expect(props.onOpenChange).not.toHaveBeenCalled();
		expect(props.onOrderChange).not.toHaveBeenCalled();
	});

	it("closes the review on the next Escape, once no drag is active", async () => {
		const { dialog, props } = renderDialog({
			send: sendWithTags(["v1.0.0", "v1.0.0"]),
			order: [0, 1],
		});
		await pickUpFirstHighlight(dialog);
		pressEscape();

		pressEscape();

		expect(props.onOpenChange).toHaveBeenCalledWith(false);
	});

	it("fades the dragged row in the list until the drag ends", async () => {
		const { dialog } = renderDialog({
			send: sendWithTags(["v1.0.0", "v1.0.0"]),
			order: [0, 1],
		});
		const grip = within(dialog).getByRole("button", {
			name: "Reorder Highlight 0",
		});
		const row = () => grip.closest("li");

		await pickUpFirstHighlight(dialog);
		const fadedWhileDragging = row()?.classList.contains("opacity-40");
		pressEscape();
		await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

		expect(fadedWhileDragging).toBe(true);
		expect(row()?.classList.contains("opacity-40")).toBe(false);
	});

	it("closes the review on Escape when nothing is being dragged", () => {
		const { props } = renderDialog();

		pressEscape();

		expect(props.onOpenChange).toHaveBeenCalledWith(false);
	});
});

describe("NewsletterReviewDialog — focus after the image dialog", () => {
	// The close-time handler hands the rows to `reviewFocusFallback` (tested
	// on its own in lib). This only checks the rows carry the markers it
	// reads, without opening the image dialog or relying on focus timing.
	it("marks each highlight's Add image button as its focus fallback", () => {
		const { dialog } = renderDialog();
		const [firstAdd, secondAdd] = within(dialog).getAllByRole("button", {
			name: "Add image",
		});

		expect(reviewFocusFallback(dialog, 0)).toBe(firstAdd);
		expect(reviewFocusFallback(dialog, 1)).toBe(secondAdd);
	});
});

describe("NewsletterReviewDialog — image writes", () => {
	it("unticking Include in email updates the image and refetches", async () => {
		const { dialog, props } = renderDialog();

		fireEvent.click(
			within(dialog).getByRole("checkbox", { name: "Include in email" }),
		);

		await waitFor(() =>
			expect(client.update).toHaveBeenCalledWith({
				projectId: "p-1",
				organizationId: null,
				imageId: "img-1",
				included: false,
			}),
		);
		await waitFor(() => expect(props.onRefetch).toHaveBeenCalled());
	});

	it("uploads a picked file to the highlight and records its size", async () => {
		const { dialog } = renderDialog({ send: send([]) });
		expect(
			within(dialog).getAllByRole("button", { name: "Add image" }),
		).toHaveLength(2);
		const inputs =
			document.querySelectorAll<HTMLInputElement>('input[type="file"]');
		const file = new File([new Uint8Array(8)], "shot.png", {
			type: "image/png",
		});

		fireEvent.change(inputs[1], { target: { files: [file] } });

		await waitFor(() =>
			expect(client.add).toHaveBeenCalledWith({
				projectId: "p-1",
				organizationId: null,
				sendId: "send-1",
				highlightIndex: 1,
				uploadToken: "token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				width: 1200,
				height: 600,
			}),
		);
		expect(client.createUploadUrl).toHaveBeenCalledWith({
			projectId: "p-1",
			organizationId: null,
			sendId: "send-1",
			contentType: "image/png",
			contentLength: file.size,
		});
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://storage.example.com/put",
			expect.objectContaining({
				method: "PUT",
				headers: { "Content-Type": "image/png" },
			}),
		);
	});

	it("refuses a file the browser could not fit without calling the server", async () => {
		prepareMock.mockResolvedValue({ ok: false, code: "too_large" });
		renderDialog({ send: send([]) });
		const inputs =
			document.querySelectorAll<HTMLInputElement>('input[type="file"]');
		const file = new File([new Uint8Array(8)], "huge.png", {
			type: "image/png",
		});

		fireEvent.change(inputs[0], { target: { files: [file] } });

		await waitFor(() =>
			expect(toastMock.error).toHaveBeenCalledWith(
				"That image is too large even after shrinking. Try a smaller one.",
			),
		);
		expect(client.createUploadUrl).not.toHaveBeenCalled();
	});

	it.each([
		{
			code: "too_large",
			message:
				"That image is too large even after shrinking. Try a smaller one.",
		},
		{ code: "unsupported", message: "Use a PNG or JPEG image." },
		{
			code: "highlight_full",
			message: "This highlight already has two images.",
		},
		{ code: undefined, message: "Could not save the image. Try again." },
	])(
		"a $code refusal shows its toast and keeps the dialog open",
		async ({ code, message }) => {
			client.update.mockRejectedValue(
				new OrpcError(
					"BAD_REQUEST",
					"server copy",
					code ? { code } : undefined,
				),
			);
			const { dialog, props } = renderDialog();

			fireEvent.click(
				within(dialog).getByRole("checkbox", {
					name: "Include in email",
				}),
			);

			await waitFor(() =>
				expect(toastMock.error).toHaveBeenCalledWith(message),
			);
			expect(props.onOpenChange).not.toHaveBeenCalled();
			expect(props.onRefetch).not.toHaveBeenCalled();
		},
	);

	it("a CONFLICT reports the send left review, refetches and closes", async () => {
		const notice =
			"This newsletter is no longer awaiting review, so its images can no longer be changed.";
		client.update.mockRejectedValue(new OrpcError("CONFLICT", notice));
		const { dialog, props } = renderDialog();

		fireEvent.click(
			within(dialog).getByRole("checkbox", { name: "Include in email" }),
		);

		await waitFor(() =>
			expect(toastMock.info).toHaveBeenCalledWith(notice),
		);
		expect(props.onRefetch).toHaveBeenCalled();
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
	});

	it("removing an image from the image dialog confirms it", async () => {
		const { dialog } = renderDialog();
		fireEvent.click(
			within(dialog).getByRole("button", {
				name: "Open image: Search results page",
			}),
		);
		const imageDialog = screen.getByRole("dialog", { name: "Image" });

		fireEvent.click(
			within(imageDialog).getByRole("button", { name: "Remove" }),
		);

		await waitFor(() =>
			expect(client.remove).toHaveBeenCalledWith({
				projectId: "p-1",
				organizationId: null,
				imageId: "img-1",
			}),
		);
		await waitFor(() =>
			expect(toastMock.success).toHaveBeenCalledWith("Image removed"),
		);
	});

	it("downloads the image through its save-as URL, in place", () => {
		const { dialog } = renderDialog();
		fireEvent.click(
			within(dialog).getByRole("button", {
				name: "Open image: Search results page",
			}),
		);
		const imageDialog = screen.getByRole("dialog", { name: "Image" });

		const link = within(imageDialog).getByRole("link", {
			name: "Download",
		});

		expect(link).toHaveAttribute(
			"href",
			"https://storage.example.com/signed/img-1.png?download",
		);
		expect(link).not.toHaveAttribute("target");
	});

	it("moves an image later within its highlight", async () => {
		const { dialog } = renderDialog({
			send: send([
				image(),
				image({ id: "img-2", position: 1, altText: "Second" }),
			]),
		});
		fireEvent.click(
			within(dialog).getByRole("button", {
				name: "Open image: Search results page",
			}),
		);
		const imageDialog = screen.getByRole("dialog", { name: "Image" });

		expect(
			within(imageDialog).getByRole("button", { name: "Move earlier" }),
		).toBeDisabled();
		fireEvent.click(
			within(imageDialog).getByRole("button", { name: "Move later" }),
		);

		await waitFor(() =>
			expect(client.update).toHaveBeenCalledWith({
				projectId: "p-1",
				organizationId: null,
				imageId: "img-1",
				position: 1,
			}),
		);
	});

	it("shows an image above the text from the image dialog", async () => {
		const { dialog } = renderDialog();
		fireEvent.click(
			within(dialog).getByRole("button", {
				name: "Open image: Search results page",
			}),
		);
		const imageDialog = screen.getByRole("dialog", { name: "Image" });

		expect(
			within(imageDialog).getByRole("radio", {
				name: "Show below the text",
			}),
		).toBeChecked();
		fireEvent.click(
			within(imageDialog).getByRole("radio", {
				name: "Show above the text",
			}),
		);

		await waitFor(() =>
			expect(client.update).toHaveBeenCalledWith({
				projectId: "p-1",
				organizationId: null,
				imageId: "img-1",
				placement: "ABOVE",
			}),
		);
	});

	it("refetches once when a signed image URL has expired", () => {
		const { dialog, props } = renderDialog({
			send: send([image(), image({ id: "img-2", highlightIndex: 1 })]),
		});
		const pictures = dialog.querySelectorAll("img");

		fireEvent.error(pictures[0]);
		fireEvent.error(pictures[1]);

		expect(props.onRefetch).toHaveBeenCalledTimes(1);
	});
});

describe("NewsletterReviewDialog — Include all", () => {
	it("includes every ready image of the kept highlights in one call", async () => {
		client.includeAll.mockResolvedValue({ images: [] });
		const { dialog, props } = renderDialog({
			send: send([
				image({ included: false }),
				image({ id: "img-2", highlightIndex: 1, included: false }),
			]),
			removed: new Set([1]),
		});

		fireEvent.click(
			within(dialog).getByRole("button", { name: "Include all images" }),
		);

		await waitFor(() =>
			expect(client.includeAll).toHaveBeenCalledWith({
				projectId: "p-1",
				organizationId: null,
				sendId: "send-1",
				removedHighlightIndexes: [1],
			}),
		);
		expect(client.update).not.toHaveBeenCalled();
		await waitFor(() => expect(props.onRefetch).toHaveBeenCalled());
	});

	it.each([
		{ name: "every image is included", images: [image()] },
		{
			name: "the only excluded image is still being captured",
			images: [
				image({
					included: false,
					captureState: "CAPTURING",
					source: "AI",
				}),
			],
		},
		{
			name: "the only excluded image is under a left-out highlight",
			images: [image({ highlightIndex: 1, included: false })],
		},
	])("is disabled when $name", ({ images }) => {
		const { dialog } = renderDialog({
			send: send(images),
			removed: new Set([1]),
		});

		expect(
			within(dialog).getByRole("button", { name: "Include all images" }),
		).toBeDisabled();
	});

	it("is not offered for a send without images", () => {
		const { dialog } = renderDialog({ send: send([]) });

		expect(
			within(dialog).queryByRole("button", {
				name: "Include all images",
			}),
		).toBeNull();
	});
});

describe("NewsletterReviewDialog — captured screenshots", () => {
	const withEnvironment = (images: Image[]): Send => ({
		...send(images),
		screenshotEnvironmentId: "env-1",
	});

	it("shows a slot being captured instead of an include choice", () => {
		const { dialog } = renderDialog({
			send: withEnvironment([
				image({
					source: "PROMPT",
					captureState: "CAPTURING",
					url: null,
					downloadUrl: null,
				}),
			]),
		});

		expect(
			within(dialog).getByText("Capturing screenshot…"),
		).toBeInTheDocument();
		expect(
			within(dialog).getByRole("checkbox", { name: "Include in email" }),
		).toBeDisabled();
	});

	it("holds the approval until every screenshot has landed", () => {
		const { dialog, props } = renderDialog({
			send: withEnvironment([
				image(),
				image({
					id: "img-2",
					highlightIndex: 1,
					source: "AI",
					captureState: "CAPTURING",
					included: true,
					url: null,
					downloadUrl: null,
				}),
			]),
		});

		const approveButton = within(dialog).getByRole("button", {
			name: "Approve & send with 1 image",
		});
		expect(approveButton).toBeDisabled();
		fireEvent.click(approveButton);
		expect(props.onApprove).not.toHaveBeenCalled();
		expect(
			within(dialog).getByText(
				"Wait for the screenshots that are still being captured.",
			),
		).toBeInTheDocument();
		expect(
			within(dialog).getByRole("button", { name: "Reject" }),
		).toBeEnabled();
		const [ready, capturing] = within(dialog).getAllByRole("checkbox", {
			name: "Include in email",
		});
		expect(ready).toBeChecked();
		expect(capturing).not.toBeChecked();
		expect(capturing).toBeDisabled();
	});

	it("shows a failed slot with its reason in one line", () => {
		const { dialog } = renderDialog({
			send: withEnvironment([
				image({
					source: "AI",
					captureState: "FAILED",
					included: false,
					url: null,
					downloadUrl: null,
					errorMessage: "Sign-in failed: no password field.",
				}),
			]),
		});

		expect(
			within(dialog).getByText("Sign-in failed: no password field."),
		).toBeInTheDocument();
		expect(
			within(dialog).queryByRole("checkbox", {
				name: "Include in email",
			}),
		).toBeNull();
	});

	it("offers Capture screenshot only when the send has an environment", () => {
		const { dialog } = renderDialog({ send: send([]) });

		expect(
			within(dialog).queryByRole("button", {
				name: "Capture screenshot",
			}),
		).toBeNull();
	});

	it("captures a screenshot from the reviewer's description", async () => {
		client.capture.mockResolvedValue({ image: image({ id: "img-9" }) });
		const { dialog, props } = renderDialog({ send: withEnvironment([]) });

		fireEvent.click(
			within(dialog).getAllByRole("button", {
				name: "Capture screenshot",
			})[1],
		);
		fireEvent.change(
			within(dialog).getByRole("textbox", {
				name: "What should the screenshot for New dashboard show?",
			}),
			{ target: { value: "The new overview page." } },
		);
		fireEvent.click(
			within(dialog).getByRole("button", { name: "Capture" }),
		);

		await waitFor(() =>
			expect(client.capture).toHaveBeenCalledWith({
				projectId: "p-1",
				organizationId: null,
				sendId: "send-1",
				highlightIndex: 1,
				prompt: "The new overview page.",
			}),
		);
		await waitFor(() => expect(props.onRefetch).toHaveBeenCalled());
	});

	it("captures a captured image again with new words", async () => {
		client.regenerate.mockResolvedValue({ image: image() });
		const { dialog } = renderDialog({
			send: withEnvironment([
				image({ source: "AI", prompt: "The filters panel." }),
			]),
		});
		fireEvent.click(
			within(dialog).getByRole("button", {
				name: "Open image: Search results page",
			}),
		);
		const imageDialog = screen.getByRole("dialog", { name: "Image" });

		fireEvent.change(
			within(imageDialog).getByRole("textbox", {
				name: "Not the right screen?",
			}),
			{ target: { value: "The filters panel with a saved filter." } },
		);
		fireEvent.click(
			within(imageDialog).getByRole("button", { name: "Capture again" }),
		);

		await waitFor(() =>
			expect(client.regenerate).toHaveBeenCalledWith({
				projectId: "p-1",
				organizationId: null,
				imageId: "img-1",
				prompt: "The filters panel with a saved filter.",
			}),
		);
	});

	it("renders each field of a captured image's dialog once", () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const { dialog } = renderDialog({
			send: withEnvironment([
				image({ source: "AI", prompt: "The filters panel." }),
			]),
		});
		fireEvent.click(
			within(dialog).getByRole("button", {
				name: "Open image: Search results page",
			}),
		);
		const imageDialog = screen.getByRole("dialog", { name: "Image" });
		fireEvent.click(
			within(imageDialog).getByRole("radio", {
				name: "Show above the text",
			}),
		);

		expect(
			within(imageDialog).getAllByRole("textbox", {
				name: "Description",
			}),
		).toHaveLength(1);
		expect(
			consoleError.mock.calls.some((call) =>
				String(call[0]).includes("same key"),
			),
		).toBe(false);
		consoleError.mockRestore();
	});

	it("does not offer Capture again for an uploaded image", () => {
		const { dialog } = renderDialog({ send: withEnvironment([image()]) });
		fireEvent.click(
			within(dialog).getByRole("button", {
				name: "Open image: Search results page",
			}),
		);
		const imageDialog = screen.getByRole("dialog", { name: "Image" });

		expect(
			within(imageDialog).queryByRole("button", {
				name: "Capture again",
			}),
		).toBeNull();
	});

	it("keeps the panel open when a capture is already running", async () => {
		client.regenerate.mockRejectedValue(
			new OrpcError("CONFLICT", "server copy", {
				code: "capture_in_progress",
			}),
		);
		const { dialog, props } = renderDialog({
			send: withEnvironment([image({ source: "AI" })]),
		});
		fireEvent.click(
			within(dialog).getByRole("button", {
				name: "Open image: Search results page",
			}),
		);
		fireEvent.click(
			within(screen.getByRole("dialog", { name: "Image" })).getByRole(
				"button",
				{ name: "Capture again" },
			),
		);

		await waitFor(() =>
			expect(toastMock.error).toHaveBeenCalledWith(
				"This screenshot is already being captured.",
			),
		);
		expect(props.onOpenChange).not.toHaveBeenCalled();
	});
});
