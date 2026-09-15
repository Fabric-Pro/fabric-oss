export * from "./readiness";
export * from "./transition-story";
export * from "./evidence-providers";

// Register the default evidence providers on import so every consumer of the
// delivery module (API procedures, Temporal activities) gets real spike and
// discovery evidence without extra wiring.
import { registerDefaultEvidenceProviders } from "./evidence-providers";

registerDefaultEvidenceProviders();
