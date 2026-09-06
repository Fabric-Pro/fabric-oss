/**
 * Browser Automation Module
 *
 * Exports browser automation activities and types.
 *
 * The session manager's helpers are deliberately NOT re-exported here. This
 * barrel feeds `activities/index.ts`, which the worker registers wholesale
 * (`worker.ts`: `import * as activities` → `Worker.create({ activities })`),
 * so anything exported from it becomes a schedulable activity name. That is
 * fine for the six ownership-checked activities in `./activities`, but
 * `closeAllSessions` takes no caller identity and closes every tenant's
 * sessions — registering it would hand any workflow a cross-tenant kill switch
 * and undo the ownership check. Worker lifecycle code and tests import it from
 * `./session-manager` directly instead.
 */

export * from "./activities";
export * from "./types";
