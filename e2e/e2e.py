"""Prueba de punta a punta en Chromium (Playwright para Python).

Uso: python3 e2e/e2e.py   (levanta un servidor local en el puerto 5173)
Guarda capturas en e2e/shots/.
"""
import http.server
import json
import os
import socketserver
import threading
from functools import partial
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "e2e" / "shots"
SHOTS.mkdir(parents=True, exist_ok=True)
PORT = 5173
BASE = f"http://localhost:{PORT}/"


def serve():
    handler = partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    handler.log_message = lambda *a, **k: None
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def log(page, ex, n):
    page.click(f"[data-action=log][data-ex={ex}][data-n='{n}']")
    expect(page.locator(f"[data-action=edit-load][data-key='{ex}:{n}']")).to_have_count(0)


def main():
    httpd = serve()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 393, "height": 851}, device_scale_factor=2,
                                  is_mobile=True, has_touch=True, accept_downloads=True)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: d.accept("24") if d.type == "prompt" else d.accept())

        # 1. Configuración del bloque (lunes 26/10/2026)
        page.goto(BASE + "?date=2026-10-26")
        expect(page.get_by_text("Bienvenido")).to_be_visible()
        page.fill("#start", "2026-10-26")
        page.click("[data-action=save-block]")
        expect(page.get_by_role("heading", name="Lunes · Torso")).to_be_visible()
        expect(page.get_by_text("Semana 1 de 6")).to_be_visible()
        page.screenshot(path=str(SHOTS / "01_hoy.png"), full_page=False)

        # 2. Check-in rápido
        page.click("[data-action=checkin][data-k=sleep][data-v='3']")
        page.click("[data-action=checkin][data-k=energy][data-v='2']")
        page.click("[data-action=checkin][data-k=soreness][data-v='3']")
        expect(page.locator("#checkin")).to_have_count(0)

        # 3. Primera serie: escribir carga (prompt -> 24) y subir reps a 10
        page.click("[data-action=edit-load][data-key='L1:1']")
        for _ in range(4):
            page.click("[data-step='L1:1|reps|1']")
        expect(page.locator("[data-key='L1:1'] [data-val=reps]")).to_have_text("10")
        log(page, "L1", 1)
        expect(page.locator("#rest .time")).to_be_visible()
        expect(page.locator(".set.logged").first).to_contain_text("24 kg × 10")
        page.screenshot(path=str(SHOTS / "02_serie_registrada.png"))

        # 4. Reanudar: recargar mantiene la serie y el descanso
        page.reload()
        expect(page.locator(".set.logged")).to_have_count(1)
        expect(page.locator("#rest")).to_be_visible()

        # 5. Completar el resto de L1 con 24 kg × 10 y registrar todas las demás series
        for n in (2, 3):
            page.click(f"[data-action=edit-load][data-key='L1:{n}']")
            for _ in range(4):
                page.click(f"[data-step='L1:{n}|reps|1']")
            log(page, "L1", n)
        while page.locator("[data-action=edit-load]").count():
            key = page.locator("[data-action=edit-load]").first.get_attribute("data-key")
            ex, n = key.split(":")
            page.click(f"[data-action=edit-load][data-key='{key}']")
            log(page, ex, n)
        expect(page.get_by_text("Series: 18 de 18")).to_be_visible()
        page.click("[data-action=finish]")
        expect(page.locator("#modal")).to_contain_text("18 de 18 series")
        expect(page.locator("#modal")).to_contain_text("Press inclinado con mancuernas a 30°")
        page.screenshot(path=str(SHOTS / "03_resumen.png"))
        page.click("[data-action=close-modal]")

        # 6. Semana 2: L1 debe venir con carga sugerida +1 kg y reps mínimas
        page.goto(BASE + "?date=2026-11-02")
        expect(page.get_by_text("Semana 2 de 6")).to_be_visible()
        page.click("[data-action=checkin-skip]")
        expect(page.locator("#ex-L1 .badge.up")).to_be_visible()
        expect(page.locator("[data-key='L1:1'] [data-val=load]")).to_have_text("25")
        expect(page.locator("[data-key='L1:1'] [data-val=reps]")).to_have_text("6")
        expect(page.locator("[data-key='L2:1'] [data-val=load]")).to_have_text("24")
        page.screenshot(path=str(SHOTS / "04_semana2_sugerido.png"))

        # 7. Fin de semana
        page.goto(BASE + "?date=2026-11-07")
        expect(page.get_by_role("heading", name="Descanso")).to_be_visible()

        # 7b. Jueves de la semana 1: rutina nueva, zona sensible y calibración
        page.goto(BASE + "?date=2026-10-29")
        page.click("[data-action=checkin-skip]")
        expect(page.get_by_role("heading", name="Jueves · Pierna B")).to_be_visible()
        expect(page.locator("#ex-N4")).to_contain_text("Hip thrust")
        expect(page.locator("#ex-N4 .badge.warn")).to_contain_text("Cadera izq.")
        expect(page.locator("[data-key='N7:3'] .cal")).to_be_visible()
        expect(page.locator("[data-key='N7:2'] .cal")).to_have_count(0)
        page.locator("#ex-N7").scroll_into_view_if_needed()
        page.screenshot(path=str(SHOTS / "04b_calibracion.png"))
        for n in (1, 2):
            page.click(f"[data-action=edit-load][data-key='N7:{n}']")
            log(page, "N7", n)
        page.click("[data-action=edit-load][data-key='N7:3']")
        page.click("[data-action=log][data-ex=N7][data-n='3']")
        expect(page.locator("#toast")).to_contain_text("Calibración")
        page.click("[data-action=rir-pred][data-key='N7:3'][data-v='1']")
        page.click("[data-action=reps-extra][data-key='N7:3'][data-v='3']")
        log(page, "N7", 3)
        page.click("[data-tab=progreso]")
        expect(page.get_by_text("te quedaban 2 repeticiones más")).to_be_visible()

        # 8. Historial, progreso y respaldo
        page.goto(BASE + "?date=2026-11-02")
        page.click("[data-tab=historial]")
        expect(page.locator("details")).to_have_count(2)
        page.click("[data-tab=progreso]")
        expect(page.locator("table")).to_contain_text("Press inclinado")
        page.screenshot(path=str(SHOTS / "05_progreso.png"))
        page.click("[data-tab=yo]")
        with page.expect_download() as dl:
            page.click("[data-action=export]")
        path = dl.value.path()
        data = json.loads(Path(path).read_text())
        assert len([s for s in data["sets"] if not s.get("deleted_at")]) == 21, "el respaldo debe tener 18 + 3 series"
        assert len(data["exercises"]) == 32
        page.screenshot(path=str(SHOTS / "06_yo.png"))

        # 9. Importar el respaldo en un navegador limpio
        ctx2 = browser.new_context(viewport={"width": 393, "height": 851}, is_mobile=True, has_touch=True)
        p2 = ctx2.new_page()
        p2.on("dialog", lambda d: d.accept())
        p2.goto(BASE + "?date=2026-11-02")
        p2.fill("#start", "2026-10-26")
        p2.click("[data-action=save-block]")
        p2.click("[data-tab=yo]")
        p2.set_input_files("#import", path)
        p2.click("[data-tab=historial]")
        expect(p2.locator("details")).to_have_count(2)

        # 10. Migración: quien tenía la rutina del Bloque 1 pasa al Bloque 2 y deja de ver lo retirado
        ctx3 = browser.new_context(viewport={"width": 393, "height": 851}, is_mobile=True, has_touch=True)
        p3 = ctx3.new_page()
        p3.on("pageerror", lambda e: errors.append(str(e)))
        p3.goto(BASE + "?date=2026-10-29")
        expect(p3.get_by_text("Bienvenido")).to_be_visible()
        p3.evaluate("""() => new Promise((ok, ko) => {
          const r = indexedDB.open('classic-tracker', 1);
          r.onsuccess = () => {
            const tx = r.result.transaction(['meta', 'exercises'], 'readwrite');
            tx.objectStore('meta').put({ key: 'seedVersion', value: 1 });
            tx.objectStore('meta').put({ key: 'block', value: { number: 1, start: '2026-10-26' } });
            tx.objectStore('exercises').put({ id: 'X1', day: 'Miércoles', order: 1, name: 'Press de hombro sentado con mancuernas',
              target: 'Deltoides anterior', base_sets: 3, rep_min: 6, rep_max: 10, rest_sec_min: 120, rest_sec_max: 180,
              priority: false, load_step_kg: 1, muscle_factors: {}, substitutes: [] });
            tx.oncomplete = () => ok(); tx.onerror = () => ko(tx.error);
          };
        })""")
        p3.reload()
        expect(p3.locator("#toast")).to_contain_text("Bloque 2")
        expect(p3.get_by_text("Tu Bloque 2 empieza el 02/11/2026")).to_be_visible()
        p3.goto(BASE + "?date=2026-11-04")
        p3.click("[data-action=checkin-skip]")
        expect(p3.get_by_role("heading", name="Miércoles · Torso B")).to_be_visible()
        expect(p3.get_by_text("Press de hombro sentado")).to_have_count(0)
        expect(p3.locator("#ex-N2")).to_contain_text("Patada de tríceps")

        assert not errors, f"errores de JavaScript: {errors}"
        browser.close()
    httpd.shutdown()
    print("E2E OK — capturas en", SHOTS)


if __name__ == "__main__":
    main()
