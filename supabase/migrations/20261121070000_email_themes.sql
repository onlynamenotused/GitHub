-- Email themes: colours, festive symbols and a greeting line for every email (Service Desk emails and the portal sign-in email).
-- One theme is active. The sign-in email is a Supabase Auth template that can only read the user's metadata, so
-- activating a theme copies its values into every login's metadata as flat hd_* keys (missing keys = standard look).
create table if not exists public.email_themes (
  id bigint generated always as identity primary key,
  name text not null,
  page_bg text not null default '#f2f2f2', card_bg text not null default '#ffffff',
  text_c text not null default '#161616', muted text not null default '#5e5e5e', accent text not null default '#e8b923',
  btn_bg text not null default '#161616', btn_text text not null default '#ffffff',
  strip_bg text not null default '#161616', strip_text text not null default '#ffffff',
  symbols text not null default '', greeting text not null default '',
  builtin boolean not null default false, active boolean not null default false,
  updated_at timestamptz default now()
);
create unique index if not exists email_themes_one_active on public.email_themes (active) where active;
alter table public.email_themes enable row level security;
drop policy if exists email_themes_intranet on public.email_themes;
create policy email_themes_intranet on public.email_themes for all using (public.is_intranet()) with check (public.is_intranet());

insert into public.email_themes(name, page_bg, card_bg, text_c, muted, accent, btn_bg, btn_text, strip_bg, strip_text, symbols, greeting, builtin, active)
select * from (values
  ('Highway standard', '#f2f2f2', '#ffffff', '#161616', '#5e5e5e', '#e8b923', '#161616', '#ffffff', '#161616', '#ffffff', '', '', true, true),
  ('Christmas red', '#f4ece4', '#fffdf9', '#1f1f1f', '#5e5e5e', '#e8b923', '#9e1b1b', '#ffffff', '#9e1b1b', '#ffffff', '🎄 ❄ ★ ❄ 🎄', 'Merry Christmas and a safe New Year from all of us at Highway Digital', true, false),
  ('Christmas green', '#eef3ee', '#ffffff', '#1f1f1f', '#5e5e5e', '#c8102e', '#1e5b3a', '#ffffff', '#1e5b3a', '#ffffff', '❄ 🎁 ⛄ 🎁 ❄', 'Season''s greetings from the Highway Digital team', true, false)
) v(name,page_bg,card_bg,text_c,muted,accent,btn_bg,btn_text,strip_bg,strip_text,symbols,greeting,builtin,active)
where not exists (select 1 from public.email_themes);

-- Make a theme the one in use and push it into the sign-in email (login metadata).
create or replace function public.email_theme_activate(p_id bigint) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare t public.email_themes; m jsonb; n int;
begin
  if not (public.is_intranet() or current_user in ('postgres','supabase_admin','service_role')) then raise exception 'hello@ only'; end if;
  select * into t from public.email_themes where id = p_id;
  if not found then raise exception 'No such theme'; end if;
  update public.email_themes set active = false, updated_at = now() where active and id <> p_id;
  update public.email_themes set active = true, updated_at = now() where id = p_id;
  m := jsonb_build_object('hd_page', t.page_bg, 'hd_card', t.card_bg, 'hd_text', t.text_c, 'hd_muted', t.muted, 'hd_accent', t.accent,
         'hd_btn', t.btn_bg, 'hd_btntext', t.btn_text, 'hd_strip', t.strip_bg, 'hd_striptext', t.strip_text,
         'hd_symbols', t.symbols, 'hd_greeting', t.greeting);
  update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) - array['hd_page','hd_card','hd_text','hd_muted','hd_accent','hd_btn','hd_btntext','hd_strip','hd_striptext','hd_symbols','hd_greeting'] || m;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'theme', t.name, 'logins', n);
end $$;
revoke all on function public.email_theme_activate(bigint) from public, anon;
grant execute on function public.email_theme_activate(bigint) to authenticated;

-- New logins pick up the theme in use straight away.
create or replace function public.email_theme_new_login() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare t public.email_themes;
begin
  begin
    select * into t from public.email_themes where active limit 1;
    if found then
      new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('hd_page', t.page_bg, 'hd_card', t.card_bg, 'hd_text', t.text_c,
        'hd_muted', t.muted, 'hd_accent', t.accent, 'hd_btn', t.btn_bg, 'hd_btntext', t.btn_text, 'hd_strip', t.strip_bg, 'hd_striptext', t.strip_text,
        'hd_symbols', t.symbols, 'hd_greeting', t.greeting);
    end if;
  exception when others then null; -- never block a sign-up over email colours
  end;
  return new;
end $$;
drop trigger if exists email_theme_new_login on auth.users;
create trigger email_theme_new_login before insert on auth.users for each row execute function public.email_theme_new_login();
