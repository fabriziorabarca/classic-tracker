import * as db from './db.js';
import {
  DAYS, SESSION_NAMES, BLOCK_WEEKS, DELOAD_WEEK, plannedSets, rirTarget, rirLabel, e1rm,
  prefill, bestE1rm, blockWeek, weekdayName, todayISO, nextTrainingDay, mondayOf, formatDate,
  effective, uuid, isoAddDays, isCalibrationSet, calibrationBias,
} from './domain.js';

// ---------- Estado ----------
const params = new URLSearchParams(location.search);
const S = {
  tab: 'hoy',
  today: params.get('date') || todayISO(), // ?date=AAAA-MM-DD solo para pruebas
  day: null,            // día de rutina elegido (por defecto, el de hoy)
  exercises: [],
  exById: {},
  sessions: [],
  sets: [],
  block: null,          // { number, start }
  drafts: {},           // borradores de series sin registrar
  wakeLock: null,
};
const $view = document.getElementById('view');
const $rest = document.getElementById('rest');
const $toast = document.getElementById('toast');
const $modal = document.getElementById('modal');

// ---------- Utilidades ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtKg = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, '').replace('.', ','));
function restText(ex) {
  const a = ex.rest_sec_min; const b = ex.rest_sec_max;
  if (a >= 120) return a === b ? `${a / 60} min` : `${a / 60}–${b / 60} min`;
  if (b >= 120) return `${a} s–${b / 60} min`;
  return a === b ? `${a} s` : `${a}–${b} s`;
}
function mmss(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
function toast(msg, ms = 2200) {
  $toast.textContent = msg;
  $toast.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.add('hidden'), ms);
}
function vibrate(p) { try { navigator.vibrate?.(p); } catch { /* sin vibración */ } }

// ---------- Datos ----------
const SEED_VERSION = 2; // 2 = rutina aprobada del Bloque 2 (29/10/2026)
async function loadSeed() {
  const version = await db.getMeta('seedVersion');
  if (version === SEED_VERSION) return;
  const res = await fetch('data/seed_exercises.json');
  const seed = await res.json();
  const ids = new Set(seed.exercises.map((e) => e.id));
  for (const ex of seed.exercises) {
    const prev = await db.get('exercises', ex.id);
    const { allows_failure: _drop, ...rest } = ex;
    await db.put('exercises', {
      ...rest,
      active: true,
      load_step_kg: prev?.load_step_kg ?? ex.load_step_kg,
      machine_setting: prev?.machine_setting ?? '',
    });
  }
  // Ejercicios que ya no están en la rutina: se conservan para el historial, pero no se muestran.
  for (const old of await db.all('exercises')) {
    if (!ids.has(old.id) && old.active !== false) await db.put('exercises', { ...old, active: false });
  }
  // Quien venía del Bloque 1 pasa al Bloque 2, que empieza el próximo lunes (se puede cambiar en Yo).
  const block = await db.getMeta('block');
  if (version === 1 && block) {
    const start = weekdayName(S.today) === 'Lunes' ? S.today : isoAddDays(mondayOf(S.today), 7);
    await db.setMeta('block', { number: block.number + 1, start });
    S.migrated = true;
  }
  await db.setMeta('seedVersion', SEED_VERSION);
}

async function refresh() {
  const all = await db.all('exercises');
  S.exById = Object.fromEntries(all.map((e) => [e.id, e]));
  S.exercises = all.filter((e) => e.active !== false)
    .sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.order - b.order);
  S.sessions = (await db.all('sessions')).filter((s) => !s.deleted_at);
  S.sets = (await db.all('sets')).filter((s) => !s.deleted_at);
  S.block = await db.getMeta('block');
}

const sessionKey = () => `${S.today}|${S.day}`;
const currentSession = () => S.sessions.find((s) => s.date === S.today && s.day === S.day);
const setsOf = (sessionId) => S.sets.filter((s) => s.session_id === sessionId);
const week = () => (S.block ? blockWeek(S.block.start, S.today) : 0);

/** Última sesión anterior con series de ese ejercicio (excluye la actual). */
function lastPerformance(exId, excludeSessionId) {
  const bySession = new Map();
  for (const s of S.sets) {
    if (s.exercise_id !== exId || s.session_id === excludeSessionId || s.is_warmup) continue;
    if (!bySession.has(s.session_id)) bySession.set(s.session_id, []);
    bySession.get(s.session_id).push(s);
  }
  let best = null;
  for (const [sid, list] of bySession) {
    const ses = S.sessions.find((x) => x.id === sid);
    if (!ses) continue;
    if (!best || ses.started_at > best.ses.started_at) best = { ses, list };
  }
  return best;
}

async function saveDrafts() { await db.setMeta(`drafts:${sessionKey()}`, S.drafts); }

// ---------- Wake lock ----------
async function keepAwake(on) {
  try {
    if (on && !S.wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      S.wakeLock = await navigator.wakeLock.request('screen');
      S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
    } else if (!on && S.wakeLock) {
      await S.wakeLock.release();
      S.wakeLock = null;
    }
  } catch { /* el navegador puede negar el bloqueo; no es crítico */ }
}

// ---------- Temporizador de descanso ----------
let restTick = null;
async function startRest(ex) {
  const rest = { endAt: Date.now() + ex.rest_sec_min * 1000, name: ex.name, notified: false };
  await db.setMeta('rest', rest);
  runRest(rest);
}
function runRest(rest) {
  clearInterval(restTick);
  if (!rest) { $rest.classList.add('hidden'); return; }
  const paint = async () => {
    const left = rest.endAt - Date.now();
    if (left <= 0 && !rest.notified) {
      rest.notified = true;
      vibrate([300, 150, 300, 150, 600]);
      await db.setMeta('rest', rest);
    }
    if (left < -60000) { stopRest(); return; }
    $rest.classList.toggle('over', left <= 0);
    $rest.innerHTML = `
      <div class="time">${left > 0 ? mmss(left) : '¡Ya!'}</div>
      <div class="lbl"><span>${left > 0 ? 'Descanso' : 'Siguiente serie'}</span><span>${esc(rest.name)}</span></div>
      <button class="btn" data-action="rest-add">+15 s</button>
      <button class="btn" data-action="rest-stop">Saltar</button>`;
  };
  $rest.classList.remove('hidden');
  paint();
  restTick = setInterval(paint, 250);
  runRest.current = rest;
}
async function stopRest() {
  clearInterval(restTick);
  runRest.current = null;
  $rest.classList.add('hidden');
  await db.setMeta('rest', null);
}

// ---------- Acciones de series ----------
function draftFor(ex, n, planned, pre) {
  const key = `${ex.id}:${n}`;
  if (!S.drafts[key]) {
    const p = pre[n - 1] ?? pre[pre.length - 1];
    const cal = isCalibrationSet(ex, week(), n, planned);
    S.drafts[key] = { load: p.load, reps: p.reps, rir: cal ? 0 : rirTarget(week(), ex), up: p.up };
    if (cal) Object.assign(S.drafts[key], { rir_pred: rirTarget(week(), ex), reps_extra: null });
  }
  return S.drafts[key];
}

async function ensureSession() {
  let ses = currentSession();
  if (ses) return ses;
  const checkin = await db.getMeta(`checkin:${sessionKey()}`, {});
  ses = await db.put('sessions', {
    id: uuid(), block_number: S.block.number, week: week(), day: S.day, date: S.today,
    started_at: new Date().toISOString(), ended_at: null,
    sleep: checkin.sleep ?? null, energy: checkin.energy ?? null, soreness: checkin.soreness ?? null,
  });
  S.sessions.push(ses);
  return ses;
}

async function logSet(exId, n) {
  const ex = S.exById[exId];
  const d = S.drafts[`${exId}:${n}`];
  if (!d) return;
  if ('rir_pred' in d && d.reps_extra === null) {
    toast('Calibración: marca cuántas repeticiones hiciste de más después de estimar');
    return;
  }
  if (!(d.load > 0) && !confirm('La carga está en 0 kg. ¿Registrar igual? (usa 0 solo para peso corporal)')) return;
  const ses = await ensureSession();
  keepAwake(true);
  const history = S.sets.filter((s) => s.exercise_id === exId);
  const prevBest = bestE1rm(history);
  const value = e1rm(d.load, d.reps, d.rir);
  const row = await db.put('sets', {
    id: uuid(), session_id: ses.id, exercise_id: exId, performed_name: ex.name,
    is_substitute: false, is_warmup: false, set_no: n, load_kg: d.load, reps: d.reps, rir: d.rir,
    pain_zone: null, note_tags: [], note: '', created_at: new Date().toISOString(),
    deleted_at: null, record: prevBest > 0 && value > prevBest,
    ...('rir_pred' in d ? { rir_pred: d.rir_pred, reps_extra: d.reps_extra } : {}),
  });
  S.sets.push(row);
  delete S.drafts[`${exId}:${n}`];
  await saveDrafts();
  vibrate(40);
  if (row.record) toast(`Récord en ${ex.name}: e1RM ${fmtKg(value)} kg`);
  await db.setMeta('position', { key: sessionKey(), exId });
  startRest(ex);
  render();
}

async function undoSet(setId) {
  const row = S.sets.find((s) => s.id === setId);
  if (!row) return;
  const saved = await db.put('sets', { ...row, deleted_at: new Date().toISOString() });
  S.sets = S.sets.filter((s) => s.id !== setId);
  S.drafts[`${row.exercise_id}:${row.set_no}`] = {
    load: row.load_kg, reps: row.reps, rir: row.rir, up: false,
    ...('rir_pred' in row ? { rir_pred: row.rir_pred, reps_extra: row.reps_extra } : {}),
  };
  await saveDrafts();
  void saved;
  render();
}

function stepDraft(key, field, dir) {
  const d = S.drafts[key];
  if (!d) return;
  const ex = S.exById[key.split(':')[0]];
  if (field === 'load') {
    const step = Number(ex.load_step_kg) || 2.5;
    d.load = Math.max(0, Math.round((d.load + dir * step) * 100) / 100);
  } else {
    d.reps = Math.max(0, d.reps + dir);
  }
  d.up = false;
  paintDraft(key);
}
function paintDraft(key) {
  const d = S.drafts[key];
  const el = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!el || !d) return;
  el.querySelector('[data-val="load"]').textContent = fmtKg(d.load);
  el.querySelector('[data-val="reps"]').textContent = d.reps;
}

// ---------- Vistas ----------
function render() {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
  if (S.tab === 'hoy') renderToday();
  else if (S.tab === 'historial') renderHistory();
  else if (S.tab === 'progreso') renderProgress();
  else renderMe();
}

function dayChips() {
  return `<div class="chips" role="group" aria-label="Día de rutina">${DAYS.map((d) => `
    <button class="chip ${d === S.day ? 'on' : ''}" data-action="day" data-day="${d}">${d.slice(0, 3)} · ${SESSION_NAMES[d]}</button>`).join('')}</div>`;
}

function renderSetup() {
  const suggested = weekdayName(S.today) === 'Lunes' ? S.today : isoAddDays(mondayOf(S.today), 7);
  $view.innerHTML = `
    <h1>Bienvenido</h1>
    <p class="muted">Indica el lunes en que empieza tu Bloque 1. La app calcula la semana (1 a 6), el RIR y las series de cada día.</p>
    <div class="card">
      <label class="muted" for="start">Inicio del bloque</label>
      <div class="row" style="margin-top:8px"><input type="date" id="start" value="${suggested}"></div>
      <p class="muted small">Si eliges un día que no es lunes, se usará el lunes de esa semana.</p>
      <button class="btn primary block" data-action="save-block">Guardar y empezar</button>
    </div>`;
}

async function renderToday() {
  if (!S.block) { renderSetup(); return; }
  const w = week();
  const realDay = weekdayName(S.today);
  if (!S.day) S.day = DAYS.includes(realDay) ? realDay : null;

  if (w < 1) {
    $view.innerHTML = `<h1>Aún no empieza</h1><p class="muted">Tu Bloque ${S.block.number} empieza el ${formatDate(S.block.start)}.</p>
      <button class="btn block" data-tab="yo">Cambiar fecha de inicio</button>`;
    return;
  }
  if (w > BLOCK_WEEKS) {
    $view.innerHTML = `<h1>Bloque ${S.block.number} terminado</h1>
      <p class="muted">Completaste las 6 semanas. Revisa tu progreso y empieza el siguiente bloque.</p>
      <button class="btn primary block" data-action="new-block">Empezar Bloque ${S.block.number + 1} esta semana</button>`;
    return;
  }
  if (!S.day) {
    const next = nextTrainingDay(S.today);
    $view.innerHTML = `<h1>Descanso</h1>
      <p class="muted">Hoy ${realDay.toLowerCase()} no toca entrenar. Próxima sesión: ${next.name} · ${SESSION_NAMES[next.name]}.</p>
      <p class="muted small">¿Recuperas una sesión? Elige el día:</p>${dayChips()}`;
    return;
  }

  const ses = currentSession();
  const done = ses ? setsOf(ses.id) : [];
  S.drafts = { ...(await db.getMeta(`drafts:${sessionKey()}`, {})), ...S.drafts };
  const checkin = await db.getMeta(`checkin:${sessionKey()}`, null);
  const exs = S.exercises.filter((e) => e.day === S.day);

  let html = `
    <div class="row spread"><div>
      <h1>${S.day} · ${SESSION_NAMES[S.day]}</h1>
      <div class="muted">Bloque ${S.block.number} · semana ${w} de ${BLOCK_WEEKS}${w === DELOAD_WEEK ? ' · descarga' : ''} · ${formatDate(S.today)}</div>
    </div></div>
    ${dayChips()}`;

  if (!ses && !checkin) {
    const q = (k, label, faces) => `<div class="q"><span>${label}</span>${faces.map((f, i) => `
      <button class="face" data-action="checkin" data-k="${k}" data-v="${i + 1}" aria-label="${label} ${i + 1}">${f}</button>`).join('')}</div>`;
    html += `<div class="card checkin" id="checkin">
      <div class="row spread"><b>¿Cómo llegas hoy?</b><button class="btn ghost" data-action="checkin-skip">Saltar</button></div>
      ${q('sleep', 'Sueño', ['😴', '😐', '🙂'])}
      ${q('energy', 'Energía', ['🪫', '😐', '⚡'])}
      ${q('soreness', 'Dolor muscular', ['🔥', '😐', '🙂'])}
    </div>`;
  }

  let firstPending = null;
  for (const ex of exs) {
    const planned = plannedSets(ex, w);
    const last = lastPerformance(ex.id, ses?.id);
    const pre = prefill(ex, last?.list ?? [], last?.ses.week ?? w, w, planned);
    const logged = done.filter((s) => s.exercise_id === ex.id && !s.is_warmup);
    const anyUp = pre.some((p) => p.up) && logged.length === 0;
    const lastSorted = last ? effective(last.list).sort((a, b) => a.set_no - b.set_no) : [];
    const lastTxt = lastSorted.length
      ? `Última vez: ${lastSorted.map((s) => `${fmtKg(s.load_kg)}×${s.reps}`).join(' · ')}`
      : 'Primera vez: toca la carga para escribirla';
    html += `<section class="card ex ${logged.length >= planned ? 'done' : ''}" id="ex-${ex.id}">
      <h2><span class="num">${ex.order}</span><span>${esc(ex.name)}</span></h2>
      <div class="meta muted small">${esc(ex.target)} · ${ex.rep_min}–${ex.rep_max} reps · RIR ${rirLabel(w, ex)} · descanso ${restText(ex)}</div>
      ${ex.pain_zone ? `<div class="row wrap small"><span class="badge warn">Zona sensible: ${esc(ex.pain_zone)} · si duele la articulación, usa ${esc(ex.substitutes?.[0] ?? 'el sustituto')}</span></div>` : ''}
      <div class="row wrap small"><span class="muted">${lastTxt}</span>${anyUp ? '<span class="badge up">Sugerido ↑ carga</span>' : ''}${ex.machine_setting ? `<span class="badge">${esc(ex.machine_setting)}</span>` : ''}</div>`;
    for (let n = 1; n <= planned; n++) {
      const row = logged.find((s) => s.set_no === n);
      if (row) {
        html += `<div class="set logged"><div class="summary">
          <span><b>${n}.</b> ${fmtKg(row.load_kg)} kg × ${row.reps} · RIR ${row.rir}${row.record ? ' <span class="badge rec">Récord</span>' : ''}</span>
          <button class="undo" data-action="undo" data-id="${row.id}" aria-label="Deshacer serie ${n}">Deshacer</button></div></div>`;
        continue;
      }
      const key = `${ex.id}:${n}`;
      const d = draftFor(ex, n, planned, pre);
      const isNext = !firstPending;
      if (isNext) firstPending = ex.id;
      const calRow = 'rir_pred' in d ? `<div class="cal small">
          <p><b>Calibración.</b> Cuando creas que te quedan pocas, estima cuántas; luego sigue hasta el fallo real y anota el total.</p>
          <div class="bottom"><span class="label small">Creías</span>
            ${[0, 1, 2, 3, 4].map((r) => `<button class="rir ${d.rir_pred === r ? 'on' : ''}" data-action="rir-pred" data-key="${key}" data-v="${r}">${r === 4 ? '4+' : r}</button>`).join('')}</div>
          <div class="bottom"><span class="label small">De más</span>
            ${[0, 1, 2, 3, 4, 5, 6].map((r) => `<button class="rir ${d.reps_extra === r ? 'on' : ''}" data-action="reps-extra" data-key="${key}" data-v="${r}">${r === 6 ? '6+' : r}</button>`).join('')}</div>
        </div>` : '';
      html += `<div class="set ${isNext ? 'next' : ''}" data-key="${key}">${calRow}
        <div class="top">
          <span class="label">${n}</span>
          <div class="stepper"><button data-step="${key}|load|-1" aria-label="Menos carga">−</button>
            <button class="val" data-action="edit-load" data-key="${key}"><b data-val="load">${fmtKg(d.load)}</b><span>kg</span></button>
            <button data-step="${key}|load|1" aria-label="Más carga">+</button></div>
          <div class="stepper"><button data-step="${key}|reps|-1" aria-label="Menos repeticiones">−</button>
            <div class="val"><b data-val="reps">${d.reps}</b><span>reps</span></div>
            <button data-step="${key}|reps|1" aria-label="Más repeticiones">+</button></div>
        </div>
        <div class="bottom"><span class="label small">RIR</span>
          ${[0, 1, 2, 3, 4].map((r) => `<button class="rir ${d.rir === r ? 'on' : ''}" data-action="rir" data-key="${key}" data-v="${r}">${r === 4 ? '4+' : r}</button>`).join('')}
          <button class="check" data-action="log" data-ex="${ex.id}" data-n="${n}" aria-label="Registrar serie ${n}">✓</button>
        </div></div>`;
    }
    html += '</section>';
  }

  const plannedTotal = exs.reduce((s, e) => s + plannedSets(e, w), 0);
  const doneTotal = done.filter((s) => !s.is_warmup).length;
  html += `<div class="card"><div class="row spread"><span>Series: <b>${doneTotal}</b> de ${plannedTotal}</span>
    ${ses && !ses.ended_at ? '<button class="btn primary" data-action="finish">Terminar sesión</button>' : ''}
    ${ses?.ended_at ? '<span class="badge rec">Sesión terminada</span>' : ''}</div></div>`;
  await saveDrafts();
  $view.innerHTML = html;

  // Reanudar: llevar a la serie pendiente al abrir la app.
  if (renderToday.resume) {
    renderToday.resume = false;
    const pos = await db.getMeta('position');
    const target = firstPending ?? (pos?.key === sessionKey() ? pos.exId : null);
    if (ses && target) document.getElementById(`ex-${target}`)?.scrollIntoView({ block: 'start' });
  }
}
renderToday.resume = true;

async function finishSession() {
  const ses = currentSession();
  if (!ses) return;
  const w = week();
  const exs = S.exercises.filter((e) => e.day === S.day);
  const done = setsOf(ses.id).filter((s) => !s.is_warmup);
  const planned = exs.reduce((s, e) => s + plannedSets(e, w), 0);
  if (done.length < planned && !confirm(`Llevas ${done.length} de ${planned} series. ¿Terminar igual?`)) return;
  const updated = await db.put('sessions', { ...ses, ended_at: new Date().toISOString() });
  Object.assign(ses, updated);
  await stopRest();
  await keepAwake(false);
  const records = done.filter((s) => s.record).map((s) => S.exById[s.exercise_id].name);
  const nextW = Math.min(w + 1, BLOCK_WEEKS);
  const ups = exs.filter((e) => {
    const list = done.filter((s) => s.exercise_id === e.id);
    return list.length && prefill(e, list, w, nextW, 1)[0].up;
  }).map((e) => e.name);
  $modal.innerHTML = `<div class="sheet">
    <h1>Sesión terminada</h1>
    <p><b>${done.length}</b> de ${planned} series · ${S.day} · semana ${w}</p>
    <h2>Récords</h2><p class="muted">${records.length ? [...new Set(records)].map(esc).join('<br>') : 'Ninguno hoy.'}</p>
    <h2>Subir carga la próxima vez</h2><p class="muted">${ups.length ? ups.map(esc).join('<br>') : 'Ninguno: repite cargas y busca más repeticiones.'}</p>
    <button class="btn primary block" data-action="close-modal">Listo</button></div>`;
  $modal.classList.remove('hidden');
  render();
}

function renderHistory() {
  const list = [...S.sessions].sort((a, b) => b.started_at.localeCompare(a.started_at));
  if (!list.length) { $view.innerHTML = '<h1>Historial</h1><p class="muted">Aún no hay sesiones registradas.</p>'; return; }
  $view.innerHTML = `<h1>Historial</h1>${list.map((s) => {
    const sets = setsOf(s.id).filter((x) => !x.is_warmup).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const groups = {};
    for (const x of sets) (groups[x.exercise_id] ??= []).push(x);
    return `<details class="card"><summary><b>${formatDate(s.date)}</b> · ${s.day} · ${SESSION_NAMES[s.day]} <span class="muted">· sem ${s.week} · ${sets.length} series</span></summary>
      ${Object.entries(groups).map(([id, xs]) => `<div style="margin:8px 0"><b>${esc(S.exById[id]?.name ?? id)}</b>
        ${xs.map((x) => `<div class="row spread small"><span>${x.set_no}. ${fmtKg(x.load_kg)} kg × ${x.reps} · RIR ${x.rir} · e1RM ${fmtKg(e1rm(x.load_kg, x.reps, x.rir))}</span>
          <button class="btn ghost danger" style="min-height:40px" data-action="del-set" data-id="${x.id}">Borrar</button></div>`).join('')}</div>`).join('')}
      <button class="btn ghost danger" data-action="del-session" data-id="${s.id}">Borrar sesión</button></details>`;
  }).join('')}`;
}

function renderProgress() {
  const rows = S.exercises.map((ex) => {
    const sets = S.sets.filter((s) => s.exercise_id === ex.id);
    if (!sets.length) return '';
    const byWeek = {};
    for (const s of effective(sets)) {
      const ses = S.sessions.find((x) => x.id === s.session_id);
      if (!ses) continue;
      const k = `${ses.block_number}-${ses.week}`;
      byWeek[k] = Math.max(byWeek[k] ?? 0, e1rm(s.load_kg, s.reps, s.rir));
    }
    const vals = Object.entries(byWeek).sort();
    const first = vals[0]?.[1] ?? 0;
    const lastV = vals[vals.length - 1]?.[1] ?? 0;
    const pct = first ? ((lastV / first - 1) * 100).toFixed(1).replace('.', ',') : '0';
    return `<tr><td>${esc(ex.name)}</td><td class="n">${fmtKg(first)}</td><td class="n">${fmtKg(lastV)}</td><td class="n">${pct} %</td></tr>`;
  }).join('');
  const cal = calibrationBias(S.sets);
  const calCard = `<div class="card"><h2>Calibración del RIR</h2><p class="muted small">${cal
    ? `${cal.n} serie${cal.n === 1 ? '' : 's'} de calibración. ${cal.bias > 0
      ? `En promedio te quedaban ${fmtKg(cal.bias)} repeticiones más de las que creías: cuando estimes un RIR, réstale ${fmtKg(cal.bias)}.`
      : cal.bias < 0 ? `En promedio te quedaban ${fmtKg(-cal.bias)} repeticiones menos de las que creías: deja un poco más de margen.`
        : 'Tus estimaciones coinciden con lo que haces.'}`
    : 'Aún sin datos. En las semanas 1 y 2, la última serie de los ejercicios marcados va al fallo para medir tu sesgo.'}</p></div>`;
  $view.innerHTML = `<h1>Progreso</h1>${calCard}
    <p class="muted">Mejor e1RM estimado (kg): primera semana registrada contra la última. Los gráficos llegan en la Fase 5.</p>
    ${rows ? `<div class="card"><table><thead><tr><th>Ejercicio</th><th class="n">Inicio</th><th class="n">Actual</th><th class="n">Cambio</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Registra tu primera sesión para ver datos.</p>'}`;
}

function renderMe() {
  $view.innerHTML = `<h1>Yo</h1>
    <div class="card">
      <h2>Bloque ${S.block?.number ?? 1}</h2>
      <p class="muted">Inicio: ${S.block ? formatDate(S.block.start) : '—'} · semana actual: ${Math.max(0, week())}</p>
      <div class="row wrap"><input type="date" id="start" value="${S.block?.start ?? ''}">
      <button class="btn" data-action="save-block">Cambiar inicio</button></div>
    </div>
    <div class="card">
      <h2>Respaldo</h2>
      <p class="muted">Tus datos viven en este teléfono. Exporta un respaldo cada semana y guárdalo en Drive.</p>
      <div class="row wrap"><button class="btn primary" data-action="export">Exportar respaldo</button>
      <label class="btn" style="display:inline-flex;align-items:center">Importar<input type="file" id="import" accept="application/json,.json" hidden></label></div>
      <p class="muted small" id="last-export"></p>
    </div>
    <div class="card">
      <h2>Ajustes por ejercicio</h2>
      <p class="muted small">Paso de carga de los botones + y −, y el ajuste de máquina que verás en cada sesión.</p>
      ${S.exercises.map((ex) => `<div class="row spread" style="margin:8px 0;gap:6px">
        <span class="small" style="flex:1">${ex.id} · ${esc(ex.name)}</span>
        <select data-action="step" data-id="${ex.id}" aria-label="Paso de carga">${[0.5, 1, 1.25, 2, 2.5, 5].map((v) => `<option value="${v}" ${Number(ex.load_step_kg) === v ? 'selected' : ''}>${fmtKg(v)} kg</option>`).join('')}</select>
        <button class="btn ghost" style="min-height:44px" data-action="machine" data-id="${ex.id}">${ex.machine_setting ? esc(ex.machine_setting) : 'Ajuste'}</button></div>`).join('')}
    </div>`;
  db.getMeta('lastExport').then((t) => {
    const el = document.getElementById('last-export');
    if (el) el.textContent = t ? `Último respaldo: ${new Date(t).toLocaleString('es-PE')}` : 'Aún no has exportado un respaldo.';
  });
}

async function exportBackup() {
  const data = await db.exportAll();
  const name = `classic-tracker-${S.today}.json`;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Respaldo Classic Tracker' });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    await db.setMeta('lastExport', Date.now());
    toast('Respaldo exportado');
    render();
  } catch (e) {
    if (e?.name !== 'AbortError') toast('No se pudo exportar el respaldo');
  }
}

// ---------- Eventos ----------
let holdTimer = null; let holdRepeat = null;
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('[data-step]');
  if (!b) return;
  e.preventDefault();
  const [key, field, dir] = b.dataset.step.split('|');
  stepDraft(key, field, Number(dir));
  holdTimer = setTimeout(() => { holdRepeat = setInterval(() => stepDraft(key, field, Number(dir)), 110); }, 420);
});
const endHold = () => { clearTimeout(holdTimer); clearInterval(holdRepeat); holdTimer = holdRepeat = null; saveDrafts(); };
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => document.addEventListener(ev, endHold));

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action],[data-tab]');
  if (!t) return;
  if (t.dataset.tab && !t.dataset.action) {
    S.tab = t.dataset.tab; window.scrollTo(0, 0); render(); return;
  }
  const a = t.dataset.action;
  if (a === 'log') return logSet(t.dataset.ex, Number(t.dataset.n));
  if (a === 'undo') return undoSet(t.dataset.id);
  if (a === 'rir' || a === 'rir-pred' || a === 'reps-extra') {
    const field = { rir: 'rir', 'rir-pred': 'rir_pred', 'reps-extra': 'reps_extra' }[a];
    S.drafts[t.dataset.key][field] = Number(t.dataset.v);
    t.parentElement.querySelectorAll('.rir').forEach((x) => x.classList.toggle('on', x === t));
    return saveDrafts();
  }
  if (a === 'edit-load') {
    const d = S.drafts[t.dataset.key];
    const v = prompt('Carga en kg', String(d.load).replace('.', ','));
    if (v === null) return;
    const n = Number(v.replace(',', '.'));
    if (Number.isFinite(n) && n >= 0) { d.load = Math.round(n * 100) / 100; d.up = false; paintDraft(t.dataset.key); saveDrafts(); }
    return;
  }
  if (a === 'day') { S.day = t.dataset.day; S.drafts = {}; render(); return; }
  if (a === 'checkin' || a === 'checkin-skip') {
    const k = `checkin:${sessionKey()}`;
    const c = (await db.getMeta(k, {})) ?? {};
    if (a === 'checkin') {
      c[t.dataset.k] = Number(t.dataset.v);
      t.parentElement.querySelectorAll('.face').forEach((x) => x.classList.toggle('on', x === t));
    }
    await db.setMeta(k, c);
    if (a === 'checkin-skip' || (c.sleep && c.energy && c.soreness)) document.getElementById('checkin')?.remove();
    return;
  }
  if (a === 'finish') return finishSession();
  if (a === 'close-modal') { $modal.classList.add('hidden'); return; }
  if (a === 'rest-stop') return stopRest();
  if (a === 'rest-add' && runRest.current) {
    runRest.current.endAt = Math.max(runRest.current.endAt, Date.now()) + 15000;
    runRest.current.notified = false;
    await db.setMeta('rest', runRest.current);
    return;
  }
  if (a === 'save-block') {
    const v = document.getElementById('start').value;
    if (!v) return toast('Elige una fecha');
    S.block = { number: S.block?.number ?? 1, start: mondayOf(v) };
    await db.setMeta('block', S.block);
    S.tab = 'hoy'; render(); return;
  }
  if (a === 'new-block') {
    S.block = { number: S.block.number + 1, start: mondayOf(S.today) };
    await db.setMeta('block', S.block); render(); return;
  }
  if (a === 'export') return exportBackup();
  if (a === 'machine') {
    const ex = S.exById[t.dataset.id];
    const v = prompt(`Ajuste de máquina para ${ex.name} (por ejemplo "asiento 4")`, ex.machine_setting ?? '');
    if (v === null) return;
    await db.put('exercises', { ...ex, machine_setting: v.trim() });
    await refresh(); render(); return;
  }
  if (a === 'del-set' || a === 'del-session') {
    if (!confirm(a === 'del-set' ? '¿Borrar esta serie?' : '¿Borrar la sesión completa?')) return;
    const now = new Date().toISOString();
    if (a === 'del-set') {
      const row = S.sets.find((s) => s.id === t.dataset.id);
      await db.put('sets', { ...row, deleted_at: now });
    } else {
      const ses = S.sessions.find((s) => s.id === t.dataset.id);
      await db.put('sessions', { ...ses, deleted_at: now });
      for (const s of setsOf(ses.id)) await db.put('sets', { ...s, deleted_at: now });
    }
    await refresh(); render();
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.matches('select[data-action="step"]')) {
    const ex = S.exById[e.target.dataset.id];
    await db.put('exercises', { ...ex, load_step_kg: Number(e.target.value) });
    await refresh(); toast('Paso de carga guardado');
  }
  if (e.target.id === 'import' && e.target.files[0]) {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (!confirm('Importar reemplaza todos los datos de este teléfono por los del respaldo. ¿Continuar?')) return;
      await db.importAll(data);
      await refresh(); toast('Respaldo importado'); render();
    } catch (err) { toast(err.message || 'Archivo no válido'); }
  }
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  const ses = currentSession();
  if (ses && !ses.ended_at) keepAwake(true);
  if (runRest.current) runRest(runRest.current);
});

// ---------- Inicio ----------
(async function init() {
  await loadSeed();
  await refresh();
  render();
  if (S.migrated) toast(`Rutina del Bloque 2 cargada. Empieza el ${formatDate(S.block.start)}; puedes cambiar la fecha en Yo.`, 6000);
  const rest = await db.getMeta('rest');
  if (rest) runRest(rest);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.__app = S; // para pruebas
})();
