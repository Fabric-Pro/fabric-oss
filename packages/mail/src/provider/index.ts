// Resend is the mail provider, and this single re-export is the only place that is decided —
// there is no env-driven provider selection anywhere in the package, and isMailConfigured()
// gates on RESEND_API_KEY specifically (src/util/send.ts:19-21).
//
// THE `idempotencyKey` PASSED BY CALLERS IS LOAD-BEARING AND ONLY RESEND FORWARDS IT
// (src/provider/resend.ts:60); the other provider modules beside this file ignore it. Publishing
// Suite 1C-2c relies on it as the second layer of duplicate protection for at-least-once email:
// its lease closes the overlap window, and the key collapses the duplicate that survives the
// ambiguous-commit window — an attempt that handed the message to the provider and died before
// recording it. Editing this line to another provider silently drops that layer, with nothing in
// CI to notice.
//
// The layer is real but NOT durable: Resend retains an idempotency key for 24 hours. Retries
// inside a workflow land within minutes and are covered; a recovery run a day later is not, and
// that is handled where it happens rather than assumed away here — see
// PUBLISHING_EMAIL_PROVIDER_DEDUPE_WINDOW_MS in @repo/database and the re-drive script's age
// guard. Do not describe this key as preventing duplicates outright; it prevents them for a day.
export * from "./resend";
