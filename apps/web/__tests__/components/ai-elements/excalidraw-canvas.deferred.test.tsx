import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "../../../components/ai-elements/ExcalidrawCanvas";

interface WidgetProps {
	excalidrawAPI: (api: ExcalidrawImperativeAPI) => void;
	initialData: {
		elements: Record<string, unknown>[];
		appState: Record<string, unknown>;
		scrollToContent: boolean;
	};
	onChange?: (elements: readonly Record<string, unknown>[]) => void;
	theme: string;
	viewModeEnabled: boolean;
}

const mocks = vi.hoisted(() => ({
	stylesLoaded: vi.fn(),
	widgetRendered: vi.fn<(props: WidgetProps) => void>(),
	api: {
		getSceneElements: vi.fn(() => []),
		getAppState: vi.fn(() => ({})),
		updateScene: vi.fn(),
		scrollToContent: vi.fn(),
	},
}));

vi.mock("@excalidraw/excalidraw/index.css", () => {
	mocks.stylesLoaded();
	return {};
});

vi.mock("@excalidraw/excalidraw", () => ({
	Excalidraw: (props: WidgetProps) => {
		mocks.widgetRendered(props);
		useEffect(() => props.excalidrawAPI(mocks.api), [props.excalidrawAPI]);
		return <div data-testid="diagram-widget" />;
	},
}));

describe("ExcalidrawCanvas loading", () => {
	it("keeps styles out of SSR, then loads them before the widget with its data and callbacks", async () => {
		const { ExcalidrawCanvas } = await import(
			"../../../components/ai-elements/ExcalidrawCanvas"
		);
		const elements = [
			{
				id: "example-label",
				type: "text",
				containerId: null,
				text: "Example diagram",
			},
		];
		const onApi = vi.fn();
		const onChange = vi.fn();
		const view = (
			<ExcalidrawCanvas
				elements={elements}
				appState={{ gridSize: 20 }}
				theme="dark"
				viewModeEnabled
				onApi={onApi}
				onChange={onChange}
			/>
		);

		expect(mocks.stylesLoaded).not.toHaveBeenCalled();
		expect(renderToString(view)).toContain("Loading diagram");
		expect(mocks.stylesLoaded).not.toHaveBeenCalled();
		expect(mocks.widgetRendered).not.toHaveBeenCalled();

		const mounted = render(view);
		await screen.findByTestId("diagram-widget");
		expect(mocks.stylesLoaded).toHaveBeenCalledOnce();
		expect(mocks.stylesLoaded.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.widgetRendered.mock.invocationCallOrder[0],
		);
		const props = mocks.widgetRendered.mock.lastCall?.[0];
		expect(props?.initialData).toEqual({
			elements: [{ ...elements[0], boundElements: [], groupIds: [] }],
			appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
			scrollToContent: true,
		});
		expect(props?.theme).toBe("dark");
		expect(props?.viewModeEnabled).toBe(true);
		await waitFor(() => expect(onApi).toHaveBeenCalledWith(mocks.api));
		act(() =>
			props?.onChange?.([
				...elements,
				{ id: "example-deleted", type: "rectangle", isDeleted: true },
			]),
		);
		expect(onChange).toHaveBeenCalledWith(elements);
		mounted.unmount();
	});
});
