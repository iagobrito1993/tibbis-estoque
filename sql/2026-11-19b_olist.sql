-- Pedidos do ML via Olist ERP: estado da sincronização + agendador a cada 5 minutos
create table if not exists ml_olist_estado(id int primary key, ultima timestamptz, resultado jsonb);
alter table ml_olist_estado enable row level security;
revoke all on ml_olist_estado from anon, authenticated;
grant select on ml_olist_estado to authenticated;
drop policy if exists ml_olist_admin on ml_olist_estado;
create policy ml_olist_admin on ml_olist_estado for select to authenticated using (exists(select 1 from perfis where user_id=auth.uid() and papel='admin'));
create table if not exists ml_cron(id int primary key, chave text not null);
alter table ml_cron enable row level security;
revoke all on ml_cron from anon, authenticated;
insert into ml_cron values (1, encode(extensions.gen_random_bytes(24),'hex')) on conflict do nothing;
create extension if not exists pg_cron;
select cron.schedule('tibiis-olist-pedidos', '*/5 * * * *', $$select net.http_post(url:='https://dufwrtancqquwdsqbjms.supabase.co/functions/v1/ml/olist-cron', headers:=jsonb_build_object('content-type','application/json','x-cron',(select chave from public.ml_cron where id=1)), body:='{}'::jsonb, timeout_milliseconds:=120000)$$);
