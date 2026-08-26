import { logger } from "@repo/logs";
import type { SendEmailHandler } from "../../types";

export const send: SendEmailHandler = async ({
	to,
	subject,
	text,
	headers,
}) => {
	let formattedOutput = `Sending email to ${to} with subject ${subject}\n\n`;

	formattedOutput += `Text: ${text}\n\n`;

	if (headers && Object.keys(headers).length > 0) {
		formattedOutput += `Headers: ${JSON.stringify(headers, null, 2)}\n\n`;
	}

	logger.log(formattedOutput);
};
