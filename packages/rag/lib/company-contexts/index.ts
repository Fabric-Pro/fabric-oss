/**
 * Company context RAG module
 *
 * The vector side of an organization's company context: the sources it
 * maintains once about itself, which Proposal and Business Case generation
 * retrieve alongside a project's own context. Vectors live in the
 * `company-contexts-org-{orgId}` collection, never in a project collection.
 *
 * - store: write and delete company context points
 * - search: retrieve company context points for generation
 * - model: the embedding model identity points are written and searched with
 */

export * from "./model";
export * from "./search";
export * from "./store";
