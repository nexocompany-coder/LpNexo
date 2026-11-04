// Testes do aviso no Telegram. Rodam sozinhos, sem servidor: o banco, o
// Turnstile e o Telegram são falsos (o fetch é trocado dentro do teste).
//   node --test tests/aviso.test.mjs
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/lead.js';
import { carrosPorMes, horarioDeBrasilia, linkDoWhatsApp, montarAviso, origemLegivel } from '../lib/aviso.js';

const SITE = 'https://lpnexo.com.br';
const SEGREDOS = { TELEGRAM_BOT_TOKEN: '123456:token-falso-de-teste', TELEGRAM_CHAT_ID: '-1001234567890' };

// Banco falso: guarda os ids gravados e responde como o D1.
const bancoFalso = () => {
  const ids = new Set();
  return {
    ids,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => ({ contagem: 1 }), // limite de envios
            run: async () => {
              if (!sql.includes('INSERT INTO leads')) return { meta: { changes: 0 } };
              const novo = !ids.has(args[0]);
              ids.add(args[0]);
              return { meta: { changes: novo ? 1 : 0 } };
            },
          };
        },
      };
    },
  };
};

let chamadasAoTelegram;
let comportamentoDoTelegram;
let logs;
const fetchOriginal = globalThis.fetch;
const logOriginal = console.log;

beforeEach(() => {
  chamadasAoTelegram = [];
  comportamentoDoTelegram = 'ok';
  logs = [];
  console.log = (linha) => logs.push(String(linha));
  globalThis.fetch = async (url, opcoes = {}) => {
    const endereco = String(url);
    if (endereco.includes('challenges.cloudflare.com')) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (endereco.startsWith('https://api.telegram.org/')) {
      chamadasAoTelegram.push({ endereco, corpo: JSON.parse(opcoes.body) });
      if (comportamentoDoTelegram === 'rede') throw new TypeError('fetch failed');
      if (comportamentoDoTelegram === '500') return new Response('{"ok":false}', { status: 500 });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    throw new Error(`endereço inesperado no teste: ${endereco}`);
  };
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  console.log = logOriginal;
});

const leadFalso = (extra = {}) => ({
  nome: 'Fulano Falso',
  telefone: '(11) 98888-7777',
  email: 'fulano@exemplo.invalid',
  empresa: '@loja_falsa',
  mensagem: 'Carros por mês: 8 a 15',
  turnstile: 'XXXX.DUMMY.TOKEN.XXXX',
  website: '',
  consentimento: { versao_texto: 'v1-2026-10-25' },
  utm_source: 'meta',
  utm_medium: 'paid_social',
  utm_campaign: 'Seminovos SP',
  ...extra,
});

// Chama o /api/lead como a Cloudflare chamaria, guardando o que foi para o waitUntil.
const enviar = async (env, corpo) => {
  const pendentes = [];
  const request = new Request(`${SITE}/api/lead`, {
    method: 'POST',
    headers: { Origin: SITE, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
    body: JSON.stringify(corpo),
  });
  const resposta = await onRequestPost({ request, env, waitUntil: (p) => pendentes.push(p) });
  return { resposta, emSegundoPlano: () => Promise.all(pendentes) };
};

const ambiente = (extra = {}) => ({ DB: bancoFalso(), TURNSTILE_SECRET: 'segredo-falso', ...SEGREDOS, ...extra });

test('envio ok: grava, responde 200 e manda um aviso completo ao grupo', async () => {
  const env = ambiente();
  const { resposta, emSegundoPlano } = await enviar(env, leadFalso());
  assert.equal(resposta.status, 200);
  const { id } = await resposta.json();
  assert.ok(env.DB.ids.has(id), 'lead gravado');

  await emSegundoPlano();
  assert.equal(chamadasAoTelegram.length, 1);
  const { endereco, corpo } = chamadasAoTelegram[0];
  assert.match(endereco, /\/sendMessage$/);
  assert.equal(corpo.chat_id, SEGREDOS.TELEGRAM_CHAT_ID);
  assert.match(corpo.text, /🔥 <b>Novo lead: Fulano Falso<\/b>/);
  assert.match(corpo.text, /Carros por mês: 8 a 15/);
  assert.match(corpo.text, /Instagram: @loja_falsa/);
  assert.match(corpo.text, /Origem: Meta Ads · Seminovos SP/);
  assert.match(corpo.text, /horário de Brasília/);
  assert.equal(corpo.reply_markup.inline_keyboard[0][0].url, 'https://wa.me/5511988887777');

  // O que nunca pode ir para o grupo.
  assert.doesNotMatch(corpo.text, /fulano@exemplo/);
  assert.doesNotMatch(corpo.text, /v1-2026-10-25|consentimento/i);
  assert.ok(logs.some((l) => l.includes('aviso_telegram_enviado')));
});

test('a resposta do formulário não espera o Telegram', async () => {
  const env = ambiente();
  let liberarTelegram;
  const anterior = globalThis.fetch;
  globalThis.fetch = async (url, opcoes) => {
    if (String(url).startsWith('https://api.telegram.org/')) {
      await new Promise((r) => (liberarTelegram = r)); // Telegram "lento"
    }
    return anterior(url, opcoes);
  };
  const { resposta, emSegundoPlano } = await enviar(env, leadFalso());
  assert.equal(resposta.status, 200, 'respondeu com o Telegram ainda pendente');
  liberarTelegram();
  await emSegundoPlano();
});

for (const falha of ['rede', '500']) {
  test(`Telegram fora do ar (${falha}): formulário ok, lead gravado, log sem dados pessoais`, async () => {
    comportamentoDoTelegram = falha;
    const env = ambiente();
    const { resposta, emSegundoPlano } = await enviar(env, leadFalso());
    assert.equal(resposta.status, 200);
    assert.equal((await resposta.json()).ok, true);
    assert.equal(env.DB.ids.size, 1);
    await emSegundoPlano(); // não pode estourar erro

    const linha = logs.find((l) => l.includes('aviso_telegram_falhou'));
    assert.ok(linha, 'falha registrada no log');
    for (const pessoal of ['Fulano', '98888', 'loja_falsa', 'fulano@', 'token-falso']) {
      assert.ok(!logs.join('\n').includes(pessoal), `log não pode ter "${pessoal}"`);
    }
  });
}

test('sem os segredos do Telegram: formulário normal e nenhum aviso', async () => {
  for (const faltando of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    chamadasAoTelegram = [];
    const env = ambiente({ [faltando]: undefined });
    const { resposta, emSegundoPlano } = await enviar(env, leadFalso());
    assert.equal(resposta.status, 200);
    await emSegundoPlano();
    assert.equal(chamadasAoTelegram.length, 0, `sem ${faltando}, nada é enviado`);
  }
});

test('o mesmo lead (mesmo id_envio) enviado duas vezes gera um aviso só', async () => {
  const env = ambiente();
  const idEnvio = crypto.randomUUID();
  const r1 = await enviar(env, leadFalso({ id_envio: idEnvio }));
  const r2 = await enviar(env, leadFalso({ id_envio: idEnvio }));
  assert.equal(r1.resposta.status, 200);
  assert.equal(r2.resposta.status, 200);
  await r1.emSegundoPlano();
  await r2.emSegundoPlano();
  assert.equal(chamadasAoTelegram.length, 1);
});

test('envio recusado (nome faltando) não gera aviso', async () => {
  const env = ambiente();
  const { resposta, emSegundoPlano } = await enviar(env, leadFalso({ nome: '' }));
  assert.equal(resposta.status, 400);
  await emSegundoPlano();
  assert.equal(chamadasAoTelegram.length, 0);
});

test('origem legível: as mesmas regras do CRM', () => {
  assert.equal(origemLegivel({ utm_source: 'Meta', utm_medium: 'PAID_SOCIAL', utm_campaign: 'Black' }), 'Meta Ads · Black');
  assert.equal(origemLegivel({ utm_source: 'facebook', utm_medium: 'paid_social' }), 'Meta Ads');
  assert.equal(origemLegivel({ utm_source: 'instagram', utm_medium: 'bio' }), 'Instagram - link da bio');
  assert.equal(origemLegivel({ fbclid: 'abc' }), 'Meta (sem UTM)');
  assert.equal(origemLegivel({}), 'LP - origem não identificada');
  assert.equal(origemLegivel({ utm_source: 'google', utm_medium: 'cpc' }), 'google / cpc');
  assert.equal(origemLegivel({ utm_source: 'newsletter' }), 'newsletter / sem dado');
});

test('link do WhatsApp: 55 na frente, nono dígito mantido, nada inventado', () => {
  assert.equal(linkDoWhatsApp('(11) 98888-7777'), 'https://wa.me/5511988887777');
  assert.equal(linkDoWhatsApp('+55 11 98888-7777'), 'https://wa.me/5511988887777');
  assert.equal(linkDoWhatsApp('11 3333-4444'), 'https://wa.me/551133334444');
  assert.equal(linkDoWhatsApp('999'), null);
  assert.equal(linkDoWhatsApp('+1 415 555 0100 22'), null);
});

test('carros por mês, horário de Brasília e nome com símbolos', () => {
  assert.equal(carrosPorMes('Carros por mês: 15 a 30'), '15 a 30');
  assert.equal(carrosPorMes(''), 'sem dado');
  assert.equal(horarioDeBrasilia('2026-11-03T17:05:00.000Z'), '03/11 às 14:05');

  const aviso = montarAviso(
    { nome: '<b>Ana</b> & Cia', telefone: '999', empresa: '', mensagem: null },
    '2026-11-03T17:05:00.000Z',
  );
  assert.match(aviso.text, /Novo lead: &lt;b&gt;Ana&lt;\/b&gt; &amp; Cia/);
  assert.match(aviso.text, /Instagram: sem dado/);
  assert.match(aviso.text, /Carros por mês: sem dado/);
  assert.equal(aviso.reply_markup, undefined, 'telefone impossível: sem botão');
});
