// Teste de ponta a ponta no navegador (Chrome sem janela), com dados falsos.
// Abre a LP com cada tipo de link, preenche o formulário, envia e confere a caixa.
// Rode com os servidores locais ligados: node tests/navegador.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OK = 'http://127.0.0.1:8788';
const FALHA = 'http://127.0.0.1:8789';
const TOKEN = /INBOX_TOKEN=(\S+)/.exec(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8'))[1];
const PASTA_PRINTS = process.env.PRINTS || tmpdir();
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'lp-teste-'))}`, '--window-size=448,900', 'about:blank'], { stdio: 'ignore' });

const conectar = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      const alvos = await (await fetch('http://127.0.0.1:9333/json')).json();
      const pagina = alvos.find((a) => a.type === 'page');
      if (pagina) return pagina.webSocketDebuggerUrl;
    } catch {}
    await espera(200);
  }
  throw new Error('Chrome não respondeu');
};

const ws = new WebSocket(await conectar());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pendentes = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pendentes.has(msg.id)) { pendentes.get(msg.id)(msg); pendentes.delete(msg.id); }
});
const cdp = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pendentes.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const avaliar = async (expressao) => (await cdp('Runtime.evaluate', { expression: expressao, awaitPromise: true, returnByValue: true })).result?.result?.value;

const abrir = async (url) => {
  await cdp('Page.navigate', { url });
  for (let i = 0; i < 100; i++) {
    if (await avaliar(`document.readyState === 'complete' && !!window.turnstile && document.querySelectorAll('.lead-form').length === 2`)) return;
    await espera(200);
  }
  throw new Error('página não carregou');
};

const preencherEEnviar = async ({ nome, carros, whatsappTeste }) => {
  await avaliar(`(() => {
    ${whatsappTeste ? `NEXO.whatsappNumero = '5500000000000'; NEXO.whatsappMensagem = 'Mensagem de teste';` : ''}
    window.__abriuSozinho = false; window.open = () => { window.__abriuSozinho = true; };
    const f = document.querySelector('.lead-form');
    const set = (n, v) => { f.elements[n].value = v; f.elements[n].dispatchEvent(new Event('input', { bubbles: true })); };
    set('nome', ${JSON.stringify(nome)});
    set('email', 'teste@exemplo.invalid');
    set('instagram', '@loja_teste_falsa');
    set('whatsapp', '11900000000');
    f.elements.carros_mes.value = ${JSON.stringify(carros)};
    f.requestSubmit();
  })()`);
  for (let i = 0; i < 100; i++) {
    const estado = await avaliar(`(() => {
      const card = document.querySelector('.lead-form').parentElement;
      const painel = card.querySelector('[role=status]:not([data-status])');
      const erro = card.querySelector('[data-status]');
      return painel ? { resultado: 'sucesso', texto: painel.innerText.trim(), whatsapp: painel.querySelector('a')?.href || null, abriuSozinho: window.__abriuSozinho, url: location.href }
        : erro && erro.innerText.trim() && !erro.className.includes('hidden') ? { resultado: 'erro', texto: erro.innerText.trim(), whatsapp: erro.querySelector('a')?.href || null } : null;
    })()`);
    if (estado) return estado;
    await espera(200);
  }
  return { resultado: 'sem resposta' };
};

const print = async (nome) => {
  await avaliar(`document.querySelector('.lead-form').parentElement.scrollIntoView({ block: 'center' })`);
  await espera(400);
  const { result } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(PASTA_PRINTS, `${nome}.png`), Buffer.from(result.data, 'base64'));
};

await cdp('Page.enable');
await cdp('Runtime.enable');

const cenarios = [
  { nome: 'Bio Falso', carros: '8 a 15', url: `${OK}/?utm_source=instagram&utm_medium=bio&utm_campaign=link-da-bio`, whatsappTeste: true },
  { nome: 'Anuncio Falso', carros: '20 a 30', url: `${OK}/?utm_source=meta&utm_medium=paid_social&utm_campaign=Campanha%20Falsa&utm_term=Conjunto%20Falso&utm_content=Anuncio%20Falso&campaign_id=111111111111111&adset_id=222222222222222&ad_id=333333333333333&fbclid=FAKEfbclid123` },
  { nome: 'Sem Parametros Falso', carros: 'Acima de 40', url: `${OK}/` },
];

const resultados = [];
for (const c of cenarios) {
  // Sessão nova a cada cenário (como uma pessoa diferente)
  await cdp('Storage.clearDataForOrigin', { origin: OK, storageTypes: 'all' });
  await abrir(c.url);
  const r = await preencherEEnviar(c);
  if (c.whatsappTeste) await print('sucesso-com-whatsapp');
  resultados.push({ cenario: c.nome, ...r });
}

// Navegação dentro da sessão: chega pelo anúncio, recarrega sem parâmetros e envia
await cdp('Storage.clearDataForOrigin', { origin: OK, storageTypes: 'all' });
await abrir(`${OK}/?utm_source=meta&utm_medium=paid_social&utm_campaign=Sessao%20Falsa&ad_id=444444444444444`);
await abrir(`${OK}/#aviso`);
resultados.push({ cenario: 'Sessao Falso (anúncio, depois página sem parâmetros)', ...(await preencherEEnviar({ nome: 'Sessao Falso', carros: '0 a 8' })) });

// Falha na gravação/verificação: precisa mostrar erro e o WhatsApp, nunca "Recebemos"
await abrir(`${FALHA}/?utm_source=instagram`);
const falha = await preencherEEnviar({ nome: 'Falha Falso', carros: '8 a 15', whatsappTeste: true });
await print('erro-com-whatsapp');
resultados.push({ cenario: 'Falha (Turnstile recusa)', ...falha });

const caixa = await (await fetch(`${OK}/api/inbox?limit=200`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
console.log(JSON.stringify({ resultados, caixa }, null, 2));

ws.close();
chrome.kill();
