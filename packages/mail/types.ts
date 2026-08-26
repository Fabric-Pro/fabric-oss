import type { Locale, Messages } from "@repo/i18n";
import type { createTranslator } from "use-intl/core";

/**
 * A single attachment to include with an outbound email.
 *
 * `content` can be a Buffer (preferred for binary blobs like PDFs) or a
 * string (UTF-8 text — used for MARKDOWN / HTML report artifacts). Providers
 * are responsible for base64-encoding the payload as required by the transport.
 *
 * `contentType` is optional — when omitted, providers fall back to MIME type
 * detection from the filename extension.
 */
export interface MailAttachment {
	filename: string;
	content: Buffer | string;
	contentType?: string;
}

export interface SendEmailParams {
	to: string;
	subject: string;
	text: string;
	html?: string;
	headers?: Record<string, string>;
	idempotencyKey?: string;
	attachments?: MailAttachment[];
}

export type SendEmailHandler = (params: SendEmailParams) => Promise<void>;

/**
 * A translator bound to the real message bundle, so every `t("mail.…")` key is
 * checked against `en.json` when the template compiles.
 *
 * Always prefer this to a bare `ReturnType<typeof createTranslator>`, which is
 * how the AI-usage templates got away with it: `createTranslator` is generic
 * over its `messages` argument, so the un-instantiated form yields a translator
 * whose keys are `string` and accepts anything. Any helper taking a `t` needs
 * this type, or the keys it resolves go unchecked no matter what
 * `BaseMailProps` says.
 */
export type MailTranslator = ReturnType<typeof createTranslator<Messages>>;

export type BaseMailProps = {
	locale: Locale;
	/**
	 * Typed, not `any` — `createTranslator` infers its key union from this
	 * prop, so widening it here silently disables key-checking in every
	 * template at once.
	 */
	translations: Messages;
};
