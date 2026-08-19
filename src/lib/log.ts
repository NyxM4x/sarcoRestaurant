/**
 * Logger estructural mínimo.
 *
 * Emite JSON en una línea. NO registrar secretos ni payloads sensibles
 * completos (IDEA.md §9): pasa solo campos de correlación (ids, códigos, montos).
 */
type LogLevel = 'info' | 'warn' | 'error';

type LogFields = Record<string, unknown>;

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  const entry = {
    level,
    message,
    ...fields,
    ts: new Date().toISOString(),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};
