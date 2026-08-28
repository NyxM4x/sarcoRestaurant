import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';

/**
 * PRUEBA ARQUITECTÓNICA — este Worker despierta a SARCO y a nadie más.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 *
 * Este paquete nació copiado de otro despliegue del mismo operador, y llegó
 * hasta aquí con `WORKER_TICK_URL` todavía apuntando a `la-fija-orders`. Un
 * `wrangler deploy` en ese estado no habría dado ningún error: habría publicado
 * un Cron que cada minuto llama al endpoint interno de OTRO restaurante, con el
 * Bearer de este. Nada en el repositorio lo habría impedido, y en los logs se
 * habría visto como un tick sano.
 *
 * Un comentario que diga "no apuntes a otro tenant" no impide nada. Esta prueba
 * sí: recorre TODA la configuración ejecutable del Worker —lo que `wrangler`
 * lee o empaqueta— y falla si vuelve a aparecer el host de otro despliegue.
 *
 * ── Qué cuenta como "configuración ejecutable" ──────────────────────────────
 *
 * Lo que determina a quién llama el Worker una vez desplegado, o con qué
 * identidad se publica: `wrangler.jsonc` (name, vars, triggers), todo `src/`,
 * `package.json` (scripts de deploy) y `.dev.vars.example` (la plantilla que
 * alguien copia a `.dev.vars` para correr en local). El README queda fuera a
 * propósito: documenta, no se ejecuta — y aun así hoy tampoco lo menciona.
 */

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** Hosts de OTROS despliegues. Ninguno puede aparecer en este paquete. */
const HOSTS_AJENOS = ['la-fija-orders', 'la-fija-restaurant', 'la-fija'];

/** El único destino admitido. */
const HOST_SARCO = 'sarco-restaurant.vercel.app';

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

describe('el destino y el nombre son los de Sarco', () => {
  const raw = readFileSync(here('../wrangler.jsonc'), 'utf8');

  it('WORKER_TICK_URL es EXACTAMENTE el tick de order-notifications de Sarco', () => {
    // Literal completo, no un `contains`: el host correcto con la ruta de otro
    // worker seguiría siendo un despertador equivocado.
    expect(raw).toContain(
      `"WORKER_TICK_URL": "https://${HOST_SARCO}/api/internal/order-notifications/worker/tick"`,
    );
  });

  it('no queda ninguna otra URL absoluta en la configuración', () => {
    // Una segunda URL sería un segundo destino, y este Worker tiene uno solo.
    const urls = raw.match(/https?:\/\/[^"\s]+/g) ?? [];
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(HOST_SARCO);
  });

  it('el nombre desplegable lleva el prefijo `sarco-`', () => {
    // Sin prefijo, dos restaurantes en la misma cuenta de Cloudflare son el
    // MISMO Worker: el segundo deploy sobrescribe al primero en silencio.
    expect(raw).toContain('"name": "sarco-notification-recovery-cron"');
  });
});
