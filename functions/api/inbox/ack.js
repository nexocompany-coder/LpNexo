// POST /api/inbox/ack — o CRM confirma que recebeu. Corpo: {"ids": [...]}.
// Idempotente: confirmar de novo (ou um id inexistente) não dá erro.
import { agoraISO, autorizado, json, limpar, naoAutorizado, registrar } from '../../../lib/caixa.js';

const MAX_IDS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const onRequestPost = async ({ request, env }) => {
  if (!(await autorizado(request, env))) return naoAutorizado();

  let corpo;
  try { corpo = await request.json(); } catch { return json({ erro: 'dados_invalidos' }, 400); }
  const ids = corpo?.ids;
  if (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every((id) => typeof id === 'string' && UUID.test(id))) {
    return json({ erro: 'dados_invalidos' }, 400);
  }

  const agora = agoraISO();
  const unicos = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (unicos.length) {
    await env.DB.batch(unicos.map((id) =>
      env.DB.prepare('UPDATE leads SET entregue_em = ?1 WHERE id = ?2 AND entregue_em IS NULL').bind(agora, id)));
  }
  await limpar(env);

  registrar('inbox_ack', { quantidade: unicos.length });
  return json({ ok: true });
};

export const onRequest = async ({ request, env }) => {
  if (!(await autorizado(request, env))) return naoAutorizado();
  return json({ erro: 'metodo_nao_permitido' }, 405, { Allow: 'POST' });
};
