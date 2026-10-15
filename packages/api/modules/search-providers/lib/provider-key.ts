import { decryptApiKey, maskApiKey } from "@repo/utils";

/**
 * Mask of a stored search-provider key, always computed from the plaintext
 * (never from the ciphertext, whose first characters would be returned).
 *
 * `plaintext` is the key supplied in this request, when there is one; else the
 * stored ciphertext is decrypted. A key that cannot be decrypted yields `***`.
 */
export function maskStoredApiKey(
	encryptedApiKey: string | null | undefined,
	plaintext?: string,
): string | null {
	if (plaintext) {
		return maskApiKey(plaintext);
	}
	if (!encryptedApiKey) {
		return null;
	}
	try {
		return maskApiKey(decryptApiKey(encryptedApiKey));
	} catch (error) {
		console.error("[Search Providers] Failed to decrypt API key:", error);
		return "***";
	}
}
