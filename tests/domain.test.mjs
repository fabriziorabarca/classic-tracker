import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  plannedSets, e1rm, fractionalVolume, prefill, blockWeek, weekdayName, rirTarget, rirLabel,
  nextTrainingDay, mondayOf, bestE1rm, allowsFailure, isCalibrationSet, calibrationBias,
} from '../js/domain.js';

const seed = JSON.parse(readFileSync(new URL('../data/seed_exercises.json', import.meta.url)));
const EX = seed.exercises;
const byId = Object.fromEntries(EX.map((e) => [e.id, e]));
const total = (w) => EX.reduce((s, e) => s + plannedSets(e, w), 0);

const day = (d, w) => EX.filter((e) => e.day === d).reduce((s, e) => s + plannedSets(e, w), 0);

test('series totales por semana coinciden con la rutina aprobada (Bloque 2)', () => {
  assert.equal(EX.length, 32);
  assert.equal(total(1), 92);
  assert.equal(total(2), 92);
  assert.equal(total(3), 99);
  assert.equal(total(5), 99);
  assert.deepEqual(['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'].map((d) => day(d, 1)), [18, 18, 18, 19, 19]);
  assert.deepEqual(['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'].map((d) => day(d, 3)), [20, 19, 20, 20, 20]);
});

test('solo 7 ejercicios suman serie en semanas 3–5', () => {
  assert.deepEqual(EX.filter((e) => e.priority).map((e) => e.id).sort(), ['J1', 'L2', 'N3', 'N7', 'V6', 'X4', 'X6']);
});

test('descarga = mitad de la semana 5 redondeando hacia arriba', () => {
  assert.equal(plannedSets(byId.X4, 6), 2); // 3+1=4 -> 2
  assert.equal(plannedSets(byId.J3, 6), 1); // 2 -> 1
  assert.equal(plannedSets(byId.M5, 6), 2); // 3 -> 2
  assert.equal(total(6), 60);
});

test('ejercicios retirados por dolor no están en la rutina', () => {
  for (const id of ['X1', 'L7', 'X5', 'V2', 'V7', 'V4']) assert.equal(byId[id], undefined, id);
  assert.ok(seed.retired_ids.includes('X1'));
});

test('e1RM', () => {
  assert.equal(e1rm(24, 9, 3), 33.6);
  assert.equal(e1rm(100, 5, 0), 116.7);
  assert.equal(e1rm(0, 10, 2), 0);
  assert.equal(e1rm(50, 10, null), 66.7);
});

test('volumen fraccional ignora aproximaciones y borradas', () => {
  const sets = [
    { exercise_id: 'L1', load_kg: 24, reps: 8, rir: 2 },
    { exercise_id: 'L1', load_kg: 10, reps: 10, rir: 5, is_warmup: true },
    { exercise_id: 'L2', load_kg: 50, reps: 10, rir: 2, deleted_at: '2026-10-26' },
  ];
  assert.deepEqual(fractionalVolume(sets, byId), { Pecho: 1, 'Tríceps': 0.5, 'Deltoides anterior': 0.5 });
});

const weekVolume = (w) => fractionalVolume(
  EX.flatMap((e) => Array.from({ length: plannedSets(e, w) }, () => ({ exercise_id: e.id, load_kg: 1, reps: 1 }))), byId);

test('volumen semanal por músculo = el del documento aprobado', () => {
  assert.deepEqual(weekVolume(1), {
    Dorsal: 14, 'Tríceps': 12, 'Deltoides lateral': 12, Abdomen: 12,
    'Cuádriceps': 11, Isquiotibiales: 9, 'Espalda media': 8.5, Pecho: 8, 'Deltoides posterior': 8,
    'Glúteo': 7.5, 'Bíceps': 7.5, Pantorrillas: 6, 'Deltoides anterior': 3,
  });
  const v3 = weekVolume(3);
  assert.equal(v3.Dorsal, 16);
  assert.equal(v3['Tríceps'], 13);
  assert.equal(v3['Deltoides lateral'], 14);
  assert.equal(v3.Abdomen, 14);
  assert.equal(v3['Bíceps'], 8.5);
});

test('doble progresión: sube si todas llegaron al tope con el RIR objetivo', () => {
  const ex = byId.L1; // 6-10 reps, 3 series, paso 1 kg
  const last = [1, 2, 3].map((n) => ({ set_no: n, load_kg: 24, reps: 10, rir: 2 }));
  const p = prefill(ex, last, 2, 3, 4);
  assert.equal(p.length, 4);
  assert.deepEqual(p[0], { load: 24 + ex.load_step_kg, reps: 6, up: true });
});

test('doble progresión: no sube si una serie no llegó', () => {
  const last = [{ set_no: 1, load_kg: 24, reps: 10, rir: 2 }, { set_no: 2, load_kg: 24, reps: 9, rir: 2 }, { set_no: 3, load_kg: 24, reps: 10, rir: 2 }];
  const p = prefill(byId.L1, last, 2, 3, 3);
  assert.deepEqual(p.map((x) => x.up), [false, false, false]);
  assert.equal(p[1].reps, 9);
});

test('doble progresión: no sube si el RIR quedó por encima del objetivo', () => {
  const last = [1, 2, 3].map((n) => ({ set_no: n, load_kg: 24, reps: 10, rir: 3 }));
  assert.equal(prefill(byId.L1, last, 2, 3, 3)[0].up, false);
});

test('doble progresión: no sube si faltaron series', () => {
  const last = [1, 2].map((n) => ({ set_no: n, load_kg: 24, reps: 10, rir: 2 }));
  assert.equal(prefill(byId.L1, last, 2, 3, 3)[0].up, false);
});

test('doble progresión: en descarga no sube carga', () => {
  const last = [1, 2, 3, 4].map((n) => ({ set_no: n, load_kg: 24, reps: 10, rir: 1 }));
  assert.equal(prefill(byId.L1, last, 5, 6, 2)[0].up, false);
});

test('sin historial: carga 0 y reps mínimas', () => {
  assert.deepEqual(prefill(byId.M1, [], 1, 1, 1), [{ load: 0, reps: 8, up: false }]);
});

test('RIR por tipo: máquinas, zonas con dolor y descarga', () => {
  assert.equal(rirTarget(1, byId.M3), 3);
  assert.equal(rirLabel(3, byId.M3), '1–2');
  assert.equal(rirLabel(5, byId.M3), '0–1');
  assert.equal(rirTarget(5, byId.M1), 2); // hack: cadera, mínimo RIR 2
  assert.equal(rirTarget(4, byId.X6), 2); // pushdown: codo
  assert.equal(rirLabel(6, byId.X6), '3–4');
  assert.equal(allowsFailure(byId.M3), true);
  assert.equal(allowsFailure(byId.L1), false);
  assert.equal(rirTarget(5, { rir_class: 'free' }), 1);
  for (const w of [1, 2, 3, 4, 5]) {
    for (const e of EX.filter((x) => x.pain_zone)) assert.ok(rirTarget(w, e) >= 2, `${e.id} semana ${w}`);
  }
});

test('calibración: última serie de M3, M4, V6 y N7 en semanas 1 y 2', () => {
  assert.deepEqual(EX.filter((e) => e.calibrate).map((e) => e.id).sort(), ['M3', 'M4', 'N7', 'V6']);
  assert.equal(isCalibrationSet(byId.M3, 1, 3, 3), true);
  assert.equal(isCalibrationSet(byId.M3, 1, 2, 3), false);
  assert.equal(isCalibrationSet(byId.M3, 3, 3, 3), false);
  assert.equal(isCalibrationSet(byId.L1, 1, 3, 3), false);
  assert.equal(calibrationBias([]), null);
  assert.deepEqual(calibrationBias([
    { rir_pred: 1, reps_extra: 3 }, { rir_pred: 2, reps_extra: 3 }, { rir_pred: 2, reps_extra: 2, deleted_at: 'x' },
    { load_kg: 10, reps: 10 },
  ]), { n: 2, bias: 1.5 });
});

test('fechas', () => {
  assert.equal(weekdayName('2026-10-26'), 'Lunes');
  assert.equal(weekdayName('2026-10-25'), 'Domingo');
  assert.equal(blockWeek('2026-10-26', '2026-10-26'), 1);
  assert.equal(blockWeek('2026-10-26', '2026-11-02'), 2);
  assert.equal(blockWeek('2026-10-26', '2026-10-25'), 0);
  assert.deepEqual(nextTrainingDay('2026-10-24'), { iso: '2026-10-26', name: 'Lunes' });
  assert.equal(mondayOf('2026-10-22'), '2026-10-19');
  assert.equal(mondayOf('2026-10-25'), '2026-10-19');
});

test('mejor e1RM ignora aproximaciones', () => {
  assert.equal(bestE1rm([{ load_kg: 100, reps: 5, rir: 0, is_warmup: true }, { load_kg: 80, reps: 5, rir: 0 }]), 93.3);
});
