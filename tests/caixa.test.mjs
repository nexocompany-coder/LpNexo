// Testes da caixa de entrada (dados falsos). Precisam de dois servidores locais:
//   8788: Turnstile de teste que sempre aprova
//   8789: Turnstile de teste que sempre recusa, limite de 3 envios por hora
// Rode com: npm test   (o token vem do .dev.vars, que não vai para o git)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const OK = 'http://127.0.0.1:8788';
const FALHA = 'http://127.0.0.1:8789';
const TOKEN = /INBOX_TOKEN=(\S+)/.exec(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8'))[1];
const auth = { Authorization: `Bearer ${TOKEN}` };

const leadFalso = (extra = {}) => ({
  nome: 'Teste Falso',
  telefone: '+55 (11) 90000-0000',
  email: 'teste@exemplo.invalid',
  empresa: '@loja_teste_falsa',
  mensagem: 'Carros por mês: 8 a 15',
  turnstile: 'XXXX.DUMMY.TOKEN.XXXX',
  website: '',
  consentimento: { versao_texto: 'v1-2026-10-25' },
  ...extra,
});

const enviar = (base, corpo, headers = {}) =>
  fetch(`${base}/api/lead`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
    body: JSON.stringify(corpo),
  });

const caixa = async (query = '') => (await fetch(`${OK}/api/inbox${query}`, { headers: auth })).json();

before(() => {
  // Começa com a caixa local vazia (só o banco de teste do seu Mac).
  execSync('npx wrangler d1 execute lpnexo-leads --local --command "DELETE FROM leads; DELETE FROM limite_envios;"', { stdio: 'ignore' });
});

test('envio válido é gravado e só então responde 200', async () => {
  const r = await enviar(OK, leadFalso({ nome: 'Valido Falso', utm_source: 'instagram' }));
  assert.equal(r.status, 200);
  const corpo = await r.json();
  assert.deepEqual(Object.keys(corpo).sort(), ['id', 'ok']);
  const { leads } = await caixa();
  const lead = leads.find((l) => l.id === corpo.id);
  assert.ok(lead, 'lead aparece na caixa');
  assert.equal(lead.nome, 'Valido Falso');
  assert.equal(lead.telefone, '+55 (11) 90000-0000', 'telefone guardado como digitado');
  assert.equal(lead.utm_source, 'instagram');
  assert.equal(lead.utm_medium, null, 'parâmetro ausente fica vazio, nunca inventado');
  assert.equal(lead.consentimento.versao_texto, 'v1-2026-10-25');
  assert.equal(lead.consentimento.aceito_em, lead.recebido_em);
});

test('campos opcionais vazios não impedem o envio', async () => {
  const r = await enviar(OK, leadFalso({ nome: 'Opcional Falso', email: '', empresa: '' }));
  assert.equal(r.status, 200);
});

test('mesma tentativa enviada duas vezes (id_envio igual) grava um lead só', async () => {
  const idEnvio = crypto.randomUUID();
  const r1 = await enviar(OK, leadFalso({ nome: 'Repetido Falso', id_envio: idEnvio }));
  const r2 = await enviar(OK, leadFalso({ nome: 'Repetido Falso', id_envio: idEnvio }));
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal((await r1.json()).id, idEnvio);
  assert.equal((await r2.json()).id, idEnvio);
  const { leads } = await caixa('?limit=200');
  assert.equal(leads.filter((l) => l.nome === 'Repetido Falso').length, 1);
});

test('nome ou telefone faltando é recusado', async () => {
  assert.equal((await enviar(OK, leadFalso({ nome: '' }))).status, 400);
  assert.equal((await enviar(OK, leadFalso({ telefone: '123' }))).status, 400);
});

test('Turnstile inválido é recusado (403) e nada é gravado', async () => {
  const r = await enviar(FALHA, leadFalso({ nome: 'Turnstile Falso' }));
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { erro: 'verificacao_falhou' });
});

test('Turnstile vazio é recusado', async () => {
  assert.equal((await enviar(OK, leadFalso({ turnstile: '' }))).status, 403);
});

test('campo isca preenchido é recusado e nada é gravado', async () => {
  const r = await enviar(OK, leadFalso({ nome: 'Robo Falso', website: 'http://spam.invalid' }));
  assert.equal(r.status, 400);
  const { leads } = await caixa('?limit=200');
  assert.ok(!leads.some((l) => l.nome === 'Robo Falso'));
});

test('envio de outro domínio ou sem Origin é recusado', async () => {
  assert.equal((await enviar(OK, leadFalso(), { Origin: 'https://site-de-terceiro.invalid' })).status, 403);
  const semOrigin = await fetch(`${OK}/api/lead`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(leadFalso()) });
  assert.equal(semOrigin.status, 403);
});

test('envio maior que 10 KB é recusado', async () => {
  assert.equal((await enviar(OK, leadFalso({ mensagem: 'x'.repeat(11000) }))).status, 413);
});

test('limite de envios por origem devolve 429', async () => {
  const status = [];
  for (let i = 0; i < 4; i++) status.push((await enviar(FALHA, leadFalso())).status);
  assert.deepEqual(status.slice(-1), [429]);
});

test('/api/inbox sem token, com token errado ou com Basic: 401 sem dados', async () => {
  for (const headers of [{}, { Authorization: 'Bearer errado' }, { Authorization: `Basic ${TOKEN}` }]) {
    const r = await fetch(`${OK}/api/inbox`, { headers });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { erro: 'nao_autorizado' });
  }
  const ack = await fetch(`${OK}/api/inbox/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ids":[]}' });
  assert.equal(ack.status, 401);
});

test('nenhuma rota pública devolve dados de lead', async () => {
  for (const [metodo, caminho] of [['GET', '/api/lead'], ['PUT', '/api/lead'], ['DELETE', '/api/inbox'], ['GET', '/api/inbox/ack']]) {
    const r = await fetch(`${OK}${caminho}`, { method: metodo });
    const texto = await r.text();
    assert.ok([401, 405].includes(r.status), `${metodo} ${caminho} -> ${r.status}`);
    assert.ok(!texto.includes('Falso') && !texto.includes('telefone'), `${metodo} ${caminho} não vaza dados`);
  }
});

test('ordem do mais antigo para o mais novo e paginação com tem_mais', async () => {
  const ids = [];
  for (const n of ['Ordem A', 'Ordem B', 'Ordem C']) ids.push((await (await enviar(OK, leadFalso({ nome: n }))).json()).id);
  const tudo = (await caixa('?limit=200')).leads.map((l) => l.id);
  assert.deepEqual(tudo.filter((id) => ids.includes(id)), ids, 'mais antigo primeiro');
  const pagina = await caixa('?limit=2');
  assert.equal(pagina.leads.length, 2);
  assert.equal(pagina.tem_mais, true);
});

test('ack é idempotente, tira da lista de pendentes e a recuperação ainda mostra', async () => {
  const { id } = await (await enviar(OK, leadFalso({ nome: 'Ack Falso' }))).json();
  const ack = () => fetch(`${OK}/api/inbox/ack`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id, id] }) });
  assert.equal((await ack()).status, 200);
  assert.equal((await ack()).status, 200, 'repetir não dá erro');
  const pendentes = (await caixa('?limit=200')).leads;
  assert.ok(!pendentes.some((l) => l.id === id), 'sai dos pendentes');
  const desde = new Date(Date.now() - 3600e3).toISOString();
  const recuperados = (await caixa(`?incluir_recebidos=1&desde=${encodeURIComponent(desde)}&limit=200`)).leads;
  assert.ok(recuperados.some((l) => l.id === id), 'aparece na recuperação');
});

test('recuperação sem data válida responde 400', async () => {
  const r = await fetch(`${OK}/api/inbox?incluir_recebidos=1&desde=ontem`, { headers: auth });
  assert.equal(r.status, 400);
});

test('lead entregue há mais de 7 dias é apagado; pendente antigo nunca é', async () => {
  const velho = new Date(Date.now() - 8 * 864e5).toISOString();
  execSync(`npx wrangler d1 execute lpnexo-leads --local --command "INSERT INTO leads (id, recebido_em, nome, telefone, consentimento_aceito_em, consentimento_versao_texto, entregue_em) VALUES ('00000000-0000-4000-8000-000000000001','${velho}','Velho Entregue','11900000000','${velho}','v1','${velho}'), ('00000000-0000-4000-8000-000000000002','${velho}','Velho Pendente','11900000000','${velho}','v1',NULL)"`, { stdio: 'ignore' });
  const desde = new Date(Date.now() - 30 * 864e5).toISOString();
  const nomes = (await caixa(`?incluir_recebidos=1&desde=${encodeURIComponent(desde)}&limit=200`)).leads.map((l) => l.nome);
  assert.ok(!nomes.includes('Velho Entregue'), 'entregue há 8 dias foi apagado');
  assert.ok(nomes.includes('Velho Pendente'), 'pendente continua');
});
