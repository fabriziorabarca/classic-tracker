# Prompt para Codex — Fase 2

La Fase 1 ya está construida y probada. Copia este texto en Codex con el repositorio abierto:

---

Lee AGENTS.md y docs/SPEC.md completos. La Fase 1 está terminada; no cambies su comportamiento salvo para integrar lo nuevo. Construye la Fase 2 de docs/SPEC.md y nada más: series de aproximación, sustitutos (mantener presionado el ejercicio), botón de dolor por zona con aviso tras 2 sesiones seguidas, y notas rápidas con ajuste de máquina.

Respeta el stack sin dependencias. Agrega tests en tests/domain.test.mjs para la lógica nueva (aproximaciones fuera del volumen y del e1RM, sustituto que cuenta el volumen del original, regla de dolor) y extiende e2e/e2e.py con el flujo de un sustituto y una aproximación. Sube VERSION en sw.js.

Al terminar, ejecuta npm test y npm run e2e, y dame la lista de archivos cambiados y qué criterios de la Fase 2 quedaron cumplidos o pendientes.

---
