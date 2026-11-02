-- =====================================================================
-- Keepsake Wall — database setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run more than once. It only creates things that start with
-- "mw_" plus the "memory-photos" bucket, so your Photo Journal tables
-- and "photos" bucket are never touched.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

-- ---------- 1. Tables ----------
create table if not exists public.mw_pages (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  token       text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  title       text not null check (char_length(title) between 1 and 120),
  description text check (description is null or char_length(description) <= 600),
  kind        text not null default 'memorial' check (kind in ('memorial','celebration')),
  cover_path  text,
  is_open     boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists mw_pages_owner on public.mw_pages (owner_id, created_at desc);

create table if not exists public.mw_posts (
  id            uuid primary key default gen_random_uuid(),
  page_id       uuid not null references public.mw_pages(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 60),
  message       text not null default '' check (char_length(message) <= 3000),
  paths         text[] not null default '{}' check (coalesce(array_length(paths,1),0) <= 10),
  edit_key_hash text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (page_id, edit_key_hash)
);
create index if not exists mw_posts_page on public.mw_posts (page_id, created_at desc);

-- ---------- 2. Row Level Security (only the organizer touches tables directly) ----------
alter table public.mw_pages enable row level security;
alter table public.mw_posts enable row level security;

revoke all on public.mw_pages from anon, authenticated;
revoke all on public.mw_posts from anon, authenticated;
grant select, insert, update, delete on public.mw_pages to authenticated;
grant select, delete on public.mw_posts to authenticated;

drop policy if exists "mw pages owner select" on public.mw_pages;
drop policy if exists "mw pages owner insert" on public.mw_pages;
drop policy if exists "mw pages owner update" on public.mw_pages;
drop policy if exists "mw pages owner delete" on public.mw_pages;
create policy "mw pages owner select" on public.mw_pages for select to authenticated using (owner_id = (select auth.uid()));
create policy "mw pages owner insert" on public.mw_pages for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "mw pages owner update" on public.mw_pages for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "mw pages owner delete" on public.mw_pages for delete to authenticated using (owner_id = (select auth.uid()));

drop policy if exists "mw posts owner select" on public.mw_posts;
drop policy if exists "mw posts owner delete" on public.mw_posts;
create policy "mw posts owner select" on public.mw_posts for select to authenticated
  using (exists (select 1 from public.mw_pages p where p.id = page_id and p.owner_id = (select auth.uid())));
create policy "mw posts owner delete" on public.mw_posts for delete to authenticated
  using (exists (select 1 from public.mw_pages p where p.id = page_id and p.owner_id = (select auth.uid())));

-- ---------- 3. Guest functions (reach a page ONLY with its long token) ----------
create or replace function private.mw_page_by_token(p_token text)
returns public.mw_pages language sql stable security definer set search_path = '' as $$
  select * from public.mw_pages where p_token is not null and length(p_token) >= 32 and token = p_token;
$$;
revoke all on function private.mw_page_by_token(text) from public;

drop function if exists public.get_page(text);
create function public.get_page(p_token text)
returns table (id uuid, title text, description text, kind text, cover_path text, is_open boolean, post_count bigint, max_posts int)
language sql stable security definer set search_path = '' as $$
  select p.id, p.title, p.description, p.kind, p.cover_path, p.is_open,
         (select count(*) from public.mw_posts x where x.page_id = p.id), 500
  from public.mw_pages p where length(p_token) >= 32 and p.token = p_token;
$$;

drop function if exists public.get_page_posts(text);
create function public.get_page_posts(p_token text)
returns table (id uuid, name text, message text, paths text[], created_at timestamptz, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select x.id, x.name, x.message, x.paths, x.created_at, x.updated_at
  from public.mw_posts x join public.mw_pages p on p.id = x.page_id
  where length(p_token) >= 32 and p.token = p_token
  order by x.created_at desc limit 1000;
$$;

-- shared checks for create/update
create or replace function private.mw_check(p_page public.mw_pages, p_name text, p_message text, p_paths text[])
returns void language plpgsql stable security definer set search_path = '' as $$
declare f text;
begin
  if p_page.id is null then raise exception 'This page was not found.'; end if;
  if not p_page.is_open then raise exception 'This page is closed to new posts.'; end if;
  if char_length(btrim(coalesce(p_name,''))) not between 1 and 60 then raise exception 'Please enter your name (60 characters max).'; end if;
  if char_length(coalesce(p_message,'')) > 3000 then raise exception 'Message is too long (3000 characters max).'; end if;
  if coalesce(array_length(p_paths,1),0) > 10 then raise exception 'At most 10 photos per post.'; end if;
  if coalesce(array_length(p_paths,1),0) = 0 and btrim(coalesce(p_message,'')) = '' then raise exception 'Please add a photo or a message.'; end if;
  foreach f in array coalesce(p_paths, '{}') loop
    if f is null or f !~ ('^' || p_page.id::text || '/[A-Za-z0-9_-]{8,80}\.jpg$') then raise exception 'Invalid photo.'; end if;
  end loop;
end $$;
revoke all on function private.mw_check(public.mw_pages, text, text, text[]) from public;

drop function if exists public.create_post(text, text, text, text[], text);
create function public.create_post(p_token text, p_name text, p_message text, p_paths text[], p_edit_key_hash text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare pg public.mw_pages; new_id uuid;
begin
  pg := private.mw_page_by_token(p_token);
  perform private.mw_check(pg, p_name, p_message, p_paths);
  if p_edit_key_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid edit key.'; end if;
  perform 1 from public.mw_pages where id = pg.id for update;   -- serialize the count check
  if (select count(*) from public.mw_posts where page_id = pg.id) >= 500 then raise exception 'This page has reached its limit of 500 posts.'; end if;
  if exists (select 1 from public.mw_posts where page_id = pg.id and edit_key_hash = p_edit_key_hash) then raise exception 'You already posted on this page from this device.'; end if;
  insert into public.mw_posts (page_id, name, message, paths, edit_key_hash)
  values (pg.id, btrim(p_name), coalesce(p_message,''), coalesce(p_paths,'{}'), p_edit_key_hash) returning id into new_id;
  return new_id;
end $$;

drop function if exists public.update_post(text, uuid, text, text, text, text[]);
create function public.update_post(p_token text, p_post_id uuid, p_edit_key text, p_name text, p_message text, p_paths text[])
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare pg public.mw_pages;
begin
  pg := private.mw_page_by_token(p_token);
  perform private.mw_check(pg, p_name, p_message, p_paths);
  update public.mw_posts set name = btrim(p_name), message = coalesce(p_message,''), paths = coalesce(p_paths,'{}'), updated_at = now()
  where id = p_post_id and page_id = pg.id
    and edit_key_hash = encode(extensions.digest(coalesce(p_edit_key,''), 'sha256'), 'hex');
  if not found then raise exception 'This post can only be changed from the device that created it.'; end if;
  return true;
end $$;

drop function if exists public.delete_post(text, uuid, text);
create function public.delete_post(p_token text, p_post_id uuid, p_edit_key text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare pg public.mw_pages;
begin
  pg := private.mw_page_by_token(p_token);
  if pg.id is null then raise exception 'This page was not found.'; end if;
  delete from public.mw_posts where id = p_post_id and page_id = pg.id
    and edit_key_hash = encode(extensions.digest(coalesce(p_edit_key,''), 'sha256'), 'hex');
  if not found then raise exception 'This post can only be removed from the device that created it.'; end if;
  return true;
end $$;

revoke all on function public.get_page(text) from public;
revoke all on function public.get_page_posts(text) from public;
revoke all on function public.create_post(text, text, text, text[], text) from public;
revoke all on function public.update_post(text, uuid, text, text, text, text[]) from public;
revoke all on function public.delete_post(text, uuid, text) from public;
grant execute on function public.get_page(text) to anon, authenticated;
grant execute on function public.get_page_posts(text) to anon, authenticated;
grant execute on function public.create_post(text, text, text, text[], text) to anon, authenticated;
grant execute on function public.update_post(text, uuid, text, text, text, text[]) to anon, authenticated;
grant execute on function public.delete_post(text, uuid, text) to anon, authenticated;

-- ---------- 4. Photo storage (private bucket) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('memory-photos', 'memory-photos', false, 8388608, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = 8388608,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'];

-- folder name must be the id of a page that is OPEN for posting
create or replace function private.mw_open_folder(p_folder text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.mw_pages where id::text = p_folder and is_open);
$$;
-- folder belongs to a page owned by the signed-in organizer
create or replace function private.mw_my_folder(p_folder text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.mw_pages where id::text = p_folder and owner_id = auth.uid());
$$;
-- photo is used by a post or as a page cover (same idea as Photo Journal's is_shared_photo)
create or replace function private.mw_visible_photo(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.mw_pages p where p.cover_path = p_name and (storage.foldername(p_name))[1] = p.id::text)
      or exists (select 1 from public.mw_posts x where p_name = any (x.paths) and (storage.foldername(p_name))[1] = x.page_id::text);
$$;
revoke all on function private.mw_open_folder(text) from public;
revoke all on function private.mw_my_folder(text) from public;
revoke all on function private.mw_visible_photo(text) from public;
grant usage on schema private to anon, authenticated;
grant execute on function private.mw_open_folder(text) to anon, authenticated;
grant execute on function private.mw_my_folder(text) to authenticated;
grant execute on function private.mw_visible_photo(text) to anon, authenticated;

drop policy if exists "mw guest upload" on storage.objects;
drop policy if exists "mw owner upload" on storage.objects;
drop policy if exists "mw owner read" on storage.objects;
drop policy if exists "mw owner delete" on storage.objects;
drop policy if exists "mw visible sign" on storage.objects;

create policy "mw guest upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'memory-photos'
    and private.mw_open_folder((storage.foldername(name))[1])
    and array_length(storage.foldername(name), 1) = 1
    and lower(storage.extension(name)) = 'jpg');
create policy "mw owner upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'memory-photos' and private.mw_my_folder((storage.foldername(name))[1])
    and lower(storage.extension(name)) = 'jpg');
create policy "mw owner read" on storage.objects for select to authenticated
  using (bucket_id = 'memory-photos' and private.mw_my_folder((storage.foldername(name))[1]));
create policy "mw owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'memory-photos' and private.mw_my_folder((storage.foldername(name))[1]));

do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'storage' and p.proname = 'allow_any_operation') then
    execute $p$create policy "mw visible sign" on storage.objects for select to anon, authenticated
      using (bucket_id = 'memory-photos'
             and storage.allow_any_operation(array['storage.object.sign','storage.object.sign_many'])
             and private.mw_visible_photo(name))$p$;
  else
    raise notice 'storage.allow_any_operation not found; sign policy limited to visible photos only';
    execute $p$create policy "mw visible sign" on storage.objects for select to anon, authenticated
      using (bucket_id = 'memory-photos' and private.mw_visible_photo(name))$p$;
  end if;
end $$;

-- Done! You should see "Success. No rows returned".
