-- Resumability: stamp the BUSINESS-graph (System Map) derivation with a
-- fingerprint of the inputs that produced it, so a retried/re-run derivation
-- with identical inputs can skip the expensive AI re-derivation. Nullable and
-- additive, so existing analyses are unaffected (they re-derive once, then
-- stamp themselves).
ALTER TABLE "atlas_analysis" ADD COLUMN "businessSignature" TEXT;
