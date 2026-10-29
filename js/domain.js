// Lógica pura de entrenamiento. Sin acceso a DOM ni a IndexedDB.
// Cada función tiene tests en tests/domain.test.mjs.

export const BLOCK_WEEKS = 6;
export const DELOAD_WEEK = 6;
export const CALIBRATION_WEEKS = [1, 2];
export const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];
export const SESSION_NAMES = {
  Lunes: 'Torso A', Martes: 'Pierna A', 'Miércoles': 'Torso B', Jueves: 'Pierna B', Viernes: 'Torso C',
};
// RIR por semana (1..6) según el tipo de ejercicio (rutina aprobada del Bloque 2).
// machine: máquinas y poleas sin dolor · free: compuestos con peso libre (nunca al fallo)
// pain: ejercicios que cargan una zona con dolor (mínimo RIR 2 hasta la evaluación).
// target = número que se precarga y que usa la doble progresión; label = rango que se muestra.
export const RIR_BY_CLASS = {
  machine: { target: [3, 2, 2, 1, 1, 4], label: ['3', '2', '1–2', '1', '0–1', '3–4'] },
  free: { target: [3, 2, 2, 2, 1, 4], label: ['3', '2', '2', '1–2', '1', '3–4'] },
  pain: { target: [3, 2, 2, 2, 2, 4], label: ['3', '2', '2', '2', '2', '3–4'] },
};

const MS_DAY = 86400000;

/** Fecha local 'YYYY-MM-DD' -> número de días desde época (sin zona horaria). */
export function dayNumber(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / MS_DAY);
}

export function todayISO(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Nombre del día en español para una fecha ISO, o null si es fin de semana. */
export function weekdayName(iso) {
  const idx = (dayNumber(iso) + 4) % 7; // 1970-01-01 fue jueves -> 0 = domingo
  return ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'][idx];
}

/** Semana del bloque (1..6) para una fecha; 0 si es antes del inicio, 7+ si el bloque terminó. */
export function blockWeek(startISO, dateISO) {
  const diff = dayNumber(dateISO) - dayNumber(startISO);
  if (diff < 0) return 0;
  return Math.floor(diff / 7) + 1;
}

const rirRow = (ex) => RIR_BY_CLASS[ex?.rir_class] ?? RIR_BY_CLASS.machine;
const clampWeek = (week) => Math.min(Math.max(week, 1), BLOCK_WEEKS) - 1;

/** Solo las máquinas y poleas sin dolor pueden llegar al fallo (semana 5 o calibración). */
export function allowsFailure(ex) {
  return (ex?.rir_class ?? 'machine') === 'machine';
}

/** RIR objetivo numérico para un ejercicio en una semana. */
export function rirTarget(week, ex) {
  return rirRow(ex).target[clampWeek(week)];
}

/** Texto del RIR de la semana. Sin ejercicio: el de máquinas (cabecera). */
export function rirLabel(week, ex) {
  return rirRow(ex).label[clampWeek(week)];
}

/** La última serie de un ejercicio de calibración, en las semanas 1 y 2, va al fallo real. */
export function isCalibrationSet(ex, week, setNo, planned) {
  return Boolean(ex?.calibrate) && CALIBRATION_WEEKS.includes(week) && setNo === planned;
}

/**
 * Sesgo de calibración: repeticiones que hiciste de más respecto de las que creías tener.
 * Positivo = subestimas tu reserva (te quedas más lejos del fallo de lo que crees).
 */
export function calibrationBias(sets) {
  const cal = effective(sets).filter((s) => Number.isFinite(s.rir_pred) && Number.isFinite(s.reps_extra));
  if (!cal.length) return null;
  const sum = cal.reduce((a, s) => a + (s.reps_extra - s.rir_pred), 0);
  return { n: cal.length, bias: Math.round((sum / cal.length) * 10) / 10 };
}

/** Series planificadas de un ejercicio en una semana (1..6). */
export function plannedSets(ex, week) {
  const extra = ex.priority ? 1 : 0;
  if (week <= 2) return ex.base_sets;
  if (week <= 5) return ex.base_sets + extra;
  return Math.ceil((ex.base_sets + extra) / 2);
}

/** e1RM estimado (Epley sobre repeticiones posibles). Redondeado a 0,1 kg. */
export function e1rm(loadKg, reps, rir = 0) {
  if (!(loadKg > 0) || !(reps > 0)) return 0;
  return Math.round(loadKg * (1 + (reps + (rir ?? 0)) / 30) * 10) / 10;
}

/** Series efectivas: no borradas y no aproximación. */
export function effective(sets) {
  return sets.filter((s) => !s.deleted_at && !s.is_warmup);
}

/** Volumen fraccional por músculo: { músculo: series } */
export function fractionalVolume(sets, exercisesById) {
  const out = {};
  for (const s of effective(sets)) {
    const ex = exercisesById[s.exercise_id];
    if (!ex) continue;
    for (const [muscle, f] of Object.entries(ex.muscle_factors)) {
      out[muscle] = (out[muscle] ?? 0) + f;
    }
  }
  return out;
}

export function roundToStep(value, step) {
  return Math.round(Math.round(value / step) * step * 100) / 100;
}

/**
 * Valores precargados para la próxima sesión de un ejercicio.
 * lastSets: series efectivas de la última sesión de ese ejercicio, ordenadas por set_no.
 * lastWeek: semana del bloque en que se hicieron. currentWeek: semana actual.
 * Devuelve { load, reps, up } por serie planificada.
 */
export function prefill(ex, lastSets, lastWeek, currentWeek, count) {
  const sets = effective(lastSets ?? []).sort((a, b) => a.set_no - b.set_no);
  if (sets.length === 0) {
    return Array.from({ length: count }, () => ({ load: 0, reps: ex.rep_min, up: false }));
  }
  const target = rirTarget(lastWeek, ex);
  const lastPlanned = plannedSets(ex, lastWeek);
  const completeAll = sets.length >= lastPlanned
    && sets.every((s) => s.reps >= ex.rep_max && (s.rir ?? 0) <= target);
  const goUp = completeAll && currentWeek !== DELOAD_WEEK;
  const step = Number(ex.load_step_kg) || 2.5;
  return Array.from({ length: count }, (_, i) => {
    const ref = sets[Math.min(i, sets.length - 1)];
    if (goUp) return { load: Math.round((ref.load_kg + step) * 100) / 100, reps: ex.rep_min, up: true };
    return { load: ref.load_kg, reps: ref.reps, up: false };
  });
}

/** Mejor e1RM histórico de un ejercicio dentro de una lista de series. */
export function bestE1rm(sets) {
  return effective(sets).reduce((m, s) => Math.max(m, e1rm(s.load_kg, s.reps, s.rir)), 0);
}

/** Próximo día de entrenamiento a partir de una fecha ISO (para fines de semana). */
export function nextTrainingDay(iso) {
  for (let i = 1; i <= 7; i++) {
    const name = weekdayName(isoAddDays(iso, i));
    if (DAYS.includes(name)) return { iso: isoAddDays(iso, i), name };
  }
  return null;
}

export function isoAddDays(iso, n) {
  const t = (dayNumber(iso) + n) * MS_DAY;
  return new Date(t).toISOString().slice(0, 10);
}

/** Lunes de la semana de una fecha ISO. */
export function mondayOf(iso) {
  const idx = (dayNumber(iso) + 4) % 7; // 0 domingo
  const back = idx === 0 ? 6 : idx - 1;
  return isoAddDays(iso, -back);
}

export function formatDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
