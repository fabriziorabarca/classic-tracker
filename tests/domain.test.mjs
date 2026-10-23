import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  plannedSets, e1rm, fractionalVolume, prefill, blockWeek, weekdayName, rirTarget,
  nextTrainingDay, mondayOf, bestE1rm,
} from '../js/domain.js';

const seed = JSON.parse(readFileSync(new URL('../data/seed_exercises.json', import.meta.url)));
const EX = seed.exercises;
const byId = Object.fromEntries(EX.map((e) => [e.id, e]));
const total = (w) => EX.reduce((s, e) => s + plannedSets(e, w), 0);

test('series planificadas totales por semana coinciden con el Excel', () => {
  assert.equal(EX.length, 32);
  assert.equal(total(1), 89);
  assert.equal(total(2), 89);
  assert.equal(total(3), 98);
  assert.equal(total(5), 98);
});

test('descarga = mitad de la semana 5 redondeando hacia arriba', () => {
  assert.equal(plannedSets(byId.X4, 6), 3); // 4+1=5 -> 3
  assert.equal(plannedSets(byId.L3, 6), 1); // 2 -> 1
  assert.equal(plannedSets(byId.M5, 6), 2); // 4 -> 2
  assert.equal(total(6), 55);
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
  assert.deepEqual(fractionalVolume(sets, byId), { Pecho: 1, 'Deltoides anterior': 0.5, 'Tríceps': 0.5 });
});

test('volumen semanal de la semana 1 por músculo', () => {
  const sets = EX.flatMap((e) => Array.from({ length: plannedSets(e, 1) }, () => ({ exercise_id: e.id, load_kg: 1, reps: 1 })));
  const v = fractionalVolume(sets, byId);
  assert.equal(v.Pecho, 10);
  assert.equal(v['Dorsal y espalda'], 14);
  assert.equal(v['Deltoides lateral'], 11.5);
  assert.equal(v['Cuádriceps'], 12);
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
  assert.deepEqual(prefill(byId.M1, [], 1, 1, 1), [{ load: 0, reps: 6, up: false }]);
});

test('RIR objetivo semana 5 según tipo de ejercicio', () => {
  assert.equal(rirTarget(5, byId.M1), 1);
  assert.equal(rirTarget(5, byId.M3), 0);
  assert.equal(rirTarget(1, byId.M3), 3);
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
