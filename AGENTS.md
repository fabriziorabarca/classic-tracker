# AGENTS.md — classic-tracker

App personal (un solo usuario) para registrar entrenamiento de hipertrofia orientado a NPC Classic Physique y medir progreso. Lee `docs/SPEC.md` antes de escribir código; es la fuente de verdad del producto.

## Estado

Fase 1 terminada (pantalla Hoy, registro de un toque, temporizador, reanudación, resumen, respaldo JSON). La siguiente es la Fase 2 de `docs/SPEC.md`.

Rutina vigente: Bloque 2, aprobada por el usuario el 29/10/2026 (`data/seed_exercises.json`, `version: 2`). Cada ejercicio trae `rir_class` (`machine` | `free` | `pain`), `pain_zone` y `calibrate`; el RIR por semana sale de `RIR_BY_CLASS` en `js/domain.js`. Los IDs del Bloque 1 que salieron están en `retired_ids` y la app los marca `active: false` (se conservan para el historial). No cambies ejercicios, series ni RIR sin que el usuario lo apruebe.

## Stack (sin dependencias ni paso de build)

- HTML + CSS + JavaScript en módulos ES nativos. No agregar frameworks ni bundlers sin pedirlo.
- PWA: `manifest.webmanifest` + `sw.js` (caché primero, actualiza en segundo plano). Al cambiar cualquier archivo servido, subir `VERSION` en `sw.js`.
- Datos locales: IndexedDB mediante `js/db.js`. Es la fuente primaria: la app nunca espera a la red para guardar.
- Nube (Fase 4): Supabase (PostgreSQL + Auth) con su cliente JS cargado como módulo ES. Esquema en `supabase/schema.sql`.
- Se publica tal cual en GitHub Pages (`.github/workflows/pages.yml`).
- Idioma de la interfaz: español (Perú). Unidades SI: kg, cm. Fechas dd/mm/aaaa.

## Archivos

```
index.html, styles.css, manifest.webmanifest, sw.js, icons/
js/domain.js   # lógica pura (sin DOM ni IndexedDB) — con tests
js/db.js       # IndexedDB: stores meta, exercises, sessions, sets, body
js/app.js      # interfaz y eventos
data/seed_exercises.json
tests/domain.test.mjs   # node --test
e2e/e2e.py              # Playwright para Python, Chromium móvil
docs/SPEC.md, supabase/schema.sql
```

## Comandos

- `npm run serve` — servidor local en http://localhost:5173 (también `python3 -m http.server`).
- `npm test` — tests de dominio (Node 20+ con `node --test`).
- `npm run e2e` — flujo completo en Chromium; deja capturas en `e2e/shots/`.
- `?date=AAAA-MM-DD` en la URL fija la fecha, solo para pruebas.

Antes de dar una tarea por terminada: `npm test` y `npm run e2e` deben pasar.

## Reglas obligatorias

1. Offline primero. Toda escritura va a IndexedDB con `sync_status = 'pending'` (lo pone `db.put`). La sincronización correrá en segundo plano y nunca bloqueará la interfaz.
2. Cada registro (serie, sesión, medida) tiene un `id` UUID v4 generado en el teléfono. La subida a Supabase usará `upsert` por `id`.
3. Borrado lógico: `deleted_at`, nunca borrado físico desde la app.
4. Seguridad: en el cliente solo la clave pública (`anon`) de Supabase. Nunca usar ni commitear la clave `service_role`. RLS activado en todas las tablas.
5. Registrar una serie normal = 1 toque. No abrir el teclado durante la sesión salvo al tocar el valor de carga o en notas libres.
6. Las fórmulas de entrenamiento viven en `js/domain.js` como funciones puras con tests.
7. No inventar ejercicios, factores musculares ni reglas: salen de `data/seed_exercises.json` y de `docs/SPEC.md`. Si algo falta, deja un `TODO` y pregunta.
8. Pantalla Hoy: botones de al menos 48–56 px, modo oscuro, contraste AA.

## Fases

Trabaja una fase a la vez, en el orden de `docs/SPEC.md`, y no empieces la siguiente sin que se cumplan los criterios de aceptación de la actual.
