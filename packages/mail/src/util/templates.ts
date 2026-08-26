import { render } from "@react-email/render";
import type { Locale, Messages } from "@repo/i18n";
import { getMessagesForLocale } from "@repo/i18n";
import { createTranslator } from "use-intl/core";
import { mailTemplates } from "../../emails";
import type { MailTranslator } from "../../types";

export async function getTemplate<T extends TemplateId>({
	templateId,
	context,
	locale,
}: {
	templateId: T;
	context: Omit<
		Parameters<(typeof mailTemplates)[T]>[0],
		"locale" | "translations"
	>;
	locale: Locale;
}) {
	const template = mailTemplates[templateId];
	const translations = await getMessagesForLocale(locale);

	const email = template({
		...(context as any),
		locale,
		translations,
	});

	// Templates may opt into dynamic subject resolution by exporting a
	// `resolveSubject(ctx, t)` helper — used when the subject embeds
	// runtime values (e.g. `"AI usage at 80% — {limitName}"`). Templates
	// without it keep the legacy behaviour: read the static subject string
	// straight out of the translation bundle.
	const templateBucket =
		translations.mail[templateId as keyof Messages["mail"]];
	let subject = "";
	if (
		"resolveSubject" in template &&
		typeof (template as { resolveSubject?: unknown }).resolveSubject ===
			"function"
	) {
		const t = createTranslator({ locale, messages: translations });
		subject = (
			template as {
				resolveSubject: (
					ctx: Record<string, unknown>,
					t: MailTranslator,
				) => string;
			}
		).resolveSubject(context as Record<string, unknown>, t);
	} else if ("subject" in templateBucket) {
		subject = templateBucket.subject;
	}

	const html = await render(email);
	const text = await render(email, { plainText: true });
	return { html, text, subject };
}

export type TemplateId = keyof typeof mailTemplates;
