import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';

/**
 * PRUEBA ARQUITECTONICA DEL REPOSITORIO — los Workers despiertan a SARCO.
 *
 * ── Por que vive bajo `src/` y no dentro de cada Worker ─────────────────────
 *
 * Cada paquete de `cloudflare/` ya tiene su propio guardian, y esta bien que lo
 * tenga: viaja con el desplegable. Pero esos guardianes solo corren si alguien
 * se acuerda de ejecutar `npm test` DENTRO de cada carpeta, y el gate que se
 * ejecuta siempre —en CI, antes de un push, cuando alguien toca cualquier
 * cosa— es el `npm test` de la raiz, cuyo vitest solo mira `src/**`.
 *
 * Un guardian que hay que acordarse de invocar no es un guardian.
 *
 * ── Que impide, exactamente ─────────────────────────────────────────────────
 *
 * El repositorio llego a `a3bd210` con DOS Workers completos cuyo
 * `WORKER_TICK_URL` apuntaba a `la-fija-orders.vercel.app`: otro despliegue
 * REAL del mismo operador, vivo en la misma cuenta de Vercel. Un
 * `wrangler deploy` no habria fallado. Habria publicado un Cron que cada minuto
 * llama al endpoint interno de otro restaurante con el Bearer de este, y en los
 * logs se habria visto como un tick sano.
 *
 * Esta prueba DESCUBRE los Workers recorriendo `cloudflare/`, asi que tambien
 * cubre el tercero que alguien anada manana sin leer esto.
 */

const RAIZ_WORKERS = fileURLToPath(new URL('../../../cloudflare', import.meta.url));

/** Hosts de OTROS despliegues del operador. Ninguno puede aparecer. */
const HOSTS_AJENOS: readonly string[] = ['la-fija-orders', 'la-fija-restaurant', 'la-fija'];

/** El unico destino admitido por los despertadores de este repositorio. */
const HOST_SARCO = 'sarco-restaurant.vercel.app';

/**
 * Ficheros que `wrangler` LEE o EMPAQUETA. El README queda fuera a proposito:
 * documenta, no se ejecuta, y un guardian que falla por un ejemplo en prosa
 * acaba desactivado.
 */
function configuracionEjecutable(dirWorker: string): string[] {
  const out: string[] = [];
  for (const rel of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml', 'package.json', '.dev.vars.example']) {
    const ruta = join(dirWorker, rel);
    if (existsSync(ruta)) out.push(ruta);
  }
  const src = join(dirWorker, 'src');
  if (existsSync(src)) out.push(...ficherosDe(src));
  return out;
}

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

/** Todo subdirectorio de `cloudflare/` con un manifiesto de Wrangler. */
const WORKERS: readonly string[] = existsSync(RAIZ_WORKERS)
  ? readdirSync(RAIZ_WORKERS)
      .map((n) => join(RAIZ_WORKERS, n))
      .filter((d) => statSync(d).isDirectory())
      .filter((d) =>
        ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].some((m) => existsSync(join(d, m))),
      )
  : [];

const corto = (ruta: string): string => ruta.split(sep).slice(-2).join('/');

describe('los Cloudflare Workers del repositorio', () => {
  it('se descubren al menos los dos conocidos', () => {
    // Si esta lista se vacia, el resto de la suite pasaria sin comprobar nada.
    expect(WORKERS.length).toBeGreaterThanOrEqual(2);
  });

  for (const dirWorker of WORKERS) {
    const nombreDir = dirWorker.split(sep).pop()!;

    describe(nombreDir, () => {
      const ejecutables = configuracionEjecutable(dirWorker);

      it('declara al menos un fichero de configuracion ejecutable', () => {
        expect(ejecutables.length).toBeGreaterThan(0);
      });

      it('ninguna configuracion ejecutable menciona otro despliegue', () => {
        const culpables: string[] = [];
        for (const ruta of ejecutables) {
          const contenido = readFileSync(ruta, 'utf8').toLowerCase();
          for (const ajeno of HOSTS_AJENOS) {
            if (contenido.includes(ajeno)) culpables.push(`${corto(ruta)} → ${ajeno}`);
          }
        }
        expect(culpables).toEqual([]);
      });

      it('el nombre desplegable lleva el prefijo `sarco-`', () => {
        // Sin prefijo, dos restaurantes en la misma cuenta de Cloudflare son el
        // MISMO Worker: el segundo deploy sobrescribe al primero en silencio.
        const manifiesto = join(dirWorker, 'wrangler.jsonc');
        const raw = readFileSync(manifiesto, 'utf8');
        const nombre = /"name"\s*:\s*"([^"]+)"/.exec(raw)?.[1] ?? '';
        expect(nombre).toMatch(/^sarco-/);
      });

      it('toda URL absoluta de la configuracion apunta al dominio de Sarco', () => {
        for (const ruta of ejecutables) {
          const urls = readFileSync(ruta, 'utf8').match(/https?:\/\/[^"'\s]+/g) ?? [];
          for (const url of urls) {
            expect(`${corto(ruta)} → ${url}`).toContain(HOST_SARCO);
          }
        }
      });
    });
  }
});
