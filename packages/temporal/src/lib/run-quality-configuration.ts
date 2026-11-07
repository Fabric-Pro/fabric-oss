/** Saved-configuration marker only. Never a receipt for live memory, retrieved
 * content or grounding. Contains no source text, prompts or credentials. */
export interface NativeQualityConfiguration {
	version: 1;
	assessmentId: string;
	configHash: string;
}
export const NATIVE_QUALITY_CONFIGURATION_PATCH =
	"native-quality-loaded-configuration-v1";
