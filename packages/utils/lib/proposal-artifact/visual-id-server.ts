/**
 * Minting a generated visual's marker id (Fizzy #2946). Server only: it
 * draws from `node:crypto`, which the editor bundle of `visual-identity.ts`
 * cannot import.
 */

import { randomInt } from "node:crypto";
import { MINTED_VISUAL_ID_LENGTH, VISUAL_ID_ALPHABET } from "./visual-identity";

/** A new visual id: lowercase letters and digits, from the CSPRNG. */
export function mintVisualId(): string {
	let id = "";
	for (let i = 0; i < MINTED_VISUAL_ID_LENGTH; i++) {
		id += VISUAL_ID_ALPHABET[randomInt(VISUAL_ID_ALPHABET.length)];
	}
	return id;
}
