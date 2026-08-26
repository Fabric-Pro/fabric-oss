import { config } from "@repo/config";
import { withProviderBreaker } from "@repo/observability";
import { Resend } from "resend";
import type { SendEmailHandler } from "../../types";

// Lazy initialization to ensure env vars are loaded
let resendClient: Resend | null = null;

function getResendClient(): Resend {
	if (!resendClient) {
		const apiKey = process.env.RESEND_API_KEY;
		if (!apiKey) {
			throw new Error(
				"RESEND_API_KEY environment variable is not set. Please add it to your .env.local file.",
			);
		}
		resendClient = new Resend(apiKey);
	}
	return resendClient;
}

const { from } = config.mails;

export const send: SendEmailHandler = async ({
	to,
	subject,
	html,
	text,
	headers,
	idempotencyKey,
	attachments,
}) => {
	const client = getResendClient();
	await withProviderBreaker("resend", "email_send", async () => {
		const result = await client.emails.send(
			{
				from,
				to: [to],
				subject,
				html,
				text,
				...(headers && Object.keys(headers).length > 0
					? { headers }
					: {}),
				...(attachments && attachments.length > 0
					? {
							attachments: attachments.map((a) => ({
								filename: a.filename,
								content:
									typeof a.content === "string"
										? Buffer.from(a.content, "utf-8")
										: a.content,
								...(a.contentType
									? { contentType: a.contentType }
									: {}),
							})),
						}
					: {}),
			},
			idempotencyKey ? { idempotencyKey } : undefined,
		);

		// resend@6 types a send as ({ data, error: null } | { error, data: null })
		// and RESOLVES on an API failure rather than throwing. Discarding this
		// value let `sendEmail` fall through to `return true` for every provider
		// rejection — invalid recipient, rate limit, revoked key, 5xx — so the
		// callers that branch on that boolean could never observe a failure:
		// `markDelivery` recorded SENT for mail the provider had refused.
		//
		// The check lives INSIDE the breaker callback deliberately. The breaker
		// labels whatever the callback resolves as `outcome: "success"`, so a
		// check placed after this call would leave the circuit closed and the
		// provider error metric flat straight through an outage.
		if (result.error) {
			throw new Error(
				`Resend rejected the message (${result.error.name}): ${result.error.message}`,
			);
		}
		return result;
	});
};
