# LP Nexo

Landing page da Nexo (lpnexo.com.br), publicada pelo Cloudflare Pages a partir deste repositório.

## Como funciona

```
Visitante preenche o formulário
        │  POST /api/lead  (Turnstile + campo isca + limite de envios)
        ▼
Caixa de entrada (banco D1 na Cloudflare) ──► aviso no grupo do Telegram (em segundo plano)
        │  GET /api/inbox  e  POST /api/inbox/ack  (exigem o token)
        ▼
CRM no Mac busca os leads e confirma o recebimento
```

- `public/` é o site (só esta pasta é publicada).
- `functions/api/` são as rotas da caixa de entrada; `lib/caixa.js` é o código comum.
- `migrations/` cria as tabelas do banco.
- O lead só aparece como "Recebemos seus dados" depois de gravado (resposta 200).
- Leads confirmados pelo CRM são apagados 7 dias depois. Pendentes nunca são apagados.
- O IP do visitante não é gravado (só um código embaralhado para limitar envios).

## Configurações públicas (em `public/index.html`, objeto `window.NEXO`)

| Campo | O que é |
|---|---|
| `metaPixelId` | ID do Pixel da Meta. Vazio = Pixel desligado |
| `whatsappNumero` | Número do botão "Falar no WhatsApp" (só dígitos, com 55) |
| `whatsappMensagem` | Mensagem pronta do botão |
| `turnstileSiteKey` | Chave pública do widget Turnstile |

## Segredos (nunca vão para o git)

Ficam no painel: **Workers & Pages → projeto → Settings → Variables and Secrets** (Production e Preview).

| Nome | Para que serve |
|---|---|
| `TURNSTILE_SECRET` | Chave secreta do Turnstile |
| `INBOX_TOKEN` | Token que o CRM usa para ler a caixa (mínimo 32 caracteres) |
| `RATE_SALT` | Segredo usado no código embaralhado do IP |
| `TELEGRAM_BOT_TOKEN` | Token do bot que avisa lead novo (vem do @BotFather) |
| `TELEGRAM_CHAT_ID` | Id do grupo do Telegram que recebe o aviso |

**Depois de gravar ou trocar qualquer segredo, é preciso uma nova publicação de PRODUÇÃO**
(Deployments → ⋯ → Retry deployment, ou um envio novo na `main`) para ele valer.

## Aviso de lead novo no Telegram (`lib/aviso.js`)

- Sai logo depois de gravar o lead, em segundo plano (`waitUntil`): o formulário nunca espera
  o Telegram nem quebra por causa dele.
- Só para lead **novo**: o mesmo envio repetido (mesmo `id_envio`) não gera outro aviso.
- No grupo vão nome, carros por mês, Instagram, origem (as mesmas regras do CRM), horário de
  Brasília e o botão "Chamar no WhatsApp". **E-mail e consentimento não vão.**
- Telegram fora do ar, token ou grupo errado: o lead continua gravado e o log mostra só
  `aviso_telegram_falhou` com o código, sem dados pessoais.
- Sem `TELEGRAM_BOT_TOKEN` ou `TELEGRAM_CHAT_ID`: a LP funciona normal, só sem aviso.

### Trocar o token do CRM

1. No Terminal do Mac: `openssl rand -hex 32` (gera um token novo; copie para o gerenciador de senhas).
2. No painel, edite `INBOX_TOKEN` e cole o novo valor (tipo **Secret**).
3. Faça um novo deploy (Deployments → ⋯ → Retry deployment) para valer.
4. Atualize o token no CRM. O token antigo para de funcionar.

## Ver a caixa de entrada (sem colar o token em lugar nenhum)

No Terminal do Mac:

```sh
read -s "TOKEN?Cole o token e aperte Enter: "
curl -s -H "Authorization: Bearer $TOKEN" "https://lpnexo.com.br/api/inbox?limit=10" | python3 -m json.tool
unset TOKEN
```

- Recuperar leads já entregues: troque o endereço por
  `https://lpnexo.com.br/api/inbox?incluir_recebidos=1&desde=2026-10-01T00:00:00Z`
- Confirmar (ack) um lead: `curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"ids":["ID-DO-LEAD"]}' https://lpnexo.com.br/api/inbox/ack`

## Links de rastreamento

- Bio do Instagram: `https://lpnexo.com.br/?utm_source=instagram&utm_medium=bio&utm_campaign=link-da-bio`
- Anúncios (campo "Parâmetros de URL" do anúncio):
  `utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}`

## Testar no Mac

```sh
npm install
npm run db:local        # cria o banco local (uma vez)
npm run dev             # http://127.0.0.1:8788 com formulário e caixa funcionando
npm test                # testes da caixa (precisa também da instância de falha na porta 8789)
node --test tests/aviso.test.mjs   # só os testes do aviso no Telegram (não precisam de servidor)
```

O arquivo `.dev.vars` (não vai para o git) guarda os segredos de teste locais:
`TURNSTILE_SECRET=1x0000000000000000000000000000000AA` (chave de teste da Cloudflare), `INBOX_TOKEN` e `RATE_SALT` falsos.

`node serve.mjs` serve só a parte visual (`public/`), sem o formulário funcionar.

## Consentimento

O formulário mostra: "Garantimos a segurança total de seus dados. Serão usados apenas para contato."
Cada lead guarda a versão desse texto (`v1-2026-10-25`) e o horário do envio. Se o texto mudar,
troque `VERSAO_CONSENTIMENTO` em `public/index.html`.
