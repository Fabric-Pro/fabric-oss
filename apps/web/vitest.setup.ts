import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, vi } from "vitest";

// Cleanup after each test
afterEach(() => {
	cleanup();
});

// Mock environment variables
beforeAll(() => {
	vi.stubEnv("NODE_ENV", "test");
});

// Mock Next.js router
vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: vi.fn(),
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
		pathname: "/",
		query: {},
	}),
	usePathname: () => "/",
	useSearchParams: () => new URLSearchParams(),
}));

// Mock next-intl globally — components throughout the SaaS app use
// `useTranslations`, which throws without a `NextIntlClientProvider`
// ancestor. Tests that need to assert on translated strings can override
// this mock locally.
// `t.raw(key)` is part of the real next-intl surface and the tooltip standard
// mandates it for destructive copy (`<DestructiveTooltip copy={t.raw(...)}>`
// reads a `{ label, warning }` object, which `t()` would stringify). A bare
// function mock made every such component throw "t.raw is not a function" on
// render, so the echo needs to carry it too.
const mockTranslator = () => {
	const t = (key: string) => key;
	t.raw = (key: string) => key;
	return t;
};

vi.mock("next-intl", () => ({
	useTranslations: mockTranslator,
	useLocale: () => "en",
	useFormatter: () => ({
		dateTime: (d: Date) => d.toISOString(),
		number: (n: number) => String(n),
		relativeTime: (d: Date) => d.toISOString(),
	}),
	useMessages: () => ({}),
	NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
		children,
}));

// `useDebounceValue` / `useDebounceCallback` (usehooks-ts → lodash.debounce)
// schedule real 500ms trailing-edge timers that usehooks-ts does NOT cancel on
// unmount. A timer scheduled late in a test can therefore fire AFTER the jsdom
// env tears down, running a React setState that reaches `window` (now gone) —
// surfacing as a flaky Vitest "ReferenceError: window is not defined" unhandled
// error (the wizard debounces formData + step, so any wizard test is at risk).
// No test relies on the debounce delay, so make both hooks fire synchronously
// and timer-free here while preserving every other usehooks-ts export.
vi.mock("usehooks-ts", async (importActual) => {
	const actual = await importActual<Record<string, unknown>>();
	const makeDebounced = (fn?: (...args: unknown[]) => unknown) =>
		Object.assign((...args: unknown[]) => fn?.(...args), {
			cancel: () => {},
			flush: () => {},
			isPending: () => false,
		});
	return {
		...actual,
		useDebounceValue: (value: unknown) => [value, makeDebounced()],
		useDebounceCallback: (fn?: (...args: unknown[]) => unknown) =>
			makeDebounced(fn),
	};
});

// Node 25 ships an experimental built-in `globalThis.localStorage` that is a
// stub object missing the Storage methods (`clear`, `setItem`, etc.) when
// run without `--localstorage-file`. JSDOM's Storage gets shadowed and any
// test that calls `localStorage.clear()` blows up with "is not a function".
// Earlier Node versions (incl. CI's Node 20) have no built-in webstorage
// and JSDOM works fine, so this guard runs only when actually needed.
// The `typeof window` guard here and on matchMedia below is for suites that opt
// into `@vitest-environment node` (server route handlers, where jsdom's realm
// breaks jose's Uint8Array checks): there is no DOM to shim.
if (
	typeof window !== "undefined" &&
	typeof window.localStorage?.clear !== "function"
) {
	const makeStorage = (): Storage => {
		const store = new Map<string, string>();
		return {
			get length() {
				return store.size;
			},
			clear: () => store.clear(),
			getItem: (key: string) => store.get(key) ?? null,
			key: (i: number) => [...store.keys()][i] ?? null,
			removeItem: (key: string) => store.delete(key),
			setItem: (key: string, value: string) => {
				store.set(key, String(value));
			},
		};
	};
	Object.defineProperty(window, "localStorage", {
		value: makeStorage(),
		configurable: true,
		writable: true,
	});
	Object.defineProperty(window, "sessionStorage", {
		value: makeStorage(),
		configurable: true,
		writable: true,
	});
}

// Mock window.matchMedia
if (typeof window !== "undefined") {
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		value: vi.fn().mockImplementation((query) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
		})),
	});
}

// JSDOM doesn't ship a `ResizeObserver` implementation, but Radix's
// `react-use-size` (used internally by Tooltip / Popover positioning)
// instantiates one as soon as the floating element mounts. Tests that
// activate Radix tooltips (`focus` / `hover`) crash with
// "ReferenceError: ResizeObserver is not defined" without this stub.
// The mock is no-op since layout isn't asserted in unit tests.
if (typeof globalThis.ResizeObserver === "undefined") {
	class ResizeObserverMock {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	}
	Object.defineProperty(globalThis, "ResizeObserver", {
		value: ResizeObserverMock,
		writable: true,
		configurable: true,
	});
}

// cmdk (used by shadcn Command primitive) calls `Element.scrollIntoView`
// when the popover opens and a selected item should be focused. JSDOM
// stubs the method as `undefined`; without this no-op the audit-log
// actor combobox test crashes with
// `TypeError: scrollIntoView is not a function`.
if (
	typeof Element !== "undefined" &&
	typeof Element.prototype.scrollIntoView !== "function"
) {
	Element.prototype.scrollIntoView = function scrollIntoView() {
		// no-op for jsdom
	};
}

// JSDOM does not implement `DataTransfer`, but tests need to construct one
// to simulate drag-and-drop file drops (e.g. AttachmentsField via
// `fireEvent.drop`) AND `userEvent.paste` constructs one internally and
// calls `setData`/`getData`. Minimal polyfill covers both surfaces:
// `items.add(file)` for the drop path and `setData`/`getData`/`types` for
// the paste path.
if (typeof globalThis.DataTransfer === "undefined") {
	class DataTransferItemListMock {
		private files: File[];
		constructor(files: File[]) {
			this.files = files;
		}
		add(file: File): void {
			this.files.push(file);
		}
		get length(): number {
			return this.files.length;
		}
	}
	class DataTransferMock {
		private _files: File[] = [];
		private _data = new Map<string, string>();
		items: DataTransferItemListMock;
		constructor() {
			this.items = new DataTransferItemListMock(this._files);
		}
		get files(): FileList {
			const files = this._files;
			const list = {
				length: files.length,
				item: (i: number) => files[i] ?? null,
				[Symbol.iterator]: function* () {
					for (const f of files) {
						yield f;
					}
				},
			} as unknown as FileList;
			for (let i = 0; i < files.length; i++) {
				Object.defineProperty(list, i, {
					value: files[i],
					enumerable: true,
				});
			}
			return list;
		}
		get types(): string[] {
			return Array.from(this._data.keys());
		}
		setData(format: string, data: string): void {
			this._data.set(format, data);
		}
		getData(format: string): string {
			return this._data.get(format) ?? "";
		}
		clearData(format?: string): void {
			if (format) {
				this._data.delete(format);
			} else {
				this._data.clear();
			}
		}
	}
	Object.defineProperty(globalThis, "DataTransfer", {
		value: DataTransferMock,
		writable: true,
		configurable: true,
	});
}

// JSDOM's Blob/File do not implement the async `.text()` method (unlike real
// browsers and Node's native Blob/File). `uploadStoryAttachment`'s
// client-side Excalidraw pre-check (attachment-upload-utils.ts, #1942) calls
// `file.text()` before any network call, so without this polyfill every test
// exercising that path fails with "file.text is not a function". File
// extends Blob in JSDOM, so patching Blob.prototype.text covers both.
if (typeof Blob.prototype.text !== "function") {
	Blob.prototype.text = function text(this: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = () => reject(reader.error);
			reader.readAsText(this);
		});
	};
}

// Radix UI primitives (Select, Popover, etc.) use Pointer Capture APIs
// that JSDOM does not implement. Without these no-op stubs, any
// `userEvent.click` on a Radix Select trigger throws
// `TypeError: target.hasPointerCapture is not a function`.
if (typeof Element !== "undefined") {
	if (typeof Element.prototype.hasPointerCapture !== "function") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.setPointerCapture !== "function") {
		Element.prototype.setPointerCapture = () => {
			// no-op for jsdom
		};
	}
	if (typeof Element.prototype.releasePointerCapture !== "function") {
		Element.prototype.releasePointerCapture = () => {
			// no-op for jsdom
		};
	}
}
