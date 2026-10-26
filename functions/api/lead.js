// POST /api/lead — recebe o formulário da LP e grava na caixa de entrada.
// Público, mas nunca devolve dados de leads: só {ok, id} ou {erro}.
import { CAMPOS_RASTREIO, agoraISO, dentroDoLimite, json, registrar } from '../../lib/caixa.js';

const TAMANHO_MAXIMO = 10 * 1024;

const recusar = (motivo, status, erro = motivo) => {
  registrar('lead_recusado', { motivo });
  return json({ erro }, status);
};

const texto = (valor, max) => {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== 'string') return undefined;
  const t = valor.trim();
  if (t.length > max) return undefined;
  return t || null;
};

const verificarTurnstile = async (env, token, ip) => {
  const corpo = new FormData();
  corpo.append('secret', env.TURNSTILE_SECRET);
  corpo.append('response', token);
  if (ip) corpo.append('remoteip', ip);
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: corpo });
  const resultado = await resp.json().catch(() => ({}));
  return resultado.success === true;
};

export const onRequestPost = async ({ request, env }) => {
  const url = new URL(request.url);

  // Só aceita envios feitos a partir do próprio site (mesmo domínio).
  const origem = request.headers.get('Origin');
  let hostOrigem = '';
  try { hostOrigem = new URL(origem).host; } catch {}
  if (!origem || hostOrigem !== url.host) return recusar('origem', 403, 'origem_invalida');

  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return recusar('formato', 415, 'dados_invalidos');
  if (Number(request.headers.get('Content-Length') || 0) > TAMANHO_MAXIMO) return recusar('tamanho', 413, 'dados_invalidos');
  const bruto = await request.text();
  if (bruto.length > TAMANHO_MAXIMO) return recusar('tamanho', 413, 'dados_invalidos');

  let dados;
  try { dados = JSON.parse(bruto); } catch { return recusar('json', 400, 'dados_invalidos'); }
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) return recusar('json', 400, 'dados_invalidos');

  // Campo isca: pessoas não veem; robôs costumam preencher.
  if (typeof dados.website === 'string' && dados.website.trim() !== '') return recusar('isca', 400, 'dados_invalidos');

  const nome = texto(dados.nome, 120);
  const telefone = texto(dados.telefone, 30);
  const email = texto(dados.email, 200);
  const empresa = texto(dados.empresa, 120);
  const mensagem = texto(dados.mensagem, 500);
  const versaoTexto = texto(dados.consentimento?.versao_texto, 100);
  const digitos = (telefone || '').replace(/\D/g, '').length;
  if (!nome || nome.length < 2) return recusar('nome', 400, 'dados_invalidos');
  if (!telefone || digitos < 10) return recusar('telefone', 400, 'dados_invalidos');
  if (email === undefined || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return recusar('email', 400, 'dados_invalidos');
  if (empresa === undefined || mensagem === undefined) return recusar('campo', 400, 'dados_invalidos');
  if (!versaoTexto) return recusar('consentimento', 400, 'dados_invalidos');

  const rastreio = {};
  for (const [campo, max] of Object.entries(CAMPOS_RASTREIO)) {
    const valor = texto(dados[campo], max);
    rastreio[campo] = valor === undefined ? null : valor; // valor estranho vira vazio, nunca inventado
  }

  if (!env.TURNSTILE_SECRET || !env.DB) return recusar('configuracao', 503, 'indisponivel');

  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!(await dentroDoLimite(env, ip))) return recusar('limite', 429, 'muitos_envios');

  const token = typeof dados.turnstile === 'string' ? dados.turnstile : '';
  if (!token || token.length > 2048 || !(await verificarTurnstile(env, token, ip))) return recusar('turnstile', 403, 'verificacao_falhou');

  const id = crypto.randomUUID();
  const agora = agoraISO();
  try {
    await env.DB.prepare(
      `INSERT INTO leads (id, recebido_em, nome, telefone, email, empresa, mensagem,
         utm_source, utm_medium, utm_campaign, utm_content, utm_term,
         campaign_id, adset_id, ad_id, fbclid, pagina, referrer,
         consentimento_aceito_em, consentimento_versao_texto)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)`,
    ).bind(
      id, agora, nome, telefone, email, empresa, mensagem,
      rastreio.utm_source, rastreio.utm_medium, rastreio.utm_campaign, rastreio.utm_content, rastreio.utm_term,
      rastreio.campaign_id, rastreio.adset_id, rastreio.ad_id, rastreio.fbclid, rastreio.pagina, rastreio.referrer,
      agora, versaoTexto,
    ).run();
  } catch {
    return recusar('gravacao', 500, 'falha_ao_gravar');
  }

  registrar('lead_aceito');
  return json({ ok: true, id });
};

// Qualquer outro método: 405 (e nunca cai na página do site).
export const onRequest = () => json({ erro: 'metodo_nao_permitido' }, 405, { Allow: 'POST' });
