-- ============================================================================
-- 0002 · Log de sincronização (docs/offline.md, docs/api.md seção 14)
--  * Toda criação, alteração e exclusão das entidades que o celular sincroniza grava uma linha em `mudanca`
--    (o `seq` é o cursor do celular). Feito com triggers: pega também o que o servidor faz sozinho
--    (clima preenchido depois, transcrição, encerramento de período).
--  * O MySQL NÃO dispara trigger em exclusão em cascata. Por isso as exclusões de relatório, registro,
--    evento e anotação (BEFORE DELETE) já registram a exclusão dos filhos que a cascata vai apagar.
--  * `historico_texto` guarda o texto que perdeu num conflito de edição (nunca se perde texto).
--  * No fim, as linhas que já existiam entram no log (cursor vazio = baixar tudo).
-- ============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS historico_texto (
  id             CHAR(36) NOT NULL PRIMARY KEY,
  usuario_id     CHAR(36) NOT NULL,
  entidade       VARCHAR(30) NOT NULL,
  entidade_id    CHAR(36) NOT NULL,
  campo          VARCHAR(30) NOT NULL,
  texto          MEDIUMTEXT NOT NULL,
  substituido_em DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY historico_texto_item (usuario_id, entidade, entidade_id),
  FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DELIMITER $$

DROP TRIGGER IF EXISTS periodo_sync_ai$$
CREATE TRIGGER periodo_sync_ai AFTER INSERT ON periodo FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'period', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS periodo_sync_au$$
CREATE TRIGGER periodo_sync_au AFTER UPDATE ON periodo FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'period', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS periodo_sync_bd$$
CREATE TRIGGER periodo_sync_bd BEFORE DELETE ON periodo FOR EACH ROW BEGIN
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (OLD.usuario_id, 'period', OLD.id, 'excluir', NULL);
END$$

DROP TRIGGER IF EXISTS professor_sync_ai$$
CREATE TRIGGER professor_sync_ai AFTER INSERT ON professor FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'teacher', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS professor_sync_au$$
CREATE TRIGGER professor_sync_au AFTER UPDATE ON professor FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'teacher', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS professor_sync_bd$$
CREATE TRIGGER professor_sync_bd BEFORE DELETE ON professor FOR EACH ROW BEGIN
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (OLD.usuario_id, 'teacher', OLD.id, 'excluir', NULL);
END$$

DROP TRIGGER IF EXISTS materia_sync_ai$$
CREATE TRIGGER materia_sync_ai AFTER INSERT ON materia FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'subject', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS materia_sync_au$$
CREATE TRIGGER materia_sync_au AFTER UPDATE ON materia FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'subject', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS materia_sync_bd$$
CREATE TRIGGER materia_sync_bd BEFORE DELETE ON materia FOR EACH ROW BEGIN
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (OLD.usuario_id, 'subject', OLD.id, 'excluir', NULL);
END$$

DROP TRIGGER IF EXISTS relatorio_sync_ai$$
CREATE TRIGGER relatorio_sync_ai AFTER INSERT ON relatorio FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'report', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS relatorio_sync_au$$
CREATE TRIGGER relatorio_sync_au AFTER UPDATE ON relatorio FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'report', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS relatorio_sync_bd$$
CREATE TRIGGER relatorio_sync_bd BEFORE DELETE ON relatorio FOR EACH ROW BEGIN
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'entry', id, 'excluir', NULL FROM registro WHERE usuario_id = OLD.usuario_id AND relatorio_id = OLD.id;
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'todo', id, 'excluir', NULL FROM registro_pendencia WHERE usuario_id = OLD.usuario_id AND registro_id IN (SELECT id FROM registro WHERE usuario_id = OLD.usuario_id AND relatorio_id = OLD.id);
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'photo', id, 'excluir', NULL FROM foto WHERE usuario_id = OLD.usuario_id AND (relatorio_id = OLD.id OR registro_id IN (SELECT id FROM registro WHERE usuario_id = OLD.usuario_id AND relatorio_id = OLD.id) OR evento_id IN (SELECT id FROM evento WHERE usuario_id = OLD.usuario_id AND relatorio_id = OLD.id));
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'audio', id, 'excluir', NULL FROM audio WHERE usuario_id = OLD.usuario_id AND registro_id IN (SELECT id FROM registro WHERE usuario_id = OLD.usuario_id AND relatorio_id = OLD.id);
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'event', id, 'excluir', NULL FROM evento WHERE usuario_id = OLD.usuario_id AND relatorio_id = OLD.id;
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (OLD.usuario_id, 'report', OLD.id, 'excluir', NULL);
END$$

DROP TRIGGER IF EXISTS registro_sync_ai$$
CREATE TRIGGER registro_sync_ai AFTER INSERT ON registro FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'entry', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS registro_sync_au$$
CREATE TRIGGER registro_sync_au AFTER UPDATE ON registro FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'entry', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS registro_sync_bd$$
CREATE TRIGGER registro_sync_bd BEFORE DELETE ON registro FOR EACH ROW BEGIN
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'todo', id, 'excluir', NULL FROM registro_pendencia WHERE usuario_id = OLD.usuario_id AND registro_id = OLD.id;
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'photo', id, 'excluir', NULL FROM foto WHERE usuario_id = OLD.usuario_id AND registro_id = OLD.id;
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'audio', id, 'excluir', NULL FROM audio WHERE usuario_id = OLD.usuario_id AND registro_id = OLD.id;
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (OLD.usuario_id, 'entry', OLD.id, 'excluir', NULL);
END$$

DROP TRIGGER IF EXISTS registro_pendencia_sync_ai$$
CREATE TRIGGER registro_pendencia_sync_ai AFTER INSERT ON registro_pendencia FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'todo', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS registro_pendencia_sync_au$$
CREATE TRIGGER registro_pendencia_sync_au AFTER UPDATE ON registro_pendencia FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'todo', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS registro_pendencia_sync_bd$$
CREATE TRIGGER registro_pendencia_sync_bd BEFORE DELETE ON registro_pendencia FOR EACH ROW BEGIN
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (OLD.usuario_id, 'todo', OLD.id, 'excluir', NULL);
END$$

DROP TRIGGER IF EXISTS evento_sync_ai$$
CREATE TRIGGER evento_sync_ai AFTER INSERT ON evento FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'event', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS evento_sync_au$$
CREATE TRIGGER evento_sync_au AFTER UPDATE ON evento FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'event', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS evento_sync_bd$$
CREATE TRIGGER evento_sync_bd BEFORE DELETE ON evento FOR EACH ROW BEGIN
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'photo', id, 'excluir', NULL FROM foto WHERE usuario_id = OLD.usuario_id AND evento_id = OLD.id;
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (OLD.usuario_id, 'event', OLD.id, 'excluir', NULL);
END$$

DROP TRIGGER IF EXISTS anotacao_sync_ai$$
CREATE TRIGGER anotacao_sync_ai AFTER INSERT ON anotacao FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'note', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS anotacao_sync_au$$
CREATE TRIGGER anotacao_sync_au AFTER UPDATE ON anotacao FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'note', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS anotacao_sync_bd$$
CREATE TRIGGER anotacao_sync_bd BEFORE DELETE ON anotacao FOR EACH ROW BEGIN
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'audio', id, 'excluir', NULL FROM audio WHERE usuario_id = OLD.usuario_id AND anotacao_id = OLD.id;
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (OLD.usuario_id, 'note', OLD.id, 'excluir', NULL);
END$$

DROP TRIGGER IF EXISTS foto_sync_ai$$
CREATE TRIGGER foto_sync_ai AFTER INSERT ON foto FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'photo', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS foto_sync_au$$
CREATE TRIGGER foto_sync_au AFTER UPDATE ON foto FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'photo', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS foto_sync_bd$$
CREATE TRIGGER foto_sync_bd BEFORE DELETE ON foto FOR EACH ROW BEGIN
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (OLD.usuario_id, 'photo', OLD.id, 'excluir', NULL);
END$$

DROP TRIGGER IF EXISTS audio_sync_ai$$
CREATE TRIGGER audio_sync_ai AFTER INSERT ON audio FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'audio', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS audio_sync_au$$
CREATE TRIGGER audio_sync_au AFTER UPDATE ON audio FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.usuario_id, 'audio', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS audio_sync_bd$$
CREATE TRIGGER audio_sync_bd BEFORE DELETE ON audio FOR EACH ROW BEGIN
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (OLD.usuario_id, 'audio', OLD.id, 'excluir', NULL);
END$$

DROP TRIGGER IF EXISTS usuario_sync_ai$$
CREATE TRIGGER usuario_sync_ai AFTER INSERT ON usuario FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.id, 'user', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS usuario_sync_au$$
CREATE TRIGGER usuario_sync_au AFTER UPDATE ON usuario FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) VALUES (NEW.id, 'user', NEW.id, 'upsert', NEW.versao)$$

DROP TRIGGER IF EXISTS materia_dia_sync_ai$$
CREATE TRIGGER materia_dia_sync_ai AFTER INSERT ON materia_dia FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'subject', id, 'upsert', versao FROM materia WHERE id = NEW.materia_id$$

DROP TRIGGER IF EXISTS materia_dia_sync_ad$$
CREATE TRIGGER materia_dia_sync_ad AFTER DELETE ON materia_dia FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'subject', id, 'upsert', versao FROM materia WHERE id = OLD.materia_id$$

DROP TRIGGER IF EXISTS relatorio_tag_sync_ai$$
CREATE TRIGGER relatorio_tag_sync_ai AFTER INSERT ON relatorio_tag FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'report', id, 'upsert', versao FROM relatorio WHERE usuario_id = NEW.usuario_id AND id = NEW.relatorio_id$$

DROP TRIGGER IF EXISTS relatorio_tag_sync_ad$$
CREATE TRIGGER relatorio_tag_sync_ad AFTER DELETE ON relatorio_tag FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'report', id, 'upsert', versao FROM relatorio WHERE usuario_id = OLD.usuario_id AND id = OLD.relatorio_id$$

DROP TRIGGER IF EXISTS registro_tag_sync_ai$$
CREATE TRIGGER registro_tag_sync_ai AFTER INSERT ON registro_tag FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'entry', id, 'upsert', versao FROM registro WHERE usuario_id = NEW.usuario_id AND id = NEW.registro_id$$

DROP TRIGGER IF EXISTS registro_tag_sync_ad$$
CREATE TRIGGER registro_tag_sync_ad AFTER DELETE ON registro_tag FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'entry', id, 'upsert', versao FROM registro WHERE usuario_id = OLD.usuario_id AND id = OLD.registro_id$$

DROP TRIGGER IF EXISTS anotacao_tag_sync_ai$$
CREATE TRIGGER anotacao_tag_sync_ai AFTER INSERT ON anotacao_tag FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'note', id, 'upsert', versao FROM anotacao WHERE usuario_id = NEW.usuario_id AND id = NEW.anotacao_id$$

DROP TRIGGER IF EXISTS anotacao_tag_sync_ad$$
CREATE TRIGGER anotacao_tag_sync_ad AFTER DELETE ON anotacao_tag FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'note', id, 'upsert', versao FROM anotacao WHERE usuario_id = OLD.usuario_id AND id = OLD.anotacao_id$$

DROP TRIGGER IF EXISTS anexo_sync_ai$$
CREATE TRIGGER anexo_sync_ai AFTER INSERT ON anexo FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'note', id, 'upsert', versao FROM anotacao WHERE usuario_id = NEW.usuario_id AND id = NEW.anotacao_id$$

DROP TRIGGER IF EXISTS anexo_sync_ad$$
CREATE TRIGGER anexo_sync_ad AFTER DELETE ON anexo FOR EACH ROW
  INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao)
    SELECT usuario_id, 'note', id, 'upsert', versao FROM anotacao WHERE usuario_id = OLD.usuario_id AND id = OLD.anotacao_id$$

DELIMITER ;

-- linhas que já existiam entram no log (pais antes dos filhos)
INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) SELECT id, 'user', id, 'upsert', versao FROM usuario;
INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) SELECT usuario_id, 'period', id, 'upsert', versao FROM periodo;
INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) SELECT usuario_id, 'teacher', id, 'upsert', versao FROM professor;
INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) SELECT usuario_id, 'subject', id, 'upsert', versao FROM materia;
INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) SELECT usuario_id, 'report', id, 'upsert', versao FROM relatorio;
INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) SELECT usuario_id, 'event', id, 'upsert', versao FROM evento;
INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) SELECT usuario_id, 'entry', id, 'upsert', versao FROM registro;
INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) SELECT usuario_id, 'todo', id, 'upsert', versao FROM registro_pendencia;
INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) SELECT usuario_id, 'note', id, 'upsert', versao FROM anotacao;
INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) SELECT usuario_id, 'photo', id, 'upsert', versao FROM foto;
INSERT INTO mudanca (usuario_id, entidade, entidade_id, operacao, versao) SELECT usuario_id, 'audio', id, 'upsert', versao FROM audio;
