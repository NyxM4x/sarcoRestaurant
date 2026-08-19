import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Configuración de los EVALS — separada de `npm test` a propósito.
 *
 * `vitest.config.ts` solo incluye `src/**\/*.test.ts`, así que nada de esta
 * carpeta se ejecuta en la suite normal. Es deliberado: estos evals llaman al
 * modelo REAL, cuestan dinero, tardan, y su resultado no es determinista. Un
 * `npm test` que a veces falla por cómo respondió un LLM deja de ser una señal.
 *
 *   npm test              → 2100 pruebas deterministas, sin red
 *   npm run eval:selection → mide al modelo real, a mano y cuando se decida
 *
 * La clave se lee de `.env.local` (ignorado por git desde `.env*`). NUNCA se
 * imprime, ni entera ni parcial, ni en logs ni en informes.
 */

/**
 * Lector mínimo de ficheros de entorno. No se usa `dotenv` ni `loadEnv` de vite:
 * son `KEY=VALUE` por línea y añadir una dependencia para eso sería más
 * superficie de la que hace falta.
 */
function readEnvFile(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
  } catch {
    return out; // no existe: no es un error, la clave puede venir del entorno
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    // Se admiten comillas porque un editor las pone solo; nada más.
    const value = trimmed.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    out[key] = value;
  }
  return out;
}

// El entorno real MANDA sobre el fichero: así se puede sobrescribir el modelo
// para una tirada concreta sin editar nada.
const fromFiles = { ...readEnvFile('.env'), ...readEnvFile('.env.local') };
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(fromFiles)) {
  if (process.env[key] === undefined) env[key] = value;
}

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(
        new URL('./node_modules/server-only/empty.js', import.meta.url),
      ),
    },
  },
  test: {
    include: ['evals/**/*.eval.ts'],
    environment: 'node',
    env,
    // Llamadas reales a un proveedor externo: los timeouts de una suite unitaria
    // no sirven aquí.
    testTimeout: 900_000,
    hookTimeout: 60_000,
    // Una tirada, un informe: sin reintentos que maquillen la tasa de acierto.
    retry: 0,
  },
});
