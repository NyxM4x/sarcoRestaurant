/**
 * Utilidades de teléfono (puro).
 *
 * `normalizePhone` deja solo dígitos para comparar de forma estable con
 * `orders.customer_phone`. `maskPhone` produce una versión enmascarada para
 * logs/diagnóstico: nunca se registra el número completo.
 */
export function normalizePhone(input: string | null | undefined): string {
  if (!input) return '';
  return input.replace(/\D+/g, '');
}

export function maskPhone(input: string | null | undefined): string {
  const digits = normalizePhone(input);
  if (digits.length === 0) return '';
  if (digits.length <= 4) return '*'.repeat(digits.length);
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}
