// GET /api/inbox — o CRM busca os leads. Exige "Authorization: Bearer <token>".
//   ?limit=50                         pendentes, do mais antigo para o mais novo
//   ?incluir_recebidos=1&desde=<data> recuperação: pendentes e já entregues
//                                     recebidos a partir da data (ISO)
import { autorizado, json, limpar, naoAutorizado, paraContrato, registrar } from '../../../lib/caixa.js';

export const onRequestGet = async ({ request, env }) => {
  if (!(await autorizado(request, env))) return naoAutorizado();

  const params = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(parseInt(params.get('limit') || '50', 10) || 50, 1), 200);
  const recuperar = params.get('incluir_recebidos') === '1';

  await limpar(env);

  let consulta;
  if (recuperar) {
    const desde = new Date(params.get('desde') || '');
    if (Number.isNaN(desde.getTime())) return json({ erro: 'parametro_desde_invalido' }, 400);
    consulta = env.DB.prepare('SELECT * FROM leads WHERE recebido_em >= ?1 ORDER BY seq LIMIT ?2')
      .bind(desde.toISOString(), limit + 1);
  } else {
    consulta = env.DB.prepare('SELECT * FROM leads WHERE entregue_em IS NULL ORDER BY seq LIMIT ?1').bind(limit + 1);
  }

  const { results } = await consulta.all();
  const tem_mais = results.length > limit;
  registrar('inbox_lida', { quantidade: Math.min(results.length, limit), recuperacao: recuperar });
  return json({ leads: results.slice(0, limit).map(paraContrato), tem_mais });
};

export const onRequest = async ({ request, env }) => {
  if (!(await autorizado(request, env))) return naoAutorizado();
  return json({ erro: 'metodo_nao_permitido' }, 405, { Allow: 'GET' });
};
