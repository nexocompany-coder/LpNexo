-- Configurações que a própria LP descobre sozinha (não são segredos).
-- Hoje: o novo id do grupo do Telegram quando o grupo vira supergrupo.
-- A chave leva o id antigo (o do TELEGRAM_CHAT_ID), então trocar o segredo
-- para outro grupo ignora o que estiver guardado aqui.

CREATE TABLE configuracao (
  chave         TEXT PRIMARY KEY,
  valor         TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
