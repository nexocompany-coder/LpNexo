-- Caixa de entrada de leads da LP.
-- Um lead fica "pendente" (entregue_em vazio) até o CRM confirmar (ack).
-- Leads entregues há mais de 7 dias são apagados automaticamente pela API.

CREATE TABLE leads (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,      -- ordem de chegada
  id TEXT NOT NULL UNIQUE,                    -- uuid enviado ao CRM
  recebido_em TEXT NOT NULL,                  -- ISO 8601 em UTC
  nome TEXT NOT NULL,
  telefone TEXT NOT NULL,                     -- como foi digitado
  email TEXT,
  empresa TEXT,
  mensagem TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  campaign_id TEXT,
  adset_id TEXT,
  ad_id TEXT,
  fbclid TEXT,
  pagina TEXT,
  referrer TEXT,
  consentimento_aceito_em TEXT NOT NULL,
  consentimento_versao_texto TEXT NOT NULL,
  entregue_em TEXT                            -- preenchido pelo ack do CRM
);

CREATE INDEX idx_leads_pendentes ON leads (entregue_em, seq);
CREATE INDEX idx_leads_recebido ON leads (recebido_em, seq);

-- Limite de envios por origem. "chave" é um hash do IP com um segredo
-- que muda a cada dia: o IP em si nunca é gravado.
CREATE TABLE limite_envios (
  chave TEXT NOT NULL,
  janela TEXT NOT NULL,                       -- hora em UTC (AAAA-MM-DDTHH)
  contagem INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chave, janela)
);
