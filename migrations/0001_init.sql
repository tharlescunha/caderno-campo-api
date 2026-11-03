-- ============================================================================
-- Caderno de Campo · versão 1 · banco do SERVIDOR (MySQL 8.4 LTS, em Docker)
-- Precisa de MySQL 8.0.16+ (CHECK, colunas geradas, JSON). Charset utf8mb4.
-- O celular usa SQLite com as mesmas tabelas de dados: veja schema-celular.sql.
-- Explicação e decisões: veja banco-de-dados.md
-- ============================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';          -- tudo em UTC; a tela converte para o fuso do usuário

-- Convenções
--  * ids: CHAR(36) com UUID v4 gerado no cliente (celular ou site) ou na API
--  * booleanos: TINYINT(1) 0 ou 1
--  * data e hora: DATETIME(3) em UTC. Só data: DATE
--  * listas: JSON
--  * toda tabela de dados do usuário tem usuario_id, e as chaves estrangeiras
--    são COMPOSTAS (usuario_id, id): um dado nunca aponta para dados de outro usuário
--  * versao sobe sozinha a cada UPDATE (triggers da seção 13): base da regra de conflito da sync

-- ============================================================================
-- 1. USUÁRIO E ACESSO
-- ============================================================================

CREATE TABLE usuario (
  id                            CHAR(36)     NOT NULL PRIMARY KEY,
  nome                          VARCHAR(120) NOT NULL,
  email                         VARCHAR(190) NOT NULL,
  senha_hash                    VARCHAR(255) NOT NULL,           -- Argon2id
  curso                         VARCHAR(120),
  instituicao                   VARCHAR(120),
  fuso_horario                  VARCHAR(60)  NOT NULL DEFAULT 'America/Araguaina',
  tema                          ENUM('claro','escuro','sistema') NOT NULL DEFAULT 'sistema',
  cidade_cotacoes               VARCHAR(80)  NOT NULL DEFAULT 'Palmas-TO',
  latitude_padrao               DECIMAL(9,6),
  longitude_padrao              DECIMAL(9,6),
  aviso_provas_entregas         TINYINT(1) NOT NULL DEFAULT 1,
  aviso_vespera_campo           TINYINT(1) NOT NULL DEFAULT 1,
  aviso_entrega_relatorio       TINYINT(1) NOT NULL DEFAULT 1,
  lembrar_registro_pos_campo    TINYINT(1) NOT NULL DEFAULT 1,
  hora_lembrete_pos_campo       CHAR(5)    NOT NULL DEFAULT '18:00',
  apagar_audio_apos_transcricao TINYINT(1) NOT NULL DEFAULT 0,
  enviar_fotos_so_wifi          TINYINT(1) NOT NULL DEFAULT 1,
  aceitou_termos_em             DATETIME(3) NOT NULL,
  primeiro_acesso_concluido_em  DATETIME(3),
  ultimo_login_em               DATETIME(3),
  criado_em                     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em                 DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  versao                        INT NOT NULL DEFAULT 1,
  UNIQUE KEY usuario_email_unico (email)      -- a collation utf8mb4_0900_ai_ci já ignora maiúsculas
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE refresh_token (
  id               CHAR(36) NOT NULL PRIMARY KEY,
  usuario_id       CHAR(36) NOT NULL,
  dispositivo_id   CHAR(36),
  token_hash       CHAR(64) NOT NULL,                            -- SHA-256 do token
  expira_em        DATETIME(3) NOT NULL,
  revogado_em      DATETIME(3),
  substituido_por  CHAR(36),
  ip               VARCHAR(45),
  agente           VARCHAR(255),
  criado_em        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY refresh_token_hash (token_hash),
  KEY refresh_token_usuario (usuario_id),
  FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE dispositivo (
  id                CHAR(36) NOT NULL PRIMARY KEY,
  usuario_id        CHAR(36) NOT NULL,
  nome              VARCHAR(120),
  token_push        VARCHAR(255),
  plataforma        ENUM('android','ios','web') NOT NULL,
  ativo             TINYINT(1) NOT NULL DEFAULT 1,
  ultimo_acesso_em  DATETIME(3),
  ultimo_cursor     BIGINT,
  criado_em         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY (usuario_id, id),
  FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Fase 2 (precisa de envio de e-mail): redefinição de senha e confirmação de conta.

-- ============================================================================
-- 2. PERÍODO, PROFESSOR E MATÉRIA
-- ============================================================================

CREATE TABLE periodo (
  id             CHAR(36) NOT NULL PRIMARY KEY,
  usuario_id     CHAR(36) NOT NULL,
  nome           VARCHAR(80) NOT NULL,
  data_inicio    DATE NOT NULL,
  data_fim       DATE,
  status         ENUM('ativo','finalizado') NOT NULL DEFAULT 'ativo',
  finalizado_em  DATETIME(3),
  criado_em      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  versao         INT NOT NULL DEFAULT 1,
  -- MySQL não tem índice parcial: esta coluna gerada vale o usuario_id só quando ativo
  -- e NULL nos demais; o índice único abaixo permite vários NULL, mas só um ativo.
  -- VIRTUAL (não STORED) de propósito: o MySQL recusa ON DELETE CASCADE em chave estrangeira
  -- cuja coluna (usuario_id) alimenta uma coluna gerada STORED. O índice único funciona igual.
  ativo_chave    CHAR(36) GENERATED ALWAYS AS (IF(status = 'ativo', usuario_id, NULL)) VIRTUAL,
  UNIQUE KEY (usuario_id, id),
  UNIQUE KEY periodo_um_ativo (ativo_chave),
  CHECK (data_fim IS NULL OR data_fim >= data_inicio),
  FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE professor (
  id             CHAR(36) NOT NULL PRIMARY KEY,
  usuario_id     CHAR(36) NOT NULL,
  nome           VARCHAR(120) NOT NULL,
  email          VARCHAR(190),
  observacoes    TEXT,
  criado_em      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  versao         INT NOT NULL DEFAULT 1,
  UNIQUE KEY (usuario_id, id),
  FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE materia (
  id               CHAR(36) NOT NULL PRIMARY KEY,
  usuario_id       CHAR(36) NOT NULL,
  periodo_id       CHAR(36) NOT NULL,
  professor_id     CHAR(36),
  nome             VARCHAR(120) NOT NULL,
  tipo_aula        ENUM('sala','campo','sala_e_campo') NOT NULL DEFAULT 'sala',
  cor              ENUM('azul','verde','terra','roxo','vermelho') NOT NULL DEFAULT 'verde',
  lembrar_vespera  TINYINT(1) NOT NULL DEFAULT 1,
  desativada       TINYINT(1) NOT NULL DEFAULT 0,
  criado_em        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  versao           INT NOT NULL DEFAULT 1,
  UNIQUE KEY (usuario_id, id),
  KEY materia_periodo (usuario_id, periodo_id),
  FOREIGN KEY (usuario_id)               REFERENCES usuario(id) ON DELETE CASCADE,
  FOREIGN KEY (usuario_id, periodo_id)   REFERENCES periodo(usuario_id, id),
  FOREIGN KEY (usuario_id, professor_id) REFERENCES professor(usuario_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- dias da semana da matéria: 1 = segunda ... 6 = sábado, 7 = domingo
CREATE TABLE materia_dia (
  materia_id  CHAR(36) NOT NULL,
  dia_semana  TINYINT NOT NULL,
  PRIMARY KEY (materia_id, dia_semana),
  CHECK (dia_semana BETWEEN 1 AND 7),
  FOREIGN KEY (materia_id) REFERENCES materia(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================================
-- 3. TAGS
-- ============================================================================

CREATE TABLE tag (
  id          CHAR(36) NOT NULL PRIMARY KEY,
  usuario_id  CHAR(36) NOT NULL,
  nome        VARCHAR(60) NOT NULL,
  UNIQUE KEY (usuario_id, id),
  UNIQUE KEY (usuario_id, nome),
  FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================================
-- 4. RELATÓRIOS, REGISTROS E PENDÊNCIAS
-- ============================================================================

CREATE TABLE relatorio (
  id                  CHAR(36) NOT NULL PRIMARY KEY,
  usuario_id          CHAR(36) NOT NULL,
  materia_id          CHAR(36) NOT NULL,
  titulo              VARCHAR(160) NOT NULL,
  tipo                ENUM('continuo','pontual') NOT NULL,
  status              ENUM('em_andamento','finalizado') NOT NULL DEFAULT 'em_andamento',
  finalizado_em       DATETIME(3),
  finalizado_por      ENUM('usuario','periodo'),
  data_entrega        DATE,
  lembrete_entrega    ENUM('nenhum','no_dia','1_dia','3_dias','1_semana') NOT NULL DEFAULT 'nenhum',
  observacoes         TEXT,
  area_cultura        VARCHAR(80),
  area_local          VARCHAR(120),
  area_comprimento_m  DECIMAL(10,2),
  area_largura_m      DECIMAL(10,2),
  area_m2             DECIMAL(14,2) GENERATED ALWAYS AS (area_comprimento_m * area_largura_m) STORED,
  area_foto_id        CHAR(36),
  criado_em           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  versao              INT NOT NULL DEFAULT 1,
  UNIQUE KEY (usuario_id, id),
  KEY relatorio_lista (usuario_id, status, materia_id),
  KEY relatorio_entrega (usuario_id, data_entrega),
  CHECK (area_comprimento_m IS NULL OR area_comprimento_m > 0),
  CHECK (area_largura_m IS NULL OR area_largura_m > 0),
  FOREIGN KEY (usuario_id)             REFERENCES usuario(id) ON DELETE CASCADE,
  FOREIGN KEY (usuario_id, materia_id) REFERENCES materia(usuario_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE registro (
  id                   CHAR(36) NOT NULL PRIMARY KEY,
  usuario_id           CHAR(36) NOT NULL,
  relatorio_id         CHAR(36) NOT NULL,
  data_hora            DATETIME(3) NOT NULL,               -- quando a visita aconteceu
  status               ENUM('rascunho','concluido') NOT NULL DEFAULT 'rascunho',
  atividades           JSON NOT NULL,                      -- ["vistoria","limpeza",...]
  aplicacao_produto    VARCHAR(160),
  aplicacao_dose       VARCHAR(80),
  aplicacao_alvo       VARCHAR(120),
  irrigacao            ENUM('funcionando','com_falha','sem_irrigacao','a_instalar'),
  altura_plantas_cm    DECIMAL(7,1),
  area_medida_m2       DECIMAL(12,2),
  cultura_estado       ENUM('otima','boa','regular','ruim'),
  estagio              VARCHAR(80),
  houve_praga          TINYINT(1) NOT NULL DEFAULT 0,
  praga_nome           VARCHAR(120),
  praga_nivel          ENUM('baixo','medio','alto'),
  observacoes          TEXT,
  latitude             DECIMAL(9,6),
  longitude            DECIMAL(9,6),
  clima_origem         ENUM('gps','manual','pendente','gps_atrasado'),
  clima_descricao      VARCHAR(80),
  clima_temperatura_c  DECIMAL(4,1),
  clima_sensacao_c     DECIMAL(4,1),
  clima_umidade_pct    TINYINT UNSIGNED,
  clima_vento_kmh      DECIMAL(5,1),
  clima_chuva_1h_mm    DECIMAL(5,1),
  clima_medido_em      DATETIME(3),
  criado_em            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  versao               INT NOT NULL DEFAULT 1,
  UNIQUE KEY (usuario_id, id),
  KEY registro_linha_do_tempo (usuario_id, relatorio_id, data_hora),
  KEY registro_status (usuario_id, status),
  CHECK (json_valid(atividades)),
  CHECK (houve_praga = 0 OR praga_nome IS NOT NULL),
  CHECK (latitude  IS NULL OR latitude  BETWEEN -90  AND 90),
  CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  CHECK (clima_umidade_pct IS NULL OR clima_umidade_pct <= 100),
  FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE,
  FOREIGN KEY (usuario_id, relatorio_id) REFERENCES relatorio(usuario_id, id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- "Para a próxima visita"
CREATE TABLE registro_pendencia (
  id                    CHAR(36) NOT NULL PRIMARY KEY,
  usuario_id            CHAR(36) NOT NULL,
  registro_id           CHAR(36) NOT NULL,                 -- registro em que o item foi criado
  texto                 VARCHAR(200) NOT NULL,
  ordem                 INT NOT NULL DEFAULT 0,
  feito                 TINYINT(1) NOT NULL DEFAULT 0,
  feito_no_registro_id  CHAR(36),                          -- sem FK composta: a API zera se o registro sumir
  feito_em              DATETIME(3),
  criado_em             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  versao                INT NOT NULL DEFAULT 1,
  UNIQUE KEY (usuario_id, id),
  KEY registro_pendencia_abertas (usuario_id, feito, registro_id),
  CHECK (CHAR_LENGTH(texto) >= 1),
  FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE,
  FOREIGN KEY (usuario_id, registro_id) REFERENCES registro(usuario_id, id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================================
-- 5. EVENTOS (provas, entregas, atividades)
-- ============================================================================

CREATE TABLE evento (
  id                     CHAR(36) NOT NULL PRIMARY KEY,
  usuario_id             CHAR(36) NOT NULL,
  materia_id             CHAR(36),
  relatorio_id           CHAR(36),
  tipo                   ENUM('prova','trabalho','entrega_relatorio','atividade','evento_faculdade','outro') NOT NULL,
  descricao_tipo         VARCHAR(80),
  titulo                 VARCHAR(160) NOT NULL,
  data                   DATE NOT NULL,
  lembrete               ENUM('nenhum','no_dia','1_dia','3_dias','1_semana') NOT NULL DEFAULT 'nenhum',
  anotacoes              TEXT,
  concluido              TINYINT(1) NOT NULL DEFAULT 0,
  encerrado_com_periodo  TINYINT(1) NOT NULL DEFAULT 0,
  criado_em              DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  versao                 INT NOT NULL DEFAULT 1,
  UNIQUE KEY (usuario_id, id),
  UNIQUE KEY evento_um_por_relatorio (relatorio_id),       -- vários NULL são permitidos
  KEY evento_agenda (usuario_id, encerrado_com_periodo, data),
  CHECK (tipo <> 'outro' OR descricao_tipo IS NOT NULL),
  FOREIGN KEY (usuario_id)               REFERENCES usuario(id) ON DELETE CASCADE,
  FOREIGN KEY (usuario_id, materia_id)   REFERENCES materia(usuario_id, id),
  FOREIGN KEY (usuario_id, relatorio_id) REFERENCES relatorio(usuario_id, id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================================
-- 6. ANOTAÇÕES
-- ============================================================================

CREATE TABLE anotacao (
  id             CHAR(36) NOT NULL PRIMARY KEY,
  usuario_id     CHAR(36) NOT NULL,
  materia_id     CHAR(36),                                  -- vazio = anotação solta
  titulo         VARCHAR(160) NOT NULL,
  texto          MEDIUMTEXT,
  link           VARCHAR(500),
  fixada         TINYINT(1) NOT NULL DEFAULT 0,
  criado_em      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  versao         INT NOT NULL DEFAULT 1,
  UNIQUE KEY (usuario_id, id),
  KEY anotacao_lista (usuario_id, fixada, atualizado_em),
  KEY anotacao_materia (usuario_id, materia_id),
  CHECK (link IS NULL OR link LIKE 'http://%' OR link LIKE 'https://%'),
  FOREIGN KEY (usuario_id)               REFERENCES usuario(id) ON DELETE CASCADE,
  FOREIGN KEY (usuario_id, materia_id)   REFERENCES materia(usuario_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================================
-- 7. FOTOS, ANEXOS E ÁUDIOS (as linhas ficam no banco; os arquivos, em disco)
-- ============================================================================

-- foto de um registro, da área de um relatório OU de um evento (exatamente um dos três)
CREATE TABLE foto (
  id             CHAR(36) NOT NULL PRIMARY KEY,
  usuario_id     CHAR(36) NOT NULL,
  registro_id    CHAR(36),
  relatorio_id   CHAR(36),
  evento_id      CHAR(36),
  arquivo        VARCHAR(255),
  miniatura      VARCHAR(255),
  tipo_mime      VARCHAR(60) NOT NULL,
  tamanho_bytes  INT NOT NULL,
  legenda        VARCHAR(200),
  tirada_em      DATETIME(3),
  latitude       DECIMAL(9,6),
  longitude      DECIMAL(9,6),
  criado_em      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  versao         INT NOT NULL DEFAULT 1,
  UNIQUE KEY (usuario_id, id),
  KEY foto_registro (usuario_id, registro_id),
  KEY foto_evento (usuario_id, evento_id),
  CHECK (tamanho_bytes > 0),
  CHECK ((registro_id IS NOT NULL) + (relatorio_id IS NOT NULL) + (evento_id IS NOT NULL) = 1),
  FOREIGN KEY (usuario_id)               REFERENCES usuario(id) ON DELETE CASCADE,
  FOREIGN KEY (usuario_id, registro_id)  REFERENCES registro(usuario_id, id)  ON DELETE CASCADE,
  FOREIGN KEY (usuario_id, relatorio_id) REFERENCES relatorio(usuario_id, id) ON DELETE CASCADE,
  FOREIGN KEY (usuario_id, evento_id)    REFERENCES evento(usuario_id, id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE anexo (
  id             CHAR(36) NOT NULL PRIMARY KEY,
  usuario_id     CHAR(36) NOT NULL,
  anotacao_id    CHAR(36) NOT NULL,
  arquivo        VARCHAR(255),
  miniatura      VARCHAR(255),
  tipo_mime      VARCHAR(60) NOT NULL,
  tamanho_bytes  INT NOT NULL,
  criado_em      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CHECK (tamanho_bytes > 0),
  FOREIGN KEY (usuario_id)              REFERENCES usuario(id) ON DELETE CASCADE,
  FOREIGN KEY (usuario_id, anotacao_id) REFERENCES anotacao(usuario_id, id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- áudio gravado no registro ou na anotação; a transcrição é feita no servidor
CREATE TABLE audio (
  id                   CHAR(36) NOT NULL PRIMARY KEY,
  usuario_id           CHAR(36) NOT NULL,
  registro_id          CHAR(36),
  anotacao_id          CHAR(36),
  arquivo              VARCHAR(255),                       -- nulo depois de apagar o áudio
  tipo_mime            VARCHAR(60) NOT NULL,
  duracao_s            SMALLINT NOT NULL,
  tamanho_bytes        INT NOT NULL,
  gravado_em           DATETIME(3) NOT NULL,
  status               ENUM('transcrevendo','pronto','erro') NOT NULL DEFAULT 'transcrevendo',
  idioma               VARCHAR(10) NOT NULL DEFAULT 'pt-BR',
  transcricao          MEDIUMTEXT,
  transcricao_editada  MEDIUMTEXT,                         -- o que o usuário ajustou; vale mais que a transcrição
  confianca            DECIMAL(4,3),
  tentativas           TINYINT NOT NULL DEFAULT 0,
  erro                 VARCHAR(255),
  transcrito_em        DATETIME(3),
  criado_em            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  versao               INT NOT NULL DEFAULT 1,
  UNIQUE KEY (usuario_id, id),
  KEY audio_pendentes (status, criado_em),                 -- fila de transcrição
  CHECK (duracao_s BETWEEN 1 AND 300),
  CHECK (tamanho_bytes > 0),
  CHECK ((registro_id IS NOT NULL) + (anotacao_id IS NOT NULL) = 1),
  FOREIGN KEY (usuario_id)               REFERENCES usuario(id) ON DELETE CASCADE,
  FOREIGN KEY (usuario_id, registro_id)  REFERENCES registro(usuario_id, id) ON DELETE CASCADE,
  FOREIGN KEY (usuario_id, anotacao_id)  REFERENCES anotacao(usuario_id, id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================================
-- 8. LIGAÇÕES COM TAGS
-- ============================================================================

CREATE TABLE relatorio_tag (
  usuario_id CHAR(36) NOT NULL, relatorio_id CHAR(36) NOT NULL, tag_id CHAR(36) NOT NULL,
  PRIMARY KEY (relatorio_id, tag_id),
  FOREIGN KEY (usuario_id, relatorio_id) REFERENCES relatorio(usuario_id, id) ON DELETE CASCADE,
  FOREIGN KEY (usuario_id, tag_id)       REFERENCES tag(usuario_id, id)       ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE registro_tag (
  usuario_id CHAR(36) NOT NULL, registro_id CHAR(36) NOT NULL, tag_id CHAR(36) NOT NULL,
  PRIMARY KEY (registro_id, tag_id),
  FOREIGN KEY (usuario_id, registro_id) REFERENCES registro(usuario_id, id) ON DELETE CASCADE,
  FOREIGN KEY (usuario_id, tag_id)      REFERENCES tag(usuario_id, id)      ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE anotacao_tag (
  usuario_id CHAR(36) NOT NULL, anotacao_id CHAR(36) NOT NULL, tag_id CHAR(36) NOT NULL,
  PRIMARY KEY (anotacao_id, tag_id),
  FOREIGN KEY (usuario_id, anotacao_id) REFERENCES anotacao(usuario_id, id) ON DELETE CASCADE,
  FOREIGN KEY (usuario_id, tag_id)      REFERENCES tag(usuario_id, id)      ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================================
-- 9. NOTIFICAÇÕES (o celular agenda os lembretes localmente; aqui ficam o histórico e o push)
-- ============================================================================

CREATE TABLE notificacao (
  id               CHAR(36) NOT NULL PRIMARY KEY,
  usuario_id       CHAR(36) NOT NULL,
  tipo             ENUM('lembrete_evento','lembrete_aula_campo','lembrete_entrega','lembrete_registro_pos_campo') NOT NULL,
  titulo           VARCHAR(160) NOT NULL,
  texto            VARCHAR(500),
  referencia_tipo  VARCHAR(30),
  referencia_id    CHAR(36),
  agendada_para    DATETIME(3) NOT NULL,
  enviada_em       DATETIME(3),
  lida_em          DATETIME(3),
  cancelada_em     DATETIME(3),
  criado_em        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY notificacao_pendentes (enviada_em, cancelada_em, agendada_para),
  KEY notificacao_usuario (usuario_id, criado_em),
  FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================================
-- 10. MERCADO (dado público, sem usuario_id)
-- ============================================================================

CREATE TABLE mercado_cotacao (
  id             BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  produto        ENUM('soja','milho') NOT NULL,
  cidade         VARCHAR(80) NOT NULL,
  data           DATE NOT NULL,
  preco          DECIMAL(10,2) NOT NULL,
  variacao_pct   DECIMAL(6,2),
  atualizado_em  DATETIME(3),
  UNIQUE KEY (produto, cidade, data)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE mercado_cache (
  chave          VARCHAR(120) NOT NULL PRIMARY KEY,         -- 'resumo:Palmas-TO', 'noticias', 'clima:-10.25:-48.32'
  conteudo       JSON NOT NULL,
  expira_em      DATETIME(3) NOT NULL,
  atualizado_em  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================================
-- 11. SINCRONIZAÇÃO
-- ============================================================================

-- log de mudanças: o "cursor" do celular é o seq
CREATE TABLE mudanca (
  seq          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  usuario_id   CHAR(36) NOT NULL,
  entidade     VARCHAR(30) NOT NULL,
  entidade_id  CHAR(36) NOT NULL,
  operacao     ENUM('upsert','excluir') NOT NULL,
  versao       INT,
  criado_em    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY mudanca_usuario_seq (usuario_id, seq),
  FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- operações já processadas (idempotência do POST /sync/enviar)
CREATE TABLE operacao_sync (
  usuario_id      CHAR(36) NOT NULL,
  id_operacao     CHAR(36) NOT NULL,
  dispositivo_id  CHAR(36),
  resultado       JSON NOT NULL,
  criado_em       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (usuario_id, id_operacao),
  FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================================
-- 12. BUSCA DE TEXTO
--  Uma tabela com índice FULLTEXT. A collation utf8mb4_0900_ai_ci ignora acento e maiúsculas.
--  A API atualiza esta tabela quando grava/apaga anotação, relatório, registro, matéria e evento
--  (no código, junto da mesma transação; sem trigger, para ficar simples de testar).
-- ============================================================================

CREATE TABLE busca_indice (
  usuario_id   CHAR(36) NOT NULL,
  entidade     ENUM('anotacao','relatorio','registro','materia','evento') NOT NULL,
  entidade_id  CHAR(36) NOT NULL,
  titulo       VARCHAR(190) NOT NULL DEFAULT '',
  corpo        MEDIUMTEXT,
  PRIMARY KEY (entidade, entidade_id),
  KEY busca_usuario (usuario_id),
  FULLTEXT KEY busca_texto (titulo, corpo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Exemplo:
--   SELECT entidade, entidade_id, titulo,
--          MATCH(titulo, corpo) AGAINST (:termo IN BOOLEAN MODE) AS pontos
--   FROM busca_indice
--   WHERE usuario_id = :u AND MATCH(titulo, corpo) AGAINST (:termo IN BOOLEAN MODE)
--   ORDER BY pontos DESC LIMIT 50;      -- termo com prefixo: 'praga*'

-- ============================================================================
-- 13. TRIGGERS: atualizado_em e versao
--  A versão só sobe quando quem atualiza NÃO mexeu na coluna versao.
--  (Ao gravar uma operação vinda da sync, a API confere versao_base e deixa o trigger subir.)
-- ============================================================================

DELIMITER $$
CREATE TRIGGER usuario_bu BEFORE UPDATE ON usuario FOR EACH ROW BEGIN
  IF NEW.versao = OLD.versao THEN SET NEW.versao = OLD.versao + 1; SET NEW.atualizado_em = CURRENT_TIMESTAMP(3); END IF; END$$
CREATE TRIGGER periodo_bu BEFORE UPDATE ON periodo FOR EACH ROW BEGIN
  IF NEW.versao = OLD.versao THEN SET NEW.versao = OLD.versao + 1; SET NEW.atualizado_em = CURRENT_TIMESTAMP(3); END IF; END$$
CREATE TRIGGER professor_bu BEFORE UPDATE ON professor FOR EACH ROW BEGIN
  IF NEW.versao = OLD.versao THEN SET NEW.versao = OLD.versao + 1; SET NEW.atualizado_em = CURRENT_TIMESTAMP(3); END IF; END$$
CREATE TRIGGER materia_bu BEFORE UPDATE ON materia FOR EACH ROW BEGIN
  IF NEW.versao = OLD.versao THEN SET NEW.versao = OLD.versao + 1; SET NEW.atualizado_em = CURRENT_TIMESTAMP(3); END IF; END$$
CREATE TRIGGER relatorio_bu BEFORE UPDATE ON relatorio FOR EACH ROW BEGIN
  IF NEW.versao = OLD.versao THEN SET NEW.versao = OLD.versao + 1; SET NEW.atualizado_em = CURRENT_TIMESTAMP(3); END IF; END$$
CREATE TRIGGER registro_bu BEFORE UPDATE ON registro FOR EACH ROW BEGIN
  IF NEW.versao = OLD.versao THEN SET NEW.versao = OLD.versao + 1; SET NEW.atualizado_em = CURRENT_TIMESTAMP(3); END IF; END$$
CREATE TRIGGER registro_pendencia_bu BEFORE UPDATE ON registro_pendencia FOR EACH ROW BEGIN
  IF NEW.versao = OLD.versao THEN SET NEW.versao = OLD.versao + 1; SET NEW.atualizado_em = CURRENT_TIMESTAMP(3); END IF; END$$
CREATE TRIGGER evento_bu BEFORE UPDATE ON evento FOR EACH ROW BEGIN
  IF NEW.versao = OLD.versao THEN SET NEW.versao = OLD.versao + 1; SET NEW.atualizado_em = CURRENT_TIMESTAMP(3); END IF; END$$
CREATE TRIGGER anotacao_bu BEFORE UPDATE ON anotacao FOR EACH ROW BEGIN
  IF NEW.versao = OLD.versao THEN SET NEW.versao = OLD.versao + 1; SET NEW.atualizado_em = CURRENT_TIMESTAMP(3); END IF; END$$
CREATE TRIGGER foto_bu BEFORE UPDATE ON foto FOR EACH ROW BEGIN
  IF NEW.versao = OLD.versao THEN SET NEW.versao = OLD.versao + 1; SET NEW.atualizado_em = CURRENT_TIMESTAMP(3); END IF; END$$
CREATE TRIGGER audio_bu BEFORE UPDATE ON audio FOR EACH ROW BEGIN
  IF NEW.versao = OLD.versao THEN SET NEW.versao = OLD.versao + 1; SET NEW.atualizado_em = CURRENT_TIMESTAMP(3); END IF; END$$
DELIMITER ;
