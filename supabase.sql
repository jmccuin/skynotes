-- SkyNotes sync schema for Supabase. Run once in SQL Editor.
create table if not exists public.records (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind       text not null,
  data       jsonb not null,
  updated    bigint not null,
  deleted    boolean not null default false,
  server_ts  timestamptz not null default now()
);
create index if not exists records_user_ts on public.records (user_id, server_ts);

alter table public.records enable row level security;
drop policy if exists "own rows" on public.records;
create policy "own rows" on public.records
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Last-writer-wins: ignore updates older than what the server already has,
-- and stamp server_ts so other devices can pull the change.
create or replace function public.records_lww() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.updated < old.updated then
      return old;
    end if;
    new.user_id := old.user_id;
  end if;
  new.server_ts := clock_timestamp();
  return new;
end $$;

drop trigger if exists records_lww on public.records;
create trigger records_lww before insert or update on public.records
  for each row execute function public.records_lww();
