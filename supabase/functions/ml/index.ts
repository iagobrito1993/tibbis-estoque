// Tibiis Estoque — integração com o Mercado Livre (API oficial)
// Rotas:  GET  /ml/callback       volta do login do ML (salva a conta)
//         POST /ml/notificacoes   avisos do ML (pedidos) → baixa / devolução automática
//         POST /ml  {acao}        ações do administrador: conectar | sincronizar | pedidos | enviar_estoque
// Segredos: ML_CLIENT_ID, ML_CLIENT_SECRET (aplicativo criado no developers.mercadolivre.com.br)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SITE = "https://tibiisestoque.com.br/";
const API = "https://api.mercadolibre.com";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CID = () => Deno.env.get("ML_CLIENT_ID") || "";
const CSEC = () => Deno.env.get("ML_CLIENT_SECRET") || "";
const REDIRECT = () => Deno.env.get("SUPABASE_URL") + "/functions/v1/ml/callback";
const norm = (s: unknown) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, "");

async function token(code: string | null, refresh: string | null) {
  const body = new URLSearchParams({ client_id: CID(), client_secret: CSEC() });
  if (code) { body.set("grant_type", "authorization_code"); body.set("code", code); body.set("redirect_uri", REDIRECT()); }
  else { body.set("grant_type", "refresh_token"); body.set("refresh_token", refresh!); }
  const r = await fetch(API + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  const j = await r.json();
  if (!r.ok) throw new Error("ML token: " + (j.message || j.error || r.status));
  return j;
}
async function acesso(contaId: number) {
  const { data: c } = await sb.from("ml_contas").select("*").eq("id", contaId).single();
  if (!c || !c.ativo || !c.refresh_token) throw new Error("Conta " + contaId + " não está conectada.");
  if (c.access_token && new Date(c.expira_em).getTime() > Date.now() + 5 * 60e3) return c;
  const t = await token(null, c.refresh_token);
  const upd = { access_token: t.access_token, refresh_token: t.refresh_token || c.refresh_token, expira_em: new Date(Date.now() + t.expires_in * 1e3).toISOString() };
  await sb.from("ml_contas").update(upd).eq("id", contaId);
  return { ...c, ...upd };
}
async function ml(c: any, path: string, init: RequestInit = {}) {
  const r = await fetch(API + path, { ...init, headers: { ...(init.headers || {}), authorization: "Bearer " + c.access_token, "content-type": "application/json" } });
  const t = await r.text();
  let j: any; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`ML ${path.split("?")[0]}: ${(j && (j.message || j.error)) || r.status}`);
  return j;
}
async function exigirAdmin(req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data } = await sb.auth.getUser(jwt);
  if (!data?.user) throw new Error("Faça login de novo.");
  const { data: p } = await sb.from("perfis").select("papel").eq("user_id", data.user.id).maybeSingle();
  if (p?.papel !== "admin") throw new Error("Só o administrador pode fazer isso.");
  return data.user;
}

// ---------- anúncios ----------
const attr = (arr: any[], id: string) => (arr || []).find((a: any) => a.id === id)?.value_name || null;
async function sincronizar(contaId: number) {
  const c = await acesso(contaId);
  const ids: string[] = [];
  let scroll = "";
  for (let i = 0; i < 200; i++) {
    const j = await ml(c, `/users/${contaId}/items/search?search_type=scan&limit=100${scroll ? "&scroll_id=" + scroll : ""}`);
    if (!j.results?.length) break;
    ids.push(...j.results); scroll = j.scroll_id;
    if (!scroll) break;
  }
  const { data: prods } = await sb.from("produtos").select("id,sku");
  const porCod = new Map<string, number>();
  (prods || []).forEach((p: any) => { if (p.sku) String(p.sku).split(/[\/,;]/).forEach((s) => s.trim() && porCod.set(norm(s), p.id)); });
  const { data: antigos } = await sb.from("ml_anuncios").select("item_id,variacao_id,produto_id,vinculo_manual").eq("conta_id", contaId);
  const manual = new Map<string, number | null>();
  (antigos || []).forEach((a: any) => { if (a.vinculo_manual) manual.set(a.item_id + ":" + a.variacao_id, a.produto_id); });
  const linhas: any[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const lote = await ml(c, `/items?ids=${ids.slice(i, i + 20).join(",")}&include_attributes=all`);
    for (const x of lote) {
      const it = x.body; if (!it || x.code !== 200) continue;
      const base = { conta_id: contaId, titulo: it.title, logistica: it.shipping?.logistic_type || null, status: it.status, permalink: it.permalink, foto: it.thumbnail, atualizado_em: new Date().toISOString() };
      const vars = it.variations?.length ? it.variations : [null];
      for (const v of vars) {
        const sku = v ? (v.seller_custom_field || attr(v.attributes, "SELLER_SKU") || it.seller_custom_field || attr(it.attributes, "SELLER_SKU")) : (it.seller_custom_field || attr(it.attributes, "SELLER_SKU"));
        const ean = v ? (attr(v.attributes, "GTIN") || attr(it.attributes, "GTIN")) : attr(it.attributes, "GTIN");
        const k = it.id + ":" + (v ? v.id : 0);
        const auto = (sku && porCod.get(norm(sku))) || (ean && porCod.get(norm(ean))) || null;
        linhas.push({ ...base, item_id: it.id, variacao_id: v ? v.id : 0, sku, ean, estoque_ml: v ? v.available_quantity : it.available_quantity,
          produto_id: manual.has(k) ? manual.get(k) : auto, vinculo_manual: manual.has(k) });
      }
    }
  }
  for (let i = 0; i < linhas.length; i += 500) {
    const { error } = await sb.from("ml_anuncios").upsert(linhas.slice(i, i + 500));
    if (error) throw error;
  }
  await sb.from("ml_contas").update({ ultima_sync: new Date().toISOString() }).eq("id", contaId);
  return { anuncios: linhas.length, vinculados: linhas.filter((l) => l.produto_id).length };
}

// ---------- estoque SP → ML (só Flex/Agência; Full fica de fora) ----------
async function enviarEstoque(produtos: number[] | null) {
  const { data: saldo, error } = await sb.rpc("ml_estoque_sp");
  if (error) throw error;
  const sp = new Map<number, number>(); (saldo || []).forEach((s: any) => sp.set(s.produto_id, Math.max(0, s.qtd)));
  let q = sb.from("ml_anuncios").select("*").not("produto_id", "is", null).neq("logistica", "fulfillment").in("status", ["active", "paused"]);
  if (produtos) q = q.in("produto_id", produtos);
  const { data: an } = await q;
  const porItem = new Map<string, any[]>(); (an || []).forEach((a: any) => { const l = porItem.get(a.item_id) || []; l.push(a); porItem.set(a.item_id, l); });
  let ok = 0; const erros: string[] = [];
  for (const [item, ls] of porItem) {
    try {
      const c = await acesso(ls[0].conta_id);
      if (ls[0].variacao_id === 0) {
        const n = sp.get(ls[0].produto_id) || 0;
        if (n === ls[0].estoque_ml) continue;
        await ml(c, `/items/${item}`, { method: "PUT", body: JSON.stringify({ available_quantity: n }) });
        await sb.from("ml_anuncios").update({ estoque_ml: n }).eq("item_id", item).eq("variacao_id", 0);
      } else {
        const it = await ml(c, `/items/${item}?attributes=variations`);
        const mapa = new Map(ls.map((l: any) => [l.variacao_id, sp.get(l.produto_id) || 0]));
        if (!ls.some((l: any) => mapa.get(l.variacao_id) !== l.estoque_ml)) continue;
        // manda todas as variações (as que não mandar, o ML apaga)
        const variations = (it.variations || []).map((v: any) => mapa.has(v.id) ? { id: v.id, available_quantity: mapa.get(v.id) } : { id: v.id });
        await ml(c, `/items/${item}`, { method: "PUT", body: JSON.stringify({ variations }) });
        for (const l of ls) await sb.from("ml_anuncios").update({ estoque_ml: mapa.get(l.variacao_id) }).eq("item_id", item).eq("variacao_id", l.variacao_id);
      }
      ok++;
    } catch (e) { erros.push(item + ": " + (e as Error).message); }
  }
  return { atualizados: ok, erros };
}

// ---------- pedidos ----------
async function processarPedido(contaId: number, orderId: number) {
  const c = await acesso(contaId);
  const o = await ml(c, `/orders/${orderId}`);
  let logistica: string | null = null;
  if (o.shipping?.id) { try { const s = await ml(c, `/shipments/${o.shipping.id}`); logistica = s.logistic_type || null; } catch { /* sem envio */ } }
  const itens = (o.order_items || []).map((x: any) => ({ item_id: x.item?.id, variacao_id: x.item?.variation_id || 0, titulo: x.item?.title, qtd: x.quantity }));
  const { data: atual } = await sb.from("ml_pedidos").select("situacao").eq("id", orderId).maybeSingle();
  const reg: any = { id: orderId, conta_id: contaId, status: o.status, logistica, data: o.date_created, total: o.total_amount, comprador: o.buyer?.nickname || null, itens, atualizado_em: new Date().toISOString() };
  if (!atual) reg.situacao = logistica === "fulfillment" ? "full" : "pendente";
  await sb.from("ml_pedidos").upsert(reg);
  if (o.status === "cancelled") return (await sb.rpc("ml_estornar_pedido", { p_pedido: orderId })).data;
  if (o.status !== "paid" || logistica === "fulfillment") return reg.situacao || atual?.situacao;
  const { data: res, error } = await sb.rpc("ml_baixar_pedido", { p_pedido: orderId });
  if (error) throw error;
  if (res === "baixado" && atual?.situacao !== "baixado") {
    const { data: b } = await sb.from("ml_baixas").select("produto_id").eq("pedido_id", orderId);
    await enviarEstoque([...new Set((b || []).map((x: any) => x.produto_id))]).catch(() => {});
  }
  return res;
}
async function buscarPedidos(contaId: number, dias = 3) {
  const c = await acesso(contaId);
  const desde = new Date(Date.now() - dias * 864e5).toISOString().replace("Z", "-00:00");
  let n = 0;
  for (let off = 0; off < 1000; off += 50) {
    const j = await ml(c, `/orders/search?seller=${contaId}&order.date_last_updated.from=${encodeURIComponent(desde)}&sort=date_desc&limit=50&offset=${off}`);
    for (const o of j.results || []) { try { await processarPedido(contaId, o.id); n++; } catch (_) { /* segue */ } }
    if (!j.results || j.results.length < 50) break;
  }
  return { pedidos: n };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const rota = url.pathname.replace(/^.*\/ml\/?/, "");
  try {
    // volta do login do Mercado Livre
    if (rota === "callback") {
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      const { data: st } = await sb.from("ml_estados").delete().eq("state", state || "-").select().maybeSingle();
      if (!code || !st || Date.now() - new Date(st.criado_em).getTime() > 30 * 60e3) return Response.redirect(SITE + "?ml=erro&msg=" + encodeURIComponent("Link expirado. Tente conectar de novo."), 302);
      const t = await token(code, null);
      const me = await fetch(API + "/users/me", { headers: { authorization: "Bearer " + t.access_token } }).then((r) => r.json());
      await sb.from("ml_contas").upsert({ id: t.user_id, apelido: me.nickname || null, access_token: t.access_token, refresh_token: t.refresh_token,
        expira_em: new Date(Date.now() + t.expires_in * 1e3).toISOString(), ativo: true, conectado_em: new Date().toISOString() });
      try { await sincronizar(t.user_id); } catch (_) { /* dá para sincronizar depois */ }
      return Response.redirect(SITE + "?ml=ok&conta=" + encodeURIComponent(me.nickname || ""), 302);
    }
    // avisos do Mercado Livre
    if (rota === "notificacoes") {
      const n = await req.json().catch(() => ({}));
      const m = String(n.resource || "").match(/\/orders\/(\d+)/);
      if (m && n.user_id && /orders/.test(n.topic || "")) {
        const { data: c } = await sb.from("ml_contas").select("id").eq("id", n.user_id).eq("ativo", true).maybeSingle();
        if (c) await processarPedido(Number(n.user_id), Number(m[1])).catch((e) => console.error(e));
      }
      return json({ ok: true });
    }
    // ações do administrador
    const user = await exigirAdmin(req);
    if (!CID() || !CSEC()) throw new Error("O aplicativo do Mercado Livre ainda não foi configurado no servidor.");
    const b = await req.json().catch(() => ({}));
    const contas = async () => ((await sb.from("ml_contas").select("id").eq("ativo", true)).data || []).map((c: any) => c.id).filter((id: number) => !b.conta || id === b.conta);
    if (b.acao === "conectar") {
      const state = crypto.randomUUID();
      await sb.from("ml_estados").insert({ state, user_id: user.id });
      return json({ url: `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${CID()}&redirect_uri=${encodeURIComponent(REDIRECT())}&state=${state}` });
    }
    if (b.acao === "sincronizar") { const r: any = {}; for (const id of await contas()) r[id] = await sincronizar(id).catch((e) => ({ erro: e.message })); return json(r); }
    if (b.acao === "pedidos") { const r: any = {}; for (const id of await contas()) r[id] = await buscarPedidos(id, b.dias || 3).catch((e) => ({ erro: e.message })); return json(r); }
    if (b.acao === "enviar_estoque") return json(await enviarEstoque(null));
    throw new Error("Ação desconhecida.");
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});
