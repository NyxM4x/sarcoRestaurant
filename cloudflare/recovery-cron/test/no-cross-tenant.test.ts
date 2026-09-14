import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';
import { RECOVERIES } from '../src/cron';

/**
 * PRUEBA ARQUITECTÓNICA — este Worker despierta a SARCO, a sus cuatro
 * recuperaciones, y a nadie más.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 *
 * Los Workers de este repo nacieron copiados de otro despliegue del mismo
 * operador y llegaron a tener `WORKER_TICK_URL` apuntando a `la-fija-orders`.
 * Un `wrangler deploy` en ese estado no da ningún error: publica un Cron que
 * cada minuto llama al endpoint interno de OTRO restaurante con el Bearer de
 * este, y en los logs se ve como un tick sano.
 *
 * Y con un solo Worker para todo aparece un riesgo nuevo: que la app gane una
 * quinta ruta `worker/tick` y nadie la añada aquí. Es exactamente como murió el
 * barrido de efectivo en 09-2026 —escrito, probado y sin despertador—, así que
 * esta prueba contrasta la lista con las rutas reales de la app.
 */

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** Hosts de OTROS despliegues. Ninguno puede aparecer en este paquete. */
const HOSTS_AJENOS = ['la-fija-orders', 'la-fija-restaurant', 'la-fija'];

/** El único origen admitido. */
const ORIGEN_SARCO = 'https://sarco-restaurant.vercel.app';

/** Raíz de las rutas de la app Next de este mismo repo. */
const APP = here('../../../src/app');

function ficherosDe(dir: string): string[] {
  const out: string[] = [];
  for (const entrada of readdirSync(dir)) {
    if (entrada === 'node_modules') continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) out.push(...ficherosDe(ruta));
    else out.push(ruta);
  }
  return out;
}

/** Configuración EJECUTABLE: lo que decide a quién se llama y cómo se publica. */
const EJECUTABLES: readonly string[] = [
  here('../wrangler.jsonc'),
  here('../package.json'),
  here('../.dev.vars.example'),
  ...ficherosDe(here('../src')),
];

describe('ninguna configuración ejecutable apunta a otro despliegue', () => {
  for (const ruta of EJECUTABLES) {
    const nombre = ruta.split(sep).slice(-2).join('/');

    it(`${nombre} no menciona el host de otro restaurante`, () => {
      const contenido = readFileSync(ruta, 'utf8').toLowerCase();
      for (const ajeno of HOSTS_AJENOS) {
        expect(contenido).not.toContain(ajeno);
      }
    });
  }
});

describe('el destino, el nombre y el cron son los de Sarco', () => {
  const raw = readFileSync(here('../wrangler.jsonc'), 'utf8');

  it('APP_BASE_URL es EXACTAMENTE el origen de Sarco, sin ruta', () => {
    expect(raw).toContain(`"APP_BASE_URL": "${ORIGEN_SARCO}"`);
  });

  it('no queda ninguna otra URL absoluta en la configuración', () => {
    // Una segunda URL sería un segundo destino.
    const urls = raw.match(/https?:\/\/[^"\s]+/g) ?? [];
    expect(urls).toEqual([ORIGEN_SARCO]);
  });

  it('ni `src/` lleva URLs absolutas: las rutas son relativas al origen', () => {
    for (const ruta of ficherosDe(here('../src'))) {
      expect(readFileSync(ruta, 'utf8'), ruta).not.toMatch(/https?:\/\//);
    }
  });

  it('el nombre desplegable es `sarco-recovery-cron`', () => {
    // Sin prefijo, dos restaurantes en la misma cuenta de Cloudflare son el
    // MISMO Worker: el segundo deploy sobrescribe al primero en silencio.
    expect(/"name"\s*:\s*"([^"]+)"/.exec(raw)?.[1]).toBe('sarco-recovery-cron');
  });

  it('declara UN solo Cron Trigger, cada minuto', () => {
    // Cada expresión cuenta contra el límite de cinco de la cuenta.
    const crons = /"crons"\s*:\s*\[([^\]]*)\]/.exec(raw)?.[1] ?? '';
    expect(crons.match(/"[^"]*"/g)).toEqual(['"* * * * *"']);
  });
});

describe('las recuperaciones coinciden con las rutas de la app', () => {
  it('cada ruta del Worker existe en la app y acepta POST', () => {
    for (const { name, path } of RECOVERIES) {
      const route = join(APP, ...path.split('/').filter(Boolean), 'route.ts');
      expect(existsSync(route), `${name} → ${path}`).toBe(true);
      expect(readFileSync(route, 'utf8'), name).toMatch(/export\s+async\s+function\s+POST\b/);
    }
  });

  it('ninguna ruta `worker/tick` de la app se queda sin despertador', () => {
    const rutasApp = ficherosDe(join(APP, 'api', 'internal'))
      .filter((f) => f.endsWith(`${sep}worker${sep}tick${sep}route.ts`))
      .map((f) => '/' + f.slice(APP.length + 1).split(sep).slice(0, -1).join('/'))
      .sort();

    // Si esta lista se vaciara, la comparación de abajo pasaría sin mirar nada.
    expect(rutasApp.length).toBeGreaterThanOrEqual(4);
    expect(RECOVERIES.map((r) => r.path).sort()).toEqual(rutasApp);
  });

  it('ninguna apunta al fallback que nadie despierta', () => {
    // `/api/internal/cron/tick` es GET, y es donde el barrido de efectivo estuvo
    // enterrado tres días sin que nadie lo llamara.
    for (const { path } of RECOVERIES) expect(path).not.toContain('/api/internal/cron/tick');
  });
});
