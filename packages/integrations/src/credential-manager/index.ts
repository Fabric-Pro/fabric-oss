// Registers the GitHub adapter at load, so every `resolveCredential` caller
// can refresh a GitHub grant.
import "./github";

export * from "./backfill";
export * from "./requirement";
export * from "./resolve";
