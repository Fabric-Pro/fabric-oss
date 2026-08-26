import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const openLauncher = vi.fn();

vi.mock("../../components/FabricAgentLauncher", () => ({
	useFabricAgentLauncher: () => ({
		openLauncher,
		registerAmbientContext: vi.fn(() => () => {}),
		registerDocumentEditor: vi.fn(() => () => {}),
		clearContext: vi.fn(),
		closeLauncher: vi.fn(),
		applyToDocument: null,
		isOpen: false,
		launchContext: null,
	}),
}));

import { useFabricMention } from "../useFabricMention";

function wrapper({ children }: { children: ReactNode }) {
	return <>{children}</>;
}

describe("useFabricMention", () => {
	it("opens the launcher when @fabric stands alone", () => {
		openLauncher.mockClear();
		const { result } = renderHook(
			() =>
				useFabricMention({
					projectId: "project-1",
					projectName: "Acme",
				}),
			{ wrapper },
		);

		act(() => {
			const r = result.current.handleInputChange("@fabric draft a plan");
			expect(r.consumed).toBe(true);
			expect(r.query).toBe("draft a plan");
		});

		expect(openLauncher).toHaveBeenCalledTimes(1);
	});

	it("does not fire on email-like strings", () => {
		openLauncher.mockClear();
		const { result } = renderHook(
			() => useFabricMention({ projectId: "project-1" }),
			{ wrapper },
		);

		act(() => {
			const r = result.current.handleInputChange(
				"contact me at user@fabric.io",
			);
			expect(r.consumed).toBe(false);
		});

		expect(openLauncher).not.toHaveBeenCalled();
	});

	it("matches @fabric followed by sentence punctuation", () => {
		openLauncher.mockClear();
		const { result } = renderHook(
			() => useFabricMention({ projectId: "project-1" }),
			{ wrapper },
		);

		act(() => {
			const r = result.current.handleInputChange(
				"hey @fabric: any ideas?",
			);
			expect(r.consumed).toBe(true);
			expect(r.query).toBe("any ideas?");
		});
	});

	it("ignores @fabric inline inside a longer token", () => {
		openLauncher.mockClear();
		const { result } = renderHook(
			() => useFabricMention({ projectId: "project-1" }),
			{ wrapper },
		);

		act(() => {
			const r = result.current.handleInputChange(
				"look at this@fabricator",
			);
			expect(r.consumed).toBe(false);
		});

		expect(openLauncher).not.toHaveBeenCalled();
	});

	it("treats bare @fabric (no query) as a launcher trigger", () => {
		openLauncher.mockClear();
		const { result } = renderHook(
			() => useFabricMention({ projectId: "project-1" }),
			{ wrapper },
		);

		act(() => {
			const r = result.current.handleInputChange("@fabric");
			expect(r.consumed).toBe(true);
			expect(r.query).toBe("");
		});

		expect(openLauncher).toHaveBeenCalledTimes(1);
	});
});
