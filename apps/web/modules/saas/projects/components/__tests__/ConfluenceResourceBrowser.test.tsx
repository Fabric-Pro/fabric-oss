/**
 * Tests for ConfluenceResourceBrowser confirm loop
 * (confluence-project-context-source spec FR4 / FR5 / Task 2.2).
 *
 * The selector child is mocked so the test can invoke `onConfirm` directly and
 * assert the create loop: N pages → N INTEGRATION rows; a failing fetch → a
 * PENDING empty-content row (no throw), a console.warn, and the batch continues.
 */

import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	createMock,
	fetchContentMock,
	toastSuccessMock,
	toastErrorMock,
	selectorProps,
} = vi.hoisted(() => ({
	createMock: vi.fn(),
	fetchContentMock: vi.fn(),
	toastSuccessMock: vi.fn(),
	toastErrorMock: vi.fn(),
	selectorProps: { current: null as Record<string, unknown> | null },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { contexts: { create: createMock } } },
}));

vi.mock("../../lib/confluence-content-fetcher", () => ({
	fetchConfluencePageContent: fetchContentMock,
}));

vi.mock("sonner", () => ({
	toast: { success: toastSuccessMock, error: toastErrorMock },
}));

vi.mock("../ConfluencePageSelector", () => ({
	ConfluencePageSelector: (props: Record<string, unknown>) => {
		selectorProps.current = props;
		return null;
	},
}));

import { ConfluenceResourceBrowser } from "../ConfluenceResourceBrowser";

const baseProps = {
	open: true,
	onOpenChange: vi.fn(),
	mcpConfigId: "cfg-1",
	projectId: "proj-1",
	organizationId: null,
};

function pages(...ids: string[]) {
	return ids.map((id) => ({
		pageId: id,
		title: `Title ${id}`,
		spaceKey: "ENG",
		url: `https://wiki/${id}`,
		mcpConfigId: "cfg-1",
	}));
}

describe("ConfluenceResourceBrowser", () => {
	beforeEach(() => {
		createMock.mockReset().mockResolvedValue({ id: "ctx" });
		fetchContentMock.mockReset();
		toastSuccessMock.mockReset();
		toastErrorMock.mockReset();
		selectorProps.current = null;
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates one INTEGRATION row per page with provider 'confluence' (AC4.1)", async () => {
		fetchContentMock.mockResolvedValue({
			content: "Body",
			title: "Resolved Title",
			contentFetchFailed: false,
		});

		render(<ConfluenceResourceBrowser {...baseProps} />);

		await act(async () => {
			(selectorProps.current?.onConfirm as (p: unknown) => void)(
				pages("p1", "p2"),
			);
		});

		await waitFor(() => expect(createMock).toHaveBeenCalledTimes(2));

		const firstArg = createMock.mock.calls[0][0];
		expect(firstArg.type).toBe("INTEGRATION");
		expect(firstArg.metadata.provider).toBe("confluence");
		expect(firstArg.metadata.confluencePageId).toBe("p1");
		expect(firstArg.content).toBe("Body");
		expect(toastSuccessMock).toHaveBeenCalledWith(
			"Added 2 page(s) to project",
		);
	});

	it("creates a PENDING empty-content row for a failed fetch, warns, and continues (AC5.1/AC5.2)", async () => {
		fetchContentMock
			.mockResolvedValueOnce({
				content: "",
				title: "Title p1",
				contentFetchFailed: true,
			})
			.mockResolvedValueOnce({
				content: "Good body",
				title: "Title p2",
				contentFetchFailed: false,
			});

		render(<ConfluenceResourceBrowser {...baseProps} />);

		await act(async () => {
			(selectorProps.current?.onConfirm as (p: unknown) => void)(
				pages("p1", "p2"),
			);
		});

		// Both pages still produce a create call (the failed one is empty/PENDING).
		await waitFor(() => expect(createMock).toHaveBeenCalledTimes(2));
		expect(createMock.mock.calls[0][0].content).toBe("");
		expect(createMock.mock.calls[1][0].content).toBe("Good body");
		expect(console.warn).toHaveBeenCalled();
		expect(toastErrorMock).not.toHaveBeenCalled();
		expect(toastSuccessMock).toHaveBeenCalledWith(
			"Added 2 page(s) to project",
		);
	});

	it("passes syncedPageIds through to the selector", () => {
		render(
			<ConfluenceResourceBrowser
				{...baseProps}
				syncedPageIds={["already-1"]}
			/>,
		);
		expect(selectorProps.current?.syncedPageIds).toEqual(["already-1"]);
	});
});
