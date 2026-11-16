-- ─────────────────────────────────────────────────────────────
-- 다해랑 동기화용 데이터베이스 (Supabase SQL Editor에 통째로 붙여넣고 Run)
-- 여러 번 실행해도 안전하게 작성돼 있어요.
-- ─────────────────────────────────────────────────────────────

-- 1) 커플 · 멤버 · 기록 테이블
create table if not exists public.couples (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  couple_id uuid not null references public.couples(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (couple_id, user_id)
);

create sequence if not exists public.records_seq;

-- 추억 · 위시 · 프로필이 모두 이 테이블에 JSON으로 저장돼요.
-- updated_at(앱에서 수정한 시각)이 더 최신인 쪽이 이겨요.
create table if not exists public.records (
  couple_id uuid not null references public.couples(id) on delete cascade,
  id text not null,
  kind text not null check (kind in ('memory', 'wish', 'profile')),
  data jsonb not null,
  updated_at bigint not null,
  deleted boolean not null default false,
  seq bigint not null default nextval('public.records_seq'),
  updated_by uuid default auth.uid(),
  primary key (couple_id, id)
);
create index if not exists records_couple_seq_idx on public.records (couple_id, seq);

grant usage, select on sequence public.records_seq to authenticated;

-- 2) 내가 속한 커플 (보안 규칙에서 사용)
create or replace function public.my_couples()
returns setof uuid language sql stable security definer set search_path = public as $$
  select couple_id from public.members where user_id = auth.uid()
$$;

-- 3) 보안 규칙: 같은 커플만 서로의 기록을 읽고 쓸 수 있어요
alter table public.couples enable row level security;
alter table public.members enable row level security;
alter table public.records enable row level security;

drop policy if exists "couples read" on public.couples;
create policy "couples read" on public.couples for select to authenticated
  using (id in (select public.my_couples()));

drop policy if exists "members read" on public.members;
create policy "members read" on public.members for select to authenticated
  using (couple_id in (select public.my_couples()));

drop policy if exists "records read" on public.records;
create policy "records read" on public.records for select to authenticated
  using (couple_id in (select public.my_couples()));

drop policy if exists "records insert" on public.records;
create policy "records insert" on public.records for insert to authenticated
  with check (couple_id in (select public.my_couples()));

drop policy if exists "records update" on public.records;
create policy "records update" on public.records for update to authenticated
  using (couple_id in (select public.my_couples()))
  with check (couple_id in (select public.my_couples()));

-- 4) 수정될 때마다 순번(seq)을 새로 매겨서 "어디까지 받았는지" 추적
create or replace function public.records_bump()
returns trigger language plpgsql as $$
begin
  new.seq := nextval('public.records_seq');
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists records_bump on public.records;
create trigger records_bump before update on public.records
  for each row execute function public.records_bump();

-- 5) 여러 기록을 한 번에 올리기 (더 최신일 때만 덮어씀)
create or replace function public.push_records(p_couple uuid, p_items jsonb)
returns void language plpgsql security invoker set search_path = public as $$
declare it jsonb;
begin
  for it in select * from jsonb_array_elements(p_items) loop
    insert into public.records (couple_id, id, kind, data, updated_at, deleted)
    values (p_couple, it->>'id', it->>'kind', it->'data', (it->>'updated_at')::bigint, coalesce((it->>'deleted')::boolean, false))
    on conflict (couple_id, id) do update
      set kind = excluded.kind, data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted
      where public.records.updated_at < excluded.updated_at;
  end loop;
end $$;

-- 6) 연결 코드 만들기 / 코드로 들어가기
create or replace function public.create_couple()
returns table (couple_id uuid, code text) language plpgsql security definer set search_path = public as $$
declare c_id uuid; c_code text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select m.couple_id into c_id from public.members m where m.user_id = auth.uid() limit 1;
  if c_id is null then
    loop
      c_code := upper(substr(md5(gen_random_uuid()::text), 1, 10));
      exit when not exists (select 1 from public.couples c where c.code = c_code);
    end loop;
    insert into public.couples (code) values (c_code) returning id into c_id;
    insert into public.members (couple_id, user_id) values (c_id, auth.uid());
  end if;
  return query select c.id, c.code from public.couples c where c.id = c_id;
end $$;

create or replace function public.join_couple(p_code text)
returns table (couple_id uuid, code text) language plpgsql security definer set search_path = public as $$
declare c_id uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select c.id into c_id from public.couples c where c.code = upper(regexp_replace(p_code, '[^0-9A-Za-z]', '', 'g'));
  if c_id is null then raise exception 'invalid code'; end if;
  insert into public.members (couple_id, user_id) values (c_id, auth.uid()) on conflict do nothing;
  return query select c.id, c.code from public.couples c where c.id = c_id;
end $$;

grant execute on function public.create_couple() to authenticated;
grant execute on function public.join_couple(text) to authenticated;
grant execute on function public.push_records(uuid, jsonb) to authenticated;

-- 7) 사진 저장소 (비공개, 같은 커플만 접근)
insert into storage.buckets (id, name, public) values ('photos', 'photos', false)
  on conflict (id) do nothing;

drop policy if exists "photos read" on storage.objects;
create policy "photos read" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1]::uuid in (select public.my_couples()));

drop policy if exists "photos insert" on storage.objects;
create policy "photos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1]::uuid in (select public.my_couples()));

drop policy if exists "photos delete" on storage.objects;
create policy "photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1]::uuid in (select public.my_couples()));

-- 8) 실시간 반영 (상대가 수정하면 바로 내 폰에 나타나게)
do $$ begin
  alter publication supabase_realtime add table public.records;
exception when duplicate_object then null; end $$;
