/**
 * Feature keys whose replies are spoken aloud while a person waits. They
 * trade depth for speed: the model reasons as little as it can, and the
 * prompt is not routed through the Fabric enhancer's extra network calls.
 * One place decides which turns those are, so every engine agrees.
 */
const VOICE_TURN_FEATURE_KEYS: ReadonlySet<string> = new Set(["parlume"]);

export function isVoiceTurn(featureKey: string | undefined): boolean {
	return featureKey !== undefined && VOICE_TURN_FEATURE_KEYS.has(featureKey);
}
