-- classic-tracker: esquema Supabase (PostgreSQL)
-- Ejecutar en el SQL Editor de Supabase o como migración.
-- Todas las tablas son por usuario y tienen RLS activado.

create extension if not exists pgcrypto;

-- ---------- Catálogo ----------
create table if not exists exercises (
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id             text not null,                 -- 'L1', 'M2', ...
  day            text not null check (day in ('Lunes','Martes','Miércoles','Jueves','Viernes')),
  sort_order     int  not null,
  name           text not null,
  target         text not null,
  synergists     text,
  base_sets      int  not null check (base_sets > 0),
  rep_min        int  not null,
  rep_max        int  not null check (rep_max >= rep_min),
  rest_sec_min   int  not null,
  rest_sec_max   int  not null,
  priority       boolean not null default false,
  allows_failure boolean not null default true,
  load_step_kg   numeric(5,2) not null default 2.5,
  machine_setting text,
  updated_at     timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists muscle_factors (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  exercise_id text not null,
  muscle      text not null,
  factor      numeric(3,2) not null check (factor in (0.5, 1)),
  primary key (user_id, exercise_id, muscle),
  foreign key (user_id, exercise_id) references exercises(user_id, id) on delete cascade
);

create table if not exists exercise_substitutes (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  exercise_id text not null,
  rank        int  not null,
  name        text not null,
  primary key (user_id, exercise_id, rank),
  foreign key (user_id, exercise_id) references exercises(user_id, id) on delete cascade
);

-- ---------- Bloques y sesiones ----------
create table if not exists blocks (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  number      int  not null,
  start_date  date not null,
  weeks       int  not null default 6,
  rir_by_week int[] not null default '{3,2,2,1,1,4}',
  notes       text,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table if not exists sessions (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  block_id    uuid not null references blocks(id),
  week        int  not null check (week between 1 and 6),
  day         text not null,
  started_at  timestamptz not null,
  ended_at    timestamptz,
  sleep       smallint check (sleep between 1 and 3),
  energy      smallint check (energy between 1 and 3),
  soreness    smallint check (soreness between 1 and 3),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table if not exists set_logs (
  id             uuid primary key,
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  session_id     uuid not null references sessions(id),
  exercise_id    text not null,
  performed_name text,
  is_substitute  boolean not null default false,
  is_warmup      boolean not null default false,
  set_no         int  not null,
  load_kg        numeric(6,2) not null check (load_kg >= 0),
  reps           int  not null check (reps >= 0),
  rir            smallint check (rir between 0 and 4),   -- 4 = "4+"
  pain_zone      text check (pain_zone in ('hombro','codo','muñeca','lumbar','cadera','rodilla','otra')),
  note_tags      text[] not null default '{}',
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create index if not exists set_logs_user_ex_idx on set_logs (user_id, exercise_id);
create index if not exists set_logs_session_idx on set_logs (session_id);

create table if not exists body_metrics (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date        date not null,
  weight_kg   numeric(5,2),
  waist_cm    numeric(5,1),
  arm_cm      numeric(5,1),
  thigh_cm    numeric(5,1),
  calf_cm     numeric(5,1),
  notes       text,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- ---------- RLS ----------
do $$
declare t text;
begin
  foreach t in array array['exercises','muscle_factors','exercise_substitutes','blocks','sessions','set_logs','body_metrics']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists own_rows on %I', t);
    execute format('create policy own_rows on %I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- ---------- Vistas de KPIs (security_invoker: respetan RLS) ----------

-- Series efectivas: no borradas, no aproximación, de sesiones no borradas.
create or replace view v_effective_sets with (security_invoker = on) as
select s.*, se.block_id, se.week, se.started_at::date as session_date
from set_logs s
join sessions se on se.id = s.session_id and se.deleted_at is null
where s.deleted_at is null and s.is_warmup = false;

create or replace view v_e1rm_weekly with (security_invoker = on) as
select user_id, block_id, week, exercise_id,
       round(max(load_kg * (1 + (reps + coalesce(rir, 0)) / 30.0)), 1) as best_e1rm_kg
from v_effective_sets
group by user_id, block_id, week, exercise_id;

create or replace view v_volume_weekly with (security_invoker = on) as
select e.user_id, e.block_id, e.week, mf.muscle,
       sum(mf.factor) as fractional_sets
from v_effective_sets e
join muscle_factors mf on mf.user_id = e.user_id and mf.exercise_id = e.exercise_id
group by e.user_id, e.block_id, e.week, mf.muscle;

create or replace view v_planned_sets_weekly with (security_invoker = on) as
with weeks as (select generate_series(1, 6) as week),
w5 as (
  select user_id, id, base_sets + case when priority then 1 else 0 end as sets_w5 from exercises
)
select x.user_id, x.id as exercise_id, w.week,
       case
         when w.week in (1, 2) then x.base_sets
         when w.week in (3, 4, 5) then x.base_sets + case when x.priority then 1 else 0 end
         else ceil(w5.sets_w5 / 2.0)::int
       end as planned_sets
from exercises x
join w5 on w5.user_id = x.user_id and w5.id = x.id
cross join weeks w;

create or replace view v_adherence_weekly with (security_invoker = on) as
with done as (
  select user_id, block_id, week, count(*) as done_sets
  from v_effective_sets group by user_id, block_id, week
),
planned as (
  select user_id, week, sum(planned_sets) as planned_sets
  from v_planned_sets_weekly group by user_id, week
)
select d.user_id, d.block_id, d.week, d.done_sets, p.planned_sets,
       round(d.done_sets::numeric / nullif(p.planned_sets, 0), 3) as adherence
from done d
join planned p on p.user_id = d.user_id and p.week = d.week;

create or replace view v_bodyweight_trend with (security_invoker = on) as
select user_id, date, weight_kg,
       round(avg(weight_kg) over (
         partition by user_id order by date
         range between interval '6 days' preceding and current row), 2) as weight_ma7_kg
from body_metrics
where deleted_at is null and weight_kg is not null;

create or replace view v_pain_by_zone with (security_invoker = on) as
select s.user_id, se.block_id, s.exercise_id, s.pain_zone, count(*) as sets_with_pain
from set_logs s
join sessions se on se.id = s.session_id and se.deleted_at is null
where s.deleted_at is null and s.pain_zone is not null
group by s.user_id, se.block_id, s.exercise_id, s.pain_zone;

-- e1RM de cada serie relativo al mejor e1RM previo del ejercicio; promedio por sesión.
create or replace view v_readiness_vs_performance with (security_invoker = on) as
with e as (
  select es.*, es.load_kg * (1 + (es.reps + coalesce(es.rir, 0)) / 30.0) as e1rm,
         max(es.load_kg * (1 + (es.reps + coalesce(es.rir, 0)) / 30.0)) over (
           partition by es.user_id, es.exercise_id order by es.created_at
           rows between unbounded preceding and 1 preceding) as prev_best
  from v_effective_sets es
)
select se.user_id, se.id as session_id, se.block_id, se.week, se.started_at::date as date,
       se.sleep, se.energy, se.soreness,
       round(avg(e.e1rm / nullif(e.prev_best, 0)), 3) as rel_performance
from sessions se
join e on e.session_id = se.id
where se.deleted_at is null
group by se.user_id, se.id, se.block_id, se.week, se.started_at, se.sleep, se.energy, se.soreness;
