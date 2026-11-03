-- ============================================================================
-- 0004 · Formato da entrega do relatório (PDF, impresso, slides ou outro)
-- ============================================================================

SET NAMES utf8mb4;

ALTER TABLE relatorio ADD COLUMN formato_entrega ENUM('pdf','impresso','slides','outro') NULL AFTER lembrete_entrega;
