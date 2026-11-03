-- ============================================================================
-- 0003 · Foto de capa escolhida do relatório
--  * `capa_foto_id` é a foto que o usuário escolheu como capa (uma foto da área ou de qualquer registro do relatório).
--  * Sem escolha, a capa continua sendo a foto da área ou, sem ela, a foto mais recente dos registros.
-- ============================================================================

SET NAMES utf8mb4;

ALTER TABLE relatorio ADD COLUMN capa_foto_id CHAR(36) NULL AFTER area_foto_id;
