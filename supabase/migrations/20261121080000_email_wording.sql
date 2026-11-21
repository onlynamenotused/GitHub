-- Editable wording for customer emails (Service Desk emails and the portal sign-in email). Empty = built-in wording.
create table if not exists public.email_wording (key text primary key, value text not null default '', updated_at timestamptz default now());
alter table public.email_wording enable row level security;
drop policy if exists email_wording_intranet on public.email_wording;
create policy email_wording_intranet on public.email_wording for all using (public.is_intranet()) with check (public.is_intranet());

-- Sign-in email wording travels in each login's metadata (hd_si_* keys), like the theme colours.
create or replace function public.email_signin_meta() returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_object_agg('hd_' || key, value), '{}'::jsonb) from public.email_wording where key like 'si\_%' and value <> ''
$$;
create or replace function public.email_wording_save(p jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare k text; v text; n int;
begin
  if not (public.is_intranet() or current_user in ('postgres','supabase_admin','service_role')) then raise exception 'hello@ only'; end if;
  for k, v in select * from jsonb_each_text(p) loop
    if k !~ '^[a-z]{2}_[a-z_]{2,30}$' then raise exception 'Bad key %', k; end if;
    if coalesce(trim(v),'') = '' then delete from public.email_wording where key = k;
    else insert into public.email_wording(key, value) values (k, left(v, 2000)) on conflict (key) do update set value = excluded.value, updated_at = now(); end if;
  end loop;
  update auth.users set raw_user_meta_data = (coalesce(raw_user_meta_data, '{}'::jsonb) - array['hd_si_intro','hd_si_btn','hd_si_code','hd_si_ignore','hd_si_hi']) || public.email_signin_meta();
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'logins', n);
end $$;
revoke all on function public.email_wording_save(jsonb) from public, anon;
grant execute on function public.email_wording_save(jsonb) to authenticated;

-- New logins get the theme and the sign-in wording.
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
    new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb) || public.email_signin_meta();
  exception when others then null;
  end;
  return new;
end $$;
