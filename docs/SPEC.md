# Especificación — classic-tracker

## 1. Objetivo

Registrar cada sesión de la rutina de 5 días (lunes a viernes) con el mínimo esfuerzo, sugerir la progresión de cargas según reglas fijas y calcular KPIs consultables desde la PC. Un solo usuario, teléfono Android con Chrome, buena señal en el gimnasio pero la app debe funcionar sin ella.

## 2. Modelo de entrenamiento

Fuente: `data/seed_exercises.json`.

- Bloque de 6 semanas. RIR objetivo por semana: 3, 2, 2, 1, 0–1, 4.
  - Semana 5: RIR 0 permitido solo en ejercicios de máquina, polea o aislamiento; en multiarticulares libres el mínimo es 1. Campo derivado: `allows_failure` = no es uno de L1, M1, M2, X1, J1, V2 (ajustable en Ajustes).
- Series planificadas por ejercicio y semana:
  - Semanas 1–2: `base_sets`.
  - Semanas 3–5: `base_sets + 1` si `priority = true`.
  - Semana 6 (descarga): `ceil(series_semana_5 / 2)`.
- Volumen fraccional por músculo = suma de `muscle_factors[músculo]` por cada serie efectiva (1 = directa, 0,5 = sinergista). Las series de aproximación no cuentan.
- e1RM estimado = `carga × (1 + (reps + RIR) / 30)`. Solo series efectivas. Redondeo a 0,1 kg.
- Doble progresión: si en la última sesión de ese ejercicio todas las series efectivas llegaron a `rep_max` con RIR ≤ RIR objetivo de esa semana, la sesión siguiente precarga `carga + load_step_kg` y reps = `rep_min`, marcado como "Sugerido ↑". En otro caso precarga lo mismo que la última vez.
- `load_step_kg` es editable por ejercicio (las mancuernas del gimnasio pueden ir de 2 en 2 kg).

## 3. Pantallas

Navegación inferior con 4 pestañas: Hoy, Historial, Progreso, Yo. En pantallas ≥ 1024 px aparece además la pestaña Panel.

### 3.1 Hoy (prioridad absoluta)

1. Al abrir, detecta día de la semana y semana del bloque activo. Sábado/domingo: muestra "Descanso" y la próxima sesión.
2. Check-in opcional de 10 s: sueño, energía y dolor muscular, cada uno con 3 caritas. Se puede saltar.
3. Lista de ejercicios del día. Cada ejercicio muestra: nombre, objetivo, rango de reps, RIR de la semana, descanso, ajuste de máquina guardado (si existe) y las series precargadas.
4. Fila de serie: carga, reps, 5 botones de RIR (0, 1, 2, 3, 4+) y un check.
   - Tocar el check guarda la serie con los valores precargados.
   - Botones − / + junto a carga (paso `load_step_kg`) y reps (paso 1). Mantener presionado repite.
   - Nunca se abre el teclado numérico, salvo tocando dos veces el valor de carga.
5. Al marcar una serie arranca el temporizador de descanso (`rest_sec_min`), visible fijo abajo, con vibración al terminar (Vibration API). Se calcula con la hora de fin guardada, no con un contador, para sobrevivir a la app en segundo plano.
6. Wake Lock API activo mientras hay sesión abierta; se libera al terminar.
7. Botón "+ aproximación": agrega una serie marcada `is_warmup`, gris, que no cuenta para volumen, e1RM ni adherencia.
8. Mantener presionado un ejercicio abre sus sustitutos; elegir uno registra `performed_name` y `is_substitute = true`, conservando `exercise_id` para que el volumen se cuente igual.
9. Botón de dolor por serie: elige zona (hombro, codo, muñeca, lumbar, cadera, rodilla, otra). Si el mismo ejercicio tiene dolor en 2 sesiones seguidas, la próxima vez aparece un aviso que sugiere el primer sustituto.
10. Notas rápidas en chips: "ajuste de máquina", "agarre más abierto", "recorrido incompleto", "mucha fatiga", "técnica mejor". "Ajuste de máquina" pide un texto corto (por ejemplo "asiento 4") y se muestra en las sesiones futuras de ese ejercicio.
11. Récord: si una serie supera el mejor e1RM histórico del ejercicio, aparece una marca discreta.
12. La sesión se guarda continuamente; si la app se cierra, al abrirla vuelve al mismo ejercicio y serie.
13. "Terminar sesión": resumen de una pantalla con series hechas / planificadas, récords del día y ejercicios con carga sugerida para la próxima vez.

### 3.2 Historial

Lista de sesiones por fecha; al tocar una, se ven sus series. Se puede editar o borrar (borrado lógico) una serie mal registrada.

### 3.3 Progreso

- e1RM por ejercicio a lo largo de las semanas (selector de ejercicio).
- Volumen fraccional semanal por músculo contra el plan.
- Peso corporal con promedio móvil de 7 días.
- Medidas (cintura, brazo, muslo, pantorrilla).

### 3.4 Yo

- Registro de peso (un número) y medidas cada 2 semanas.
- Fotos de progreso: frente, perfil y espalda, guardadas solo en el teléfono (IndexedDB, no se suben a Supabase). Comparación lado a lado entre dos fechas.
- Modo pose: temporizador de 60 s con secuencia configurable de poses y descanso entre ellas.
- Respaldo: exportar e importar JSON completo; exportación automática semanal compartible con Web Share API (Drive, WhatsApp).
- Ajustes: bloque activo y fecha de inicio, `load_step_kg` por ejercicio, recordatorio de peso (día de la semana), cerrar sesión de Supabase.
- Estado de sincronización: "Todo sincronizado" / "N pendientes" / "Error, reintentando".

### 3.5 Panel (PC)

Tablero de KPIs leyendo las vistas de Supabase (sección 5), con filtro por bloque y semana, y botón "Exportar CSV" por vista para Excel.

## 4. Sincronización

1. Login con correo por enlace mágico de Supabase Auth; una vez iniciado, la sesión persiste.
2. Cola local: cada registro con `sync_status` (`pending` | `synced` | `error`) y `updated_at`.
3. Al recuperar conexión, al terminar una serie y cada 60 s con la app abierta: `upsert` por lotes de hasta 200 registros.
4. Conflictos: gana el `updated_at` más reciente.
5. Los errores no se muestran como bloqueo; solo cambian el indicador de estado.
6. Al instalar en un teléfono nuevo, descarga todo lo del usuario y lo guarda en IndexedDB.

## 5. KPIs (vistas SQL en `supabase/schema.sql`)

| Vista | Contenido |
|---|---|
| `v_e1rm_weekly` | Mejor e1RM por ejercicio, bloque y semana |
| `v_volume_weekly` | Series fraccionales por músculo, bloque y semana |
| `v_planned_sets_weekly` | Series planificadas por ejercicio y semana |
| `v_adherence_weekly` | Series hechas / planificadas por bloque y semana |
| `v_bodyweight_trend` | Peso diario y promedio móvil de 7 días |
| `v_pain_by_zone` | Series con dolor por zona, ejercicio y bloque |
| `v_readiness_vs_performance` | Check-in de la sesión junto al e1RM promedio relativo de esa sesión |

## 6. Fases y criterios de aceptación

### Fase 1 — Hoy + datos locales
- Carga el catálogo desde el JSON en IndexedDB en el primer arranque.
- Registrar una serie precargada toma 1 toque; ajustar carga y reps no abre el teclado.
- El temporizador vibra al terminar y sigue siendo correcto tras pasar 2 min en otra app.
- Cerrar y reabrir la app a mitad de sesión vuelve al mismo punto.
- Exportar e importar JSON funciona y conserva todo.
- Tests: series planificadas por semana (incluida la descarga), e1RM, volumen fraccional.

### Fase 2 — Sustitutos, aproximaciones, dolor, notas
- Las aproximaciones no aparecen en volumen ni e1RM.
- Un sustituto cuenta el volumen del ejercicio original.
- Dolor en 2 sesiones seguidas genera el aviso.
- El ajuste de máquina reaparece en la sesión siguiente.

### Fase 3 — Progresión y récords
- La regla de doble progresión precarga la carga correcta (tests con casos límite: una serie que no llegó, RIR por encima del objetivo, semana de descarga sin subir carga).
- Los récords se detectan contra el histórico de ese ejercicio.

### Fase 4 — Supabase y sincronización
- Esquema aplicado con RLS; un usuario no puede leer filas de otro (test con dos usuarios).
- Registrar 10 series sin red y reconectar sube exactamente 10 filas, sin duplicados tras un segundo envío.
- Instalación en un segundo navegador recupera todo.

### Fase 5 — Progreso, Yo y Panel
- Gráficos de Progreso con datos reales.
- Fotos nunca salen del teléfono.
- Panel muestra las 7 vistas y exporta CSV.

## 7. Fuera de alcance

Calorías y dieta, planes de otros usuarios, redes sociales, publicación en Play Store. Si más adelante hacen falta notificaciones con la pantalla bloqueada, se empaqueta con Capacitor (plugin Local Notifications) sin reescribir la app.
