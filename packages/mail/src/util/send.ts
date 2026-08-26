import { config } from "@repo/config";
import { logger } from "@repo/logs";
import {
	generateCorrelationId,
	getCorrelationIdFromContext,
} from "@repo/utils/correlation-id";
import type { mailTemplates } from "../../emails";
import type { MailAttachment } from "../../types";
import { send } from "../provider";
import type { TemplateId } from "./templates";
import { getTemplate } from "./templates";

/** Header name for correlation ID */
const CORRELATION_ID_HEADER = "X-Correlation-ID";

/** Whether the mail provider is configured (RESEND_API_KEY present). Used by
 *  callers that want to fail BEFORE taking a durable claim, so a config outage
 *  retries cleanly instead of dropping the message. */
export function isMailConfigured(): boolean {
	return Boolean(process.env.RESEND_API_KEY);
}

/**
 * Resolve the correlation ID using a three-tier priority:
 * 1. Explicit caller-provided header
 * 2. AsyncLocalStorage context (set by Hono middleware)
 * 3. Freshly generated fallback
 */
function resolveCorrelationId(callerHeaders?: Record<string, string>): string {
	if (
		callerHeaders &&
		CORRELATION_ID_HEADER in callerHeaders &&
		callerHeaders[CORRELATION_ID_HEADER]
	) {
		return callerHeaders[CORRELATION_ID_HEADER];
	}
	return getCorrelationIdFromContext() ?? generateCorrelationId();
}

export async function sendEmail<T extends TemplateId>(
	params: {
		to: string;
		locale?: keyof typeof config.i18n.locales;
	} & (
		| {
				templateId: T;
				context: Omit<
					Parameters<(typeof mailTemplates)[T]>[0],
					"locale" | "translations"
				>;
				idempotencyKey?: string;
		  }
		| {
				subject: string;
				text?: string;
				html?: string;
				headers?: Record<string, string>;
				idempotencyKey?: string;
				attachments?: MailAttachment[];
		  }
	),
): Promise<boolean> {
	const { to, locale = config.i18n.defaultLocale } = params;

	// Extract caller-provided headers (only available in raw mode)
	const callerHeaders = "headers" in params ? params.headers : undefined;

	// Extract attachments (only available in raw mode)
	const attachments =
		"attachments" in params ? params.attachments : undefined;

	// Extract idempotency key (available on both branches) for provider-side dedup
	const idempotencyKey =
		"idempotencyKey" in params ? params.idempotencyKey : undefined;

	// Resolve correlation ID
	const correlationId = resolveCorrelationId(callerHeaders);

	// Merge headers: caller headers + correlation ID (caller's explicit value takes priority)
	const headers: Record<string, string> = {
		[CORRELATION_ID_HEADER]: correlationId,
		...callerHeaders,
	};

	// Declared outside the try so the catch block can still log it when
	// template rendering throws before a subject is resolved.
	let subject = "";

	try {
		let html: string;
		let text: string;

		// Template resolution is inside the try: a render failure
		// (`@react-email/render`, i18n bundle load, component error) must
		// degrade to `return false`, not throw — callers treat email as a
		// non-critical side effect and must not fail their request over it.
		if ("templateId" in params) {
			const { templateId, context } = params;
			const template = await getTemplate({
				templateId,
				context,
				locale,
			});
			subject = template.subject;
			text = template.text;
			html = template.html;
		} else {
			subject = params.subject;
			text = params.text ?? "";
			html = params.html ?? "";
		}

		await send({
			to,
			subject,
			text,
			html,
			headers,
			...(idempotencyKey ? { idempotencyKey } : {}),
			...(attachments && attachments.length > 0 ? { attachments } : {}),
		});

		logger.info("Email sent successfully", {
			correlationId,
			to,
			subject,
			attachmentCount: attachments?.length ?? 0,
		});

		return true;
	} catch (e) {
		logger.error("Email send failed", {
			correlationId,
			to,
			subject,
			error: e instanceof Error ? e.message : String(e),
			stack: e instanceof Error ? e.stack : undefined,
		});

		return false;
	}
}
