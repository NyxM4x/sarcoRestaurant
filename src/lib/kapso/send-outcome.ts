/**
 * Desenlace de un envío por Kapso — módulo PURO (Fase 6D.2F.5A).
 *
 * Nació dentro de Agent Core (`classifySendFailure`) y vive aquí desde que el
 * menú necesita exactamente la misma pregunta: *¿consta que NO salió, o solo
 * que no lo sabemos?* Duplicar esta decisión sería duplicar el criterio de
 * cuándo es seguro reintentar, y ese criterio tiene que ser uno.
 *
 * La asimetría es deliberada: ante la duda se asume que el mensaje PUDO llegar
 * al cliente. Un mensaje perdido es un fallo; uno duplicado, dos.
 */

/**
 * `failed` — consta que no salió: el proveedor lo rechazó por algo que no
 * cambia con el tiempo. Reintentar daría el mismo rechazo.
 *
 * `send_unknown` — pudo salir. Nunca se reenvía a ciegas.
 */
export type SendOutcome = 'failed' | 'send_unknown';

export function classifyKapsoSendFailure(error: string, status?: number): SendOutcome {
  switch (error) {
    // Rechazos determinísticos: el payload era inválido, no llegó a WhatsApp.
    case 'invalid_phone':
    case 'invalid_text':
    case 'invalid_body_text':
    case 'invalid_image':
      return 'failed';
    case 'http_error':
      // 4xx = lo rechazó. 5xx = pudo aceptarlo y caerse después.
      return status !== undefined && status < 500 ? 'failed' : 'send_unknown';
    default:
      // invalid_response, timeout, network_error y cualquier error nuevo del
      // transporte: sin certeza. El default cae del lado prudente a propósito.
      return 'send_unknown';
  }
}
