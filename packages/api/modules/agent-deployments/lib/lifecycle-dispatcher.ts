// Re-export the shared dispatcher from @repo/temporal so existing relative
// imports keep working. Source of truth lives in packages/temporal so
// temporal activities can call it without a circular dependency.
export { dispatchLifecycleEvent } from "@repo/temporal";
