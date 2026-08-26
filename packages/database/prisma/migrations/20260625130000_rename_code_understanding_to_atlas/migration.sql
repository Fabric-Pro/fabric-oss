-- Rename the "code understanding" feature to "Atlas" at the physical layer.
--
-- Pure metadata rename: every statement is an in-place RENAME, so no table is
-- dropped/recreated and no row is moved — all existing data and foreign-key
-- relationships are preserved. Brings the physical table names, enum types,
-- and their indexes/constraints in line with the renamed Prisma models/enums
-- (CodeUnderstanding* -> Atlas*, code_understanding_* -> atlas_*).
--
-- Index/constraint targets are the exact names Prisma derives for the new
-- table names (note the 63-char truncation lands differently under the shorter
-- "atlas_" prefix, e.g. ..._repositoryIntegration_key -> ..._repositoryIntegrationId_branch_key),
-- so the post-migration schema matches the datamodel with zero drift.

-- 1. Tables ----------------------------------------------------------------
ALTER TABLE "code_understanding_analysis"               RENAME TO "atlas_analysis";
ALTER TABLE "code_understanding_node"                   RENAME TO "atlas_node";
ALTER TABLE "code_understanding_edge"                   RENAME TO "atlas_edge";
ALTER TABLE "code_understanding_analysis_run"           RENAME TO "atlas_analysis_run";
ALTER TABLE "code_understanding_conversation"           RENAME TO "atlas_conversation";
ALTER TABLE "code_understanding_node_override"          RENAME TO "atlas_node_override";
ALTER TABLE "code_understanding_node_override_history"  RENAME TO "atlas_node_override_history";
ALTER TABLE "code_understanding_cross_edge"             RENAME TO "atlas_cross_edge";
ALTER TABLE "code_understanding_cross_link"             RENAME TO "atlas_cross_link";
ALTER TABLE "code_understanding_cross_link_run"         RENAME TO "atlas_cross_link_run";
ALTER TABLE "code_understanding_system_layout"          RENAME TO "atlas_system_layout";
ALTER TABLE "code_understanding_edge_override"          RENAME TO "atlas_edge_override";
ALTER TABLE "code_understanding_edge_override_history"  RENAME TO "atlas_edge_override_history";

-- 2. Enum types ------------------------------------------------------------
ALTER TYPE "CodeUnderstandingStatus"               RENAME TO "AtlasStatus";
ALTER TYPE "CodeUnderstandingGraphMode"            RENAME TO "AtlasGraphMode";
ALTER TYPE "CodeUnderstandingNodeKind"             RENAME TO "AtlasNodeKind";
ALTER TYPE "CodeUnderstandingEdgeKind"             RENAME TO "AtlasEdgeKind";
ALTER TYPE "CodeUnderstandingRunStatus"            RENAME TO "AtlasRunStatus";
ALTER TYPE "CodeUnderstandingChatVisibility"       RENAME TO "AtlasChatVisibility";
ALTER TYPE "CodeUnderstandingCrossEdgeKind"        RENAME TO "AtlasCrossEdgeKind";
ALTER TYPE "CodeUnderstandingCrossEdgeDetection"   RENAME TO "AtlasCrossEdgeDetection";
ALTER TYPE "CodeUnderstandingCrossLinkStatus"      RENAME TO "AtlasCrossLinkStatus";

-- 3. Constraints (PK/FK) — the table is already renamed above ---------------
ALTER TABLE "atlas_analysis" RENAME CONSTRAINT "code_understanding_analysis_organizationId_fkey" TO "atlas_analysis_organizationId_fkey";
ALTER TABLE "atlas_analysis" RENAME CONSTRAINT "code_understanding_analysis_pkey" TO "atlas_analysis_pkey";
ALTER TABLE "atlas_analysis" RENAME CONSTRAINT "code_understanding_analysis_projectId_fkey" TO "atlas_analysis_projectId_fkey";
ALTER TABLE "atlas_analysis" RENAME CONSTRAINT "code_understanding_analysis_userId_fkey" TO "atlas_analysis_userId_fkey";
ALTER TABLE "atlas_analysis_run" RENAME CONSTRAINT "code_understanding_analysis_run_analysisId_fkey" TO "atlas_analysis_run_analysisId_fkey";
ALTER TABLE "atlas_analysis_run" RENAME CONSTRAINT "code_understanding_analysis_run_pkey" TO "atlas_analysis_run_pkey";
ALTER TABLE "atlas_conversation" RENAME CONSTRAINT "code_understanding_conversation_pkey" TO "atlas_conversation_pkey";
ALTER TABLE "atlas_conversation" RENAME CONSTRAINT "code_understanding_conversation_projectId_fkey" TO "atlas_conversation_projectId_fkey";
ALTER TABLE "atlas_cross_edge" RENAME CONSTRAINT "code_understanding_cross_edge_pkey" TO "atlas_cross_edge_pkey";
ALTER TABLE "atlas_cross_edge" RENAME CONSTRAINT "code_understanding_cross_edge_projectId_fkey" TO "atlas_cross_edge_projectId_fkey";
ALTER TABLE "atlas_cross_link" RENAME CONSTRAINT "code_understanding_cross_link_pkey" TO "atlas_cross_link_pkey";
ALTER TABLE "atlas_cross_link" RENAME CONSTRAINT "code_understanding_cross_link_projectId_fkey" TO "atlas_cross_link_projectId_fkey";
ALTER TABLE "atlas_cross_link_run" RENAME CONSTRAINT "code_understanding_cross_link_run_pkey" TO "atlas_cross_link_run_pkey";
ALTER TABLE "atlas_cross_link_run" RENAME CONSTRAINT "code_understanding_cross_link_run_projectId_fkey" TO "atlas_cross_link_run_projectId_fkey";
ALTER TABLE "atlas_edge" RENAME CONSTRAINT "code_understanding_edge_analysisId_fkey" TO "atlas_edge_analysisId_fkey";
ALTER TABLE "atlas_edge" RENAME CONSTRAINT "code_understanding_edge_pkey" TO "atlas_edge_pkey";
ALTER TABLE "atlas_edge_override" RENAME CONSTRAINT "code_understanding_edge_override_pkey" TO "atlas_edge_override_pkey";
ALTER TABLE "atlas_edge_override" RENAME CONSTRAINT "code_understanding_edge_override_projectId_fkey" TO "atlas_edge_override_projectId_fkey";
ALTER TABLE "atlas_edge_override_history" RENAME CONSTRAINT "code_understanding_edge_override_history_overrideId_fkey" TO "atlas_edge_override_history_overrideId_fkey";
ALTER TABLE "atlas_edge_override_history" RENAME CONSTRAINT "code_understanding_edge_override_history_pkey" TO "atlas_edge_override_history_pkey";
ALTER TABLE "atlas_node" RENAME CONSTRAINT "code_understanding_node_analysisId_fkey" TO "atlas_node_analysisId_fkey";
ALTER TABLE "atlas_node" RENAME CONSTRAINT "code_understanding_node_pkey" TO "atlas_node_pkey";
ALTER TABLE "atlas_node_override" RENAME CONSTRAINT "code_understanding_node_override_pkey" TO "atlas_node_override_pkey";
ALTER TABLE "atlas_node_override" RENAME CONSTRAINT "code_understanding_node_override_projectId_fkey" TO "atlas_node_override_projectId_fkey";
ALTER TABLE "atlas_node_override_history" RENAME CONSTRAINT "code_understanding_node_override_history_overrideId_fkey" TO "atlas_node_override_history_overrideId_fkey";
ALTER TABLE "atlas_node_override_history" RENAME CONSTRAINT "code_understanding_node_override_history_pkey" TO "atlas_node_override_history_pkey";
ALTER TABLE "atlas_system_layout" RENAME CONSTRAINT "code_understanding_system_layout_pkey" TO "atlas_system_layout_pkey";
ALTER TABLE "atlas_system_layout" RENAME CONSTRAINT "code_understanding_system_layout_projectId_fkey" TO "atlas_system_layout_projectId_fkey";

-- 4. Indexes (@@index / @unique) -------------------------------------------
ALTER INDEX "code_understanding_analysis_organizationId_idx" RENAME TO "atlas_analysis_organizationId_idx";
ALTER INDEX "code_understanding_analysis_projectId_idx" RENAME TO "atlas_analysis_projectId_idx";
ALTER INDEX "code_understanding_analysis_projectId_repositoryIntegration_key" RENAME TO "atlas_analysis_projectId_repositoryIntegrationId_branch_key";
ALTER INDEX "code_understanding_analysis_run_analysisId_startedAt_idx" RENAME TO "atlas_analysis_run_analysisId_startedAt_idx";
ALTER INDEX "code_understanding_analysis_run_organizationId_idx" RENAME TO "atlas_analysis_run_organizationId_idx";
ALTER INDEX "code_understanding_analysis_run_projectId_idx" RENAME TO "atlas_analysis_run_projectId_idx";
ALTER INDEX "code_understanding_analysis_run_userId_idx" RENAME TO "atlas_analysis_run_userId_idx";
ALTER INDEX "code_understanding_analysis_status_idx" RENAME TO "atlas_analysis_status_idx";
ALTER INDEX "code_understanding_analysis_userId_idx" RENAME TO "atlas_analysis_userId_idx";
ALTER INDEX "code_understanding_conversation_organizationId_idx" RENAME TO "atlas_conversation_organizationId_idx";
ALTER INDEX "code_understanding_conversation_projectId_repositoryIntegra_idx" RENAME TO "atlas_conversation_projectId_repositoryIntegrationId_mode_idx";
ALTER INDEX "code_understanding_conversation_userId_idx" RENAME TO "atlas_conversation_userId_idx";
ALTER INDEX "code_understanding_cross_edge_organizationId_idx" RENAME TO "atlas_cross_edge_organizationId_idx";
ALTER INDEX "code_understanding_cross_edge_projectId_mode_idx" RENAME TO "atlas_cross_edge_projectId_mode_idx";
ALTER INDEX "code_understanding_cross_edge_projectId_mode_kind_sourceAna_key" RENAME TO "atlas_cross_edge_projectId_mode_kind_sourceAnalysisId_sourc_key";
ALTER INDEX "code_understanding_cross_edge_sourceAnalysisId_idx" RENAME TO "atlas_cross_edge_sourceAnalysisId_idx";
ALTER INDEX "code_understanding_cross_edge_targetAnalysisId_idx" RENAME TO "atlas_cross_edge_targetAnalysisId_idx";
ALTER INDEX "code_understanding_cross_edge_userId_idx" RENAME TO "atlas_cross_edge_userId_idx";
ALTER INDEX "code_understanding_cross_link_organizationId_idx" RENAME TO "atlas_cross_link_organizationId_idx";
ALTER INDEX "code_understanding_cross_link_projectId_key" RENAME TO "atlas_cross_link_projectId_key";
ALTER INDEX "code_understanding_cross_link_run_organizationId_idx" RENAME TO "atlas_cross_link_run_organizationId_idx";
ALTER INDEX "code_understanding_cross_link_run_projectId_startedAt_idx" RENAME TO "atlas_cross_link_run_projectId_startedAt_idx";
ALTER INDEX "code_understanding_cross_link_run_userId_idx" RENAME TO "atlas_cross_link_run_userId_idx";
ALTER INDEX "code_understanding_cross_link_userId_idx" RENAME TO "atlas_cross_link_userId_idx";
ALTER INDEX "code_understanding_edge_analysisId_mode_idx" RENAME TO "atlas_edge_analysisId_mode_idx";
ALTER INDEX "code_understanding_edge_organizationId_idx" RENAME TO "atlas_edge_organizationId_idx";
ALTER INDEX "code_understanding_edge_override_history_organizationId_idx" RENAME TO "atlas_edge_override_history_organizationId_idx";
ALTER INDEX "code_understanding_edge_override_history_overrideId_created_idx" RENAME TO "atlas_edge_override_history_overrideId_createdAt_idx";
ALTER INDEX "code_understanding_edge_override_history_userId_idx" RENAME TO "atlas_edge_override_history_userId_idx";
ALTER INDEX "code_understanding_edge_override_organizationId_idx" RENAME TO "atlas_edge_override_organizationId_idx";
ALTER INDEX "code_understanding_edge_override_projectId_branch_mode_sour_key" RENAME TO "atlas_edge_override_projectId_branch_mode_sourceRepositoryI_key";
ALTER INDEX "code_understanding_edge_override_projectId_mode_idx" RENAME TO "atlas_edge_override_projectId_mode_idx";
ALTER INDEX "code_understanding_edge_override_userId_idx" RENAME TO "atlas_edge_override_userId_idx";
ALTER INDEX "code_understanding_edge_projectId_idx" RENAME TO "atlas_edge_projectId_idx";
ALTER INDEX "code_understanding_edge_userId_idx" RENAME TO "atlas_edge_userId_idx";
ALTER INDEX "code_understanding_node_analysisId_mode_idx" RENAME TO "atlas_node_analysisId_mode_idx";
ALTER INDEX "code_understanding_node_analysisId_mode_key_key" RENAME TO "atlas_node_analysisId_mode_key_key";
ALTER INDEX "code_understanding_node_organizationId_idx" RENAME TO "atlas_node_organizationId_idx";
ALTER INDEX "code_understanding_node_override_history_organizationId_idx" RENAME TO "atlas_node_override_history_organizationId_idx";
ALTER INDEX "code_understanding_node_override_history_overrideId_created_idx" RENAME TO "atlas_node_override_history_overrideId_createdAt_idx";
ALTER INDEX "code_understanding_node_override_history_userId_idx" RENAME TO "atlas_node_override_history_userId_idx";
ALTER INDEX "code_understanding_node_override_organizationId_idx" RENAME TO "atlas_node_override_organizationId_idx";
ALTER INDEX "code_understanding_node_override_projectId_idx" RENAME TO "atlas_node_override_projectId_idx";
ALTER INDEX "code_understanding_node_override_projectId_repositoryIntegr_idx" RENAME TO "atlas_node_override_projectId_repositoryIntegrationId_branc_idx";
ALTER INDEX "code_understanding_node_override_projectId_repositoryIntegr_key" RENAME TO "atlas_node_override_projectId_repositoryIntegrationId_branc_key";
ALTER INDEX "code_understanding_node_override_userId_idx" RENAME TO "atlas_node_override_userId_idx";
ALTER INDEX "code_understanding_node_projectId_idx" RENAME TO "atlas_node_projectId_idx";
ALTER INDEX "code_understanding_node_userId_idx" RENAME TO "atlas_node_userId_idx";
ALTER INDEX "code_understanding_system_layout_organizationId_idx" RENAME TO "atlas_system_layout_organizationId_idx";
ALTER INDEX "code_understanding_system_layout_projectId_mode_idx" RENAME TO "atlas_system_layout_projectId_mode_idx";
ALTER INDEX "code_understanding_system_layout_projectId_mode_nodeId_key" RENAME TO "atlas_system_layout_projectId_mode_nodeId_key";
ALTER INDEX "code_understanding_system_layout_userId_idx" RENAME TO "atlas_system_layout_userId_idx";
