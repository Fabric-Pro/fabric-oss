/**
 * next-intl mock backed by the real English catalogue so spike tests assert
 * on the strings users see (and prove the keys exist). Use inside a
 * `vi.mock("next-intl", ...)` factory:
 *
 *   vi.mock("next-intl", async () => (await import("./spike-intl-mock")).intlMock());
 */
import en from "@repo/i18n/translations/en.json";

type Catalogue = Record<string, unknown>;

function lookup(path: string): string | undefined {
	let current: unknown = en as Catalogue;
	for (const part of path.split(".")) {
		if (typeof current !== "object" || current === null) {
			return undefined;
		}
		current = (current as Catalogue)[part];
	}
	return typeof current === "string" ? current : undefined;
}

function format(
	template: string,
	values?: Record<string, string | number>,
): string {
	return template.replace(
		/\{(\w+)(?:,\s*plural,\s*([^}]*\}[^}]*)*\})?\}/g,
		(match, name: string) => {
			const value = values?.[name];
			if (value === undefined) {
				return match;
			}
			if (match.includes("plural")) {
				// Minimal ICU plural: pick `one {...}` for 1, else `other {...}`.
				const form = value === 1 ? "one" : "other";
				const inner = match.match(
					new RegExp(`${form}\\s*\\{([^}]*)\\}`),
				);
				return inner
					? inner[1].replace("#", String(value))
					: String(value);
			}
			return String(value);
		},
	);
}

export function translator(namespace?: string) {
	return (key: string, values?: Record<string, string | number>) => {
		const path = namespace ? `${namespace}.${key}` : key;
		const found = lookup(path);
		return found === undefined ? path : format(found, values);
	};
}

export function intlMock() {
	return {
		useTranslations: (namespace?: string) => translator(namespace),
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => en,
		NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
			children,
	};
}
