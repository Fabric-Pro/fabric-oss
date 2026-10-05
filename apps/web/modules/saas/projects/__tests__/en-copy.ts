/**
 * The real `en.json` as a next-intl stand-in for component and hook tests, so
 * what a test asserts is the copy that ships. A missing key throws, which is
 * how a sentence that was never written fails a test instead of rendering as a
 * key name.
 *
 * Used from a hoisted mock factory:
 *
 *   vi.mock("next-intl", async () =>
 *     (await import("../../__tests__/en-copy")).nextIntlMock(),
 *   );
 */
import en from "@repo/i18n/translations/en.json";
import type { ReactNode } from "react";

function resolve(path: string): unknown {
	return path.split(".").reduce<unknown>((node, key) => {
		if (node && typeof node === "object") {
			return (node as Record<string, unknown>)[key];
		}
		return undefined;
	}, en);
}

export function makeT(namespace: string) {
	const t = (key: string, values?: Record<string, unknown>) => {
		const raw = resolve(`${namespace}.${key}`);
		if (typeof raw !== "string") {
			throw new Error(`missing translation: ${namespace}.${key}`);
		}
		// `{count, plural, one {# file} other {# files}}`: the two-form plural
		// the copy uses, where `#` stands for the number as the locale writes
		// it ("2,164").
		let out = raw.replace(
			/\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g,
			(_match, name: string, one: string, other: string) => {
				const count = Number(values?.[name]);
				return (count === 1 ? one : other).replaceAll(
					"#",
					count.toLocaleString("en-US"),
				);
			},
		);
		for (const [name, value] of Object.entries(values ?? {})) {
			out = out.replaceAll(`{${name}}`, String(value));
		}
		return out;
	};
	t.raw = (key: string) => resolve(`${namespace}.${key}`);
	// `<tag>inner</tag>` becomes `tags.tag(inner)`, for the copy that carries
	// markup (`t.rich`).
	t.rich = (
		key: string,
		tags: Record<string, (chunks: string) => ReactNode>,
	): ReactNode[] => {
		const text = t(key);
		const nodes: ReactNode[] = [];
		const pattern = /<(\w+)>(.*?)<\/\1>/g;
		let last = 0;
		for (const match of text.matchAll(pattern)) {
			if (match.index > last) {
				nodes.push(text.slice(last, match.index));
			}
			const render = tags[match[1] as string];
			nodes.push(
				render ? render(match[2] as string) : (match[2] as string),
			);
			last = match.index + match[0].length;
		}
		if (last < text.length) {
			nodes.push(text.slice(last));
		}
		return nodes;
	};
	return t;
}

export function nextIntlMock() {
	return {
		useTranslations: (namespace: string) => makeT(namespace),
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => ({}),
		NextIntlClientProvider: ({ children }: { children: ReactNode }) =>
			children,
	};
}
