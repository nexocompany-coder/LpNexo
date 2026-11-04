// Aviso de lead novo num grupo do Telegram.
//
// Roda em segundo plano (waitUntil) depois que o lead já foi gravado: nunca
// atrasa nem quebra o formulário. Qualquer falha vira uma linha de log sem
// dados pessoais. Sem TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID, não manda nada.
//
// No grupo vão só nome, carros por mês, Instagram, origem, horário e o botão
// do WhatsApp. E-mail e consentimento nunca saem daqui.
import { registrar } from './caixa.js';

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

// Manda o aviso. Nunca lança erro: quem chama não precisa se preocupar.
// O log nunca leva o token (que está no endereço) nem dados do lead.
export const avisarNoTelegram = async (env, lead) => {
  const token = limpo(env.TELEGRAM_BOT_TOKEN);
  const chatId = limpo(env.TELEGRAM_CHAT_ID);
  if (!token || !chatId) {
    registrar('aviso_telegram_desligado');
    return false;
  }
  try {
    const resposta = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, ...montarAviso(lead) }),
      signal: AbortSignal.timeout(ESPERA_MAXIMA_MS),
    });
    const corpo = await resposta.json().catch(() => ({}));
    if (!resposta.ok || corpo.ok !== true) {
      registrar('aviso_telegram_falhou', { status: resposta.status });
      return false;
    }
    registrar('aviso_telegram_enviado');
    return true;
  } catch (erro) {
    registrar('aviso_telegram_falhou', { motivo: erro?.name === 'TimeoutError' ? 'tempo' : 'rede' });
    return false;
  }
};
