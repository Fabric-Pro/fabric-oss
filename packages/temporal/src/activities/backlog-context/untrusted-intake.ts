/**
 * Shared delimiters for backlog analysis and meeting extraction. The rules
 * outside the block tell the model to treat its contents as data. The sanitizer
 * neutralises delimiter look-alikes inside the block.
 */
export const UNTRUSTED_INTAKE_BLOCK_START = "<<<UNTRUSTED_INTAKE_TEXT>>>";
export const UNTRUSTED_INTAKE_BLOCK_END = "<<<END_UNTRUSTED_INTAKE_TEXT>>>";

export function sanitizeUntrustedIntake(text: string): string {
	return text.replaceAll("<<<", "< < <").replaceAll(">>>", "> > >");
}
