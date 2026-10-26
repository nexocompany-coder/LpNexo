// Código compartilhado pelas rotas /api/lead e /api/inbox.

export const RETENCAO_DIAS = 7;

// Campos de rastreamento aceitos do formulário (todos opcionais).
export const CAMPOS_RASTREIO = {
  utm_source: 300, utm_medium: 300, utm_campaign: 300, utm_content: 300, utm_term: 300,
  campaign_id: 100, adset_id: 100, ad_id: 100, fbclid: 500,
  pagina: 1000, referrer: 1000,
};

const SEM_CACHE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export const json = (corpo, status = 200, extra = {}) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SEM_CACHE, ...extra },
  });

// Log sem dados pessoais: só o evento e o motivo.
export const registrar = (evento, detalhes = {}) => console.log(JSON.stringify({ evento, ...detalhes }));

const agoraISO = () => new Date().toISOString();

// Comparação em tempo constante (não revela o token por diferença de tempo).
const iguais = async (a, b) => {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
};

// Rotas do CRM: exigem "Authorization: Bearer <INBOX_TOKEN>".
// Sem token configurado no servidor, ninguém entra.
export const autorizado = async (request, env) => {
  const esperado = env.INBOX_TOKEN || '';
  const cabecalho = request.headers.get('Authorization') || '';
  const recebido = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7).trim() : '';
  if (esperado.length < 32 || !recebido) return false;
  return iguais(recebido, esperado);
};

export const naoAutorizado = () => json({ erro: 'nao_autorizado' }, 401, { 'WWW-Authenticate': 'Bearer' });

export const sha256Hex = async (texto) => {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// Conta um envio da origem na hora atual. Devolve false se passou do limite.
export const dentroDoLimite = async (env, ip) => {
  const limite = Number(env.LIMITE_ENVIOS_POR_HORA) || 10;
  const agora = agoraISO();
  const janela = agora.slice(0, 13);
  const chave = await sha256Hex(`${ip}|${env.RATE_SALT || ''}|${agora.slice(0, 10)}`);
  const linha = await env.DB.prepare(
    `INSERT INTO limite_envios (chave, janela, contagem) VALUES (?1, ?2, 1)
     ON CONFLICT (chave, janela) DO UPDATE SET contagem = contagem + 1
     RETURNING contagem`,
  ).bind(chave, janela).first();
  return (linha?.contagem ?? 0) <= limite;
};

// Apaga contagens antigas e leads já entregues há mais de 7 dias.
export const limpar = async (env) => {
  const corteLeads = new Date(Date.now() - RETENCAO_DIAS * 864e5).toISOString();
  const corteJanelas = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 13);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM leads WHERE entregue_em IS NOT NULL AND entregue_em < ?1').bind(corteLeads),
    env.DB.prepare('DELETE FROM limite_envios WHERE janela < ?1').bind(corteJanelas),
  ]);
};

// Converte uma linha do banco no formato do contrato com o CRM.
export const paraContrato = (l) => ({
  id: l.id,
  recebido_em: l.recebido_em,
  nome: l.nome,
  telefone: l.telefone,
  email: l.email,
  empresa: l.empresa,
  mensagem: l.mensagem,
  utm_source: l.utm_source,
  utm_medium: l.utm_medium,
  utm_campaign: l.utm_campaign,
  utm_content: l.utm_content,
  utm_term: l.utm_term,
  campaign_id: l.campaign_id,
  adset_id: l.adset_id,
  ad_id: l.ad_id,
  fbclid: l.fbclid,
  pagina: l.pagina,
  referrer: l.referrer,
  consentimento: { aceito_em: l.consentimento_aceito_em, versao_texto: l.consentimento_versao_texto },
});

export { agoraISO };
