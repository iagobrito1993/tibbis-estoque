-- Tibiis Estoque — integração com o Mercado Livre
-- Baixa das vendas Flex/Agência no Estoque SP (depósito), em ordem de chegada das remessas.
-- Vendas Full não mexem no estoque do sistema (saem do estoque do próprio ML).

create table if not exists ml_contas(
  id bigint primary key,               -- user_id do ML
  apelido text,
  access_token text,
  refresh_token text,
  expira_em timestamptz,
  ativo boolean not null default true,
  conectado_em timestamptz not null default now(),
  ultima_sync timestamptz
);
create table if not exists ml_estados(
  state text primary key,
  user_id uuid,
  criado_em timestamptz not null default now()
);
create table if not exists ml_anuncios(
  item_id text not null,
  variacao_id bigint not null default 0,
  conta_id bigint references ml_contas(id) on delete cascade,
  titulo text, sku text, ean text,
  produto_id bigint references produtos(id) on delete set null,
  vinculo_manual boolean not null default false,
  logistica text, status text, estoque_ml int, permalink text, foto text,
  atualizado_em timestamptz not null default now(),
  primary key(item_id, variacao_id)
);
create table if not exists ml_pedidos(
  id bigint primary key,               -- order_id do ML
  conta_id bigint references ml_contas(id) on delete set null,
  status text, logistica text, data timestamptz, total numeric, comprador text,
  itens jsonb not null default '[]',   -- [{item_id, variacao_id, titulo, qtd}]
  situacao text not null default 'pendente', -- baixado | devolvido | full | sem_vinculo | sem_estoque | pendente | cancelado
  detalhe text,
  atualizado_em timestamptz not null default now()
);
create table if not exists ml_baixas(
  id bigserial primary key,
  pedido_id bigint references ml_pedidos(id) on delete cascade,
  encaminhamento_id bigint references encaminhamentos(id) on delete set null,
  produto_id bigint, qtd int
);
create index if not exists ml_anuncios_produto on ml_anuncios(produto_id);
create index if not exists ml_pedidos_data on ml_pedidos(data desc);

alter table ml_contas enable row level security;
alter table ml_estados enable row level security;
alter table ml_anuncios enable row level security;
alter table ml_pedidos enable row level security;
alter table ml_baixas enable row level security;

-- só o administrador enxerga; tokens nunca vão para o site
revoke all on ml_contas, ml_estados, ml_anuncios, ml_pedidos, ml_baixas from anon, authenticated;
grant select (id, apelido, ativo, conectado_em, ultima_sync) on ml_contas to authenticated;
grant select on ml_anuncios, ml_pedidos to authenticated;
drop policy if exists ml_contas_admin on ml_contas;
create policy ml_contas_admin on ml_contas for select to authenticated using (exists(select 1 from perfis where user_id=auth.uid() and papel='admin'));
drop policy if exists ml_anuncios_admin on ml_anuncios;
create policy ml_anuncios_admin on ml_anuncios for select to authenticated using (exists(select 1 from perfis where user_id=auth.uid() and papel='admin'));
drop policy if exists ml_pedidos_admin on ml_pedidos;
create policy ml_pedidos_admin on ml_pedidos for select to authenticated using (exists(select 1 from perfis where user_id=auth.uid() and papel='admin'));

-- saldo do depósito SP por produto (recebido - encaminhado)
create or replace function ml_estoque_sp() returns table(produto_id bigint, qtd int)
language sql stable security definer set search_path to 'public' as $$
  select i.produto_id, sum(coalesce(i.qtd_recebida,0) - coalesce((select sum(e.qtd) from encaminhamentos e where e.item_id=i.id),0))::int
  from remessa_itens i join remessas r on r.id=i.remessa_id
  where r.status='recebida' group by i.produto_id
$$;

-- dá baixa de um pedido (chamada só pelo servidor)
create or replace function ml_baixar_pedido(p_pedido bigint) returns text
language plpgsql security definer set search_path to 'public' as $$
declare v_p ml_pedidos; v_conta text; it jsonb; v_prod bigint; v_falta text := ''; v_semvinc text := '';
  v_need int; v_disp int; v_take int; v_enc bigint; rec record;
begin
  select * into v_p from ml_pedidos where id=p_pedido for update;
  if not found then return 'pedido não encontrado'; end if;
  if v_p.situacao in ('baixado','full','devolvido','cancelado') then return v_p.situacao; end if;
  select coalesce(apelido, id::text) into v_conta from ml_contas where id=v_p.conta_id;
  -- 1) todos os itens precisam estar vinculados a um produto
  for it in select * from jsonb_array_elements(v_p.itens) loop
    select a.produto_id into v_prod from ml_anuncios a where a.item_id=it->>'item_id'
      and a.variacao_id in (coalesce((it->>'variacao_id')::bigint,0), 0) and a.produto_id is not null
      order by (a.variacao_id = coalesce((it->>'variacao_id')::bigint,0)) desc limit 1;
    if v_prod is null then v_semvinc := v_semvinc || coalesce(it->>'titulo', it->>'item_id') || '; '; end if;
  end loop;
  if v_semvinc <> '' then
    update ml_pedidos set situacao='sem_vinculo', detalhe='Anúncio sem produto vinculado: '||v_semvinc, atualizado_em=now() where id=p_pedido;
    return 'sem_vinculo';
  end if;
  -- 2) precisa ter saldo no depósito SP para todos os itens
  for it in select * from jsonb_array_elements(v_p.itens) loop
    select a.produto_id into v_prod from ml_anuncios a where a.item_id=it->>'item_id'
      and a.variacao_id in (coalesce((it->>'variacao_id')::bigint,0), 0) and a.produto_id is not null
      order by (a.variacao_id = coalesce((it->>'variacao_id')::bigint,0)) desc limit 1;
    select coalesce(sum(qtd),0) into v_disp from ml_estoque_sp() s where s.produto_id=v_prod;
    if v_disp < (it->>'qtd')::int then v_falta := v_falta || (select nome from produtos where id=v_prod) || ' (tem '||v_disp||'); '; end if;
  end loop;
  if v_falta <> '' then
    update ml_pedidos set situacao='sem_estoque', detalhe='Sem saldo no depósito SP: '||v_falta, atualizado_em=now() where id=p_pedido;
    return 'sem_estoque';
  end if;
  -- 3) baixa nas remessas mais antigas primeiro
  for it in select * from jsonb_array_elements(v_p.itens) loop
    select a.produto_id into v_prod from ml_anuncios a where a.item_id=it->>'item_id'
      and a.variacao_id in (coalesce((it->>'variacao_id')::bigint,0), 0) and a.produto_id is not null
      order by (a.variacao_id = coalesce((it->>'variacao_id')::bigint,0)) desc limit 1;
    v_need := (it->>'qtd')::int;
    for rec in select i.id, coalesce(i.qtd_recebida,0) - coalesce((select sum(e.qtd) from encaminhamentos e where e.item_id=i.id),0) as disp
      from remessa_itens i join remessas r on r.id=i.remessa_id
      where r.status='recebida' and i.produto_id=v_prod order by r.data_chegada nulls last, r.id, i.id for update of i loop
      exit when v_need <= 0;
      continue when rec.disp <= 0;
      v_take := least(rec.disp, v_need);
      insert into encaminhamentos(item_id,qtd,destino,conta,envio,data,obs)
        values(rec.id, v_take, 'Venda Mercado Livre', v_conta, p_pedido::text, current_date, 'Automático · '||coalesce(v_p.logistica,''))
        returning id into v_enc;
      insert into ml_baixas(pedido_id, encaminhamento_id, produto_id, qtd) values(p_pedido, v_enc, v_prod, v_take);
      v_need := v_need - v_take;
    end loop;
  end loop;
  update ml_pedidos set situacao='baixado', detalhe=null, atualizado_em=now() where id=p_pedido;
  return 'baixado';
end $$;

-- devolve ao estoque um pedido cancelado
create or replace function ml_estornar_pedido(p_pedido bigint) returns text
language plpgsql security definer set search_path to 'public' as $$
declare v_sit text;
begin
  select situacao into v_sit from ml_pedidos where id=p_pedido for update;
  if v_sit = 'baixado' then
    delete from encaminhamentos where id in (select encaminhamento_id from ml_baixas where pedido_id=p_pedido);
    delete from ml_baixas where pedido_id=p_pedido;
    update ml_pedidos set situacao='devolvido', detalhe='Cancelado no ML — devolvido ao depósito SP', atualizado_em=now() where id=p_pedido;
    return 'devolvido';
  end if;
  update ml_pedidos set situacao=case when situacao='full' then 'full' else 'cancelado' end, atualizado_em=now() where id=p_pedido;
  return 'cancelado';
end $$;

revoke all on function ml_baixar_pedido(bigint), ml_estornar_pedido(bigint), ml_estoque_sp() from public, anon, authenticated;
grant execute on function ml_baixar_pedido(bigint), ml_estornar_pedido(bigint), ml_estoque_sp() to service_role;

-- ações do administrador pelo site
create or replace function ml_vincular(p_item text, p_var bigint, p_produto bigint) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  perform exigir(array['admin']);
  update ml_anuncios set produto_id=p_produto, vinculo_manual=true, atualizado_em=now() where item_id=p_item and variacao_id=coalesce(p_var,0);
end $$;
create or replace function ml_reprocessar(p_pedido bigint) returns text
language plpgsql security definer set search_path to 'public' as $$
begin
  perform exigir(array['admin']);
  update ml_pedidos set situacao='pendente' where id=p_pedido and situacao in ('sem_vinculo','sem_estoque');
  return ml_baixar_pedido(p_pedido);
end $$;
create or replace function ml_desconectar(p_conta bigint) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  perform exigir(array['admin']);
  update ml_contas set ativo=false, access_token=null, refresh_token=null where id=p_conta;
end $$;
grant execute on function ml_vincular(text,bigint,bigint), ml_reprocessar(bigint), ml_desconectar(bigint) to authenticated;
