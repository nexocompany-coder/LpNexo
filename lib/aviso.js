// Aviso de lead novo num grupo do Telegram.
//
// Roda em segundo plano (waitUntil) depois que o lead já foi gravado: nunca
// atrasa nem quebra o formulário. Qualquer falha vira uma linha de log sem
// dados pessoais. Sem TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID, não manda nada.
//
// No grupo vão só nome, carros por mês, Instagram, origem, horário e o botão
// do WhatsApp. E-mail e consentimento nunca saem daqui.
//
// Se o grupo virar supergrupo, o Telegram recusa o envio e informa o novo id
// (migrate_to_chat_id). Aí o novo id fica guardado no D1 (tabela configuracao),
// o aviso é reenviado para ele e os próximos já vão direto para o grupo novo.
import { agoraISO, registrar } from './caixa.js';

const ESPERA_MAXIMA_MS = 8000;
const SEM_DADO = 'sem dado';
const FONTES_DO_META = ['meta', 'facebook', 'fb', 'instagram', 'ig'];

const limpo = (valor) => {
  const t = typeof valor === 'string' ? valor.trim() : '';
  return t === '' ? null : t;
};

// Texto do usuário dentro de uma mensagem em HTML do Telegram.
export const escapar = (texto) =>
  String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// As mesmas regras do CRM (crm-nexo/src/lib/origem.ts), sem adivinhar.
// Para anúncio do Meta, junta o nome da campanha quando houver.
export const origemLegivel = (lead) => {
  const source = limpo(lead.utm_source)?.toLowerCase() ?? null;
  const medium = limpo(lead.utm_medium)?.toLowerCase() ?? null;
  const campanha = limpo(lead.utm_campaign);

  if (medium === 'paid_social' && source && FONTES_DO_META.includes(source)) {
    return campanha ? `Meta Ads · ${campanha}` : 'Meta Ads';
  }
  if (source === 'instagram' && medium === 'bio') return 'Instagram - link da bio';

  const temUtm = Boolean(source || medium || campanha || limpo(lead.utm_content) || limpo(lead.utm_term));
  if (!temUtm && limpo(lead.fbclid)) return 'Meta (sem UTM)';
  if (!temUtm) return 'LP - origem não identificada';
  return `${source ?? SEM_DADO} / ${medium ?? SEM_DADO}`;
};

// "Carros por mês: 8 a 15" vem dentro da mensagem do formulário.
export const carrosPorMes = (mensagem) => {
  const achado = /carros por m[eê]s:\s*([^\n]+)/i.exec(mensagem || '');
  return limpo(achado?.[1]) ?? SEM_DADO;
};

// wa.me com o número completo, com 55 na frente. Nono dígito mantido.
// Número que não fecha em um formato possível: sem botão, nada inventado.
export const linkDoWhatsApp = (telefone) => {
  let d = String(telefone || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (!/^55\d{10,11}$/.test(d)) return null;
  return `https://wa.me/${d}`;
};

export const horarioDeBrasilia = (instante) =>
  new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  })
    .format(new Date(instante))
    .replace(', ', ' às ');

// Texto + botão, prontos para o sendMessage. Função pura: fácil de testar.
export const montarAviso = (lead, instante = lead.recebido_em) => {
  const linhas = [
    `🔥 <b>Novo lead: ${escapar(limpo(lead.nome) ?? SEM_DADO)}</b>`,
    `🚗 Carros por mês: ${escapar(carrosPorMes(lead.mensagem))}`,
    `📸 Instagram: ${escapar(limpo(lead.empresa) ?? SEM_DADO)}`,
    `📍 Origem: ${escapar(origemLegivel(lead))}`,
    `🕒 ${horarioDeBrasilia(instante)} (horário de Brasília)`,
  ];
  const whatsapp = linkDoWhatsApp(lead.telefone);
  return {
    text: linhas.join('\n'),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(whatsapp ? { reply_markup: { inline_keyboard: [[{ text: '💬 Chamar no WhatsApp', url: whatsapp }]] } } : {}),
  };
};

// Id do grupo depois de uma migração para supergrupo, guardado no D1.
// A chave leva o id do segredo: trocar o TELEGRAM_CHAT_ID ignora o guardado.
const chaveDoGrupo = (chatId) => `telegram_chat_id:${chatId}`;

const grupoGuardado = async (env, chatId) => {
  try {
    const linha = await env.DB.prepare('SELECT valor FROM configuracao WHERE chave = ?1').bind(chaveDoGrupo(chatId)).first();
    return limpo(linha?.valor);
  } catch {
    return null; // sem banco ou sem a tabela: usa o id do segredo
  }
};

const guardarGrupo = async (env, chatId, novoId) => {
  try {
    await env.DB.prepare(
      `INSERT INTO configuracao (chave, valor, atualizado_em) VALUES (?1, ?2, ?3)
       ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em`,
    ).bind(chaveDoGrupo(chatId), novoId, agoraISO()).run();
    return true;
  } catch {
    return false;
  }
};

// Um sendMessage. Nunca lança erro; devolve ok, o status e o novo id se o grupo migrou.
const enviarMensagem = async (token, chatId, mensagem) => {
  try {
    const resposta = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, ...mensagem }),
      signal: AbortSignal.timeout(ESPERA_MAXIMA_MS),
    });
    const corpo = await resposta.json().catch(() => ({}));
    const migrouPara = corpo?.parameters?.migrate_to_chat_id;
    return {
      ok: resposta.ok && corpo.ok === true,
      status: resposta.status,
      migrouPara: Number.isSafeInteger(migrouPara) ? String(migrouPara) : null,
    };
  } catch (erro) {
    return { ok: false, motivo: erro?.name === 'TimeoutError' ? 'tempo' : 'rede' };
  }
};

// Manda o aviso. Nunca lança erro: quem chama não precisa se preocupar.
// O log nunca leva o token (que está no endereço) nem dados do lead.
export const avisarNoTelegram = async (env, lead) => {
  const token = limpo(env.TELEGRAM_BOT_TOKEN);
  const chatId = limpo(env.TELEGRAM_CHAT_ID);
  if (!token || !chatId) {
    registrar('aviso_telegram_desligado');
    return false;
  }
  const mensagem = montarAviso(lead);
  let resultado = await enviarMensagem(token, (await grupoGuardado(env, chatId)) ?? chatId, mensagem);

  // O grupo virou supergrupo: guarda o novo id e reenvia uma vez para ele.
  if (!resultado.ok && resultado.migrouPara) {
    const guardado = await guardarGrupo(env, chatId, resultado.migrouPara);
    registrar('aviso_telegram_grupo_migrou', { novo_id_guardado: guardado });
    resultado = await enviarMensagem(token, resultado.migrouPara, mensagem);
  }

  if (!resultado.ok) {
    registrar('aviso_telegram_falhou', resultado.motivo ? { motivo: resultado.motivo } : { status: resultado.status });
    return false;
  }
  registrar('aviso_telegram_enviado');
  return true;
};
