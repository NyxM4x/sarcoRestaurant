/**
 * Tipos del modelo de datos de Don Zarco Orders.
 *
 * Reflejan el esquema definido en `supabase/migrations/0001_init.sql`.
 * Se mantienen a mano en la Fase 1; en fases posteriores pueden
 * regenerarse con `supabase gen types typescript`.
 */

// ── Uniones controladas (deben coincidir con los CHECK del SQL) ──

export const MENU_CATEGORIES = ['plato', 'bebida', 'extra'] as const;
export type MenuCategory = (typeof MENU_CATEGORIES)[number];

export const DELIVERY_TYPES = ['delivery', 'pickup'] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];

/**
 * Método de pago manual (Fase 6D.1). En base es nullable SIN default: los
 * pedidos históricos y los del WhatsApp Flow quedan `NULL` ("pago no
 * registrado"). Solo los pedidos creados desde /menu guardan 'cash' | 'qr'.
 */
export const PAYMENT_METHODS = ['cash', 'qr'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Modo de tarificación del envío (Fase 6D.2B). En base es nullable SIN default y
 * lo DERIVA el servidor (`create_order_web_v3`), nunca el cliente:
 *   - `'dynamic'` → pedido delivery que se cotiza con Mapbox + tarifario;
 *   - `null`      → pickup, históricos, WhatsApp Flow y pedidos de `create_order_web_v2`
 *                   (legacy: comportamiento actual sin cotización dinámica).
 */
export const DELIVERY_PRICINGS = ['dynamic'] as const;
export type DeliveryPricing = (typeof DELIVERY_PRICINGS)[number];

/**
 * Estado de la cotización de envío dinámico (Fase 6D.2B). Nullable SIN default:
 *   - `'pending'`         → delivery dinámico esperando ubicación/cotización;
 *   - `'quoted'`          → cotización aplicada (distancia + costo escritos);
 *   - `'failed'`          → fallo técnico de Mapbox (reintentable);
 *   - `'out_of_coverage'` → distancia > 18 km (resolución manual);
 *   - `null`              → no aplica (pickup / legacy / Flow).
 */
export const DELIVERY_QUOTE_STATUSES = ['pending', 'quoted', 'failed', 'out_of_coverage'] as const;
export type DeliveryQuoteStatus = (typeof DELIVERY_QUOTE_STATUSES)[number];

export const ORDER_STATUSES = [
  'draft',
  'awaiting_location',
  'confirmed',
  'preparing',
  'ready',
  'on_the_way',
  'delivered',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const WEBHOOK_EVENT_STATUSES = ['received', 'processed', 'failed'] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

// ── Agent Foundation (0014) ──
// Dominios del Agent Core conversacional. Deben coincidir exactamente con los
// CHECK de `supabase/migrations/0014_agent_foundation.sql`.

/** `active` = el agente puede responder; `paused` = control humano/externo. */
export const AGENT_CONVERSATION_STATES = ['active', 'paused'] as const;
export type AgentConversationState = (typeof AGENT_CONVERSATION_STATES)[number];

export const AGENT_MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type AgentMessageDirection = (typeof AGENT_MESSAGE_DIRECTIONS)[number];

export const AGENT_MESSAGE_ROLES = ['user', 'assistant'] as const;
export type AgentMessageRole = (typeof AGENT_MESSAGE_ROLES)[number];

/**
 * Quién produjo el mensaje. `automation` son los salientes DETERMINÍSTICOS del
 * backend (order_received, confirmation, location_request, QR, CTA del menú por
 * isMenuIntent/TESTMENU9842); se separa de `ai` para que no contaminen
 * `first_ai_message_at` ni las métricas del Agent Core.
 *
 * Solo cuatro combinaciones direction/role/actor son válidas (de 16 posibles):
 *   customer   → inbound  / user
 *   ai         → outbound / assistant
 *   human      → outbound / assistant
 *   automation → outbound / assistant
 */
export const AGENT_MESSAGE_ACTORS = ['customer', 'ai', 'human', 'automation'] as const;
export type AgentMessageActor = (typeof AGENT_MESSAGE_ACTORS)[number];

/** `text` exige `content`; el resto puede tenerlo en `null` (nunca vacío). */
export const AGENT_MESSAGE_CONTENT_TYPES = [
  'text',
  'image',
  'audio',
  'video',
  'document',
  'sticker',
  'location',
  'interactive',
  'unknown',
] as const;
export type AgentMessageContentType = (typeof AGENT_MESSAGE_CONTENT_TYPES)[number];

/**
 * Estado de una ejecución del agente.
 *   - `processing`     → reclamado, antes de OpenAI o durante;
 *   - `sending`        → superó la barrera #2, envío en vuelo;
 *   - `completed`      → respondió;
 *   - `skipped_paused` → la conversación estaba pausada (ver barrera);
 *   - `failed`         → fallo determinado, no salió nada;
 *   - `send_unknown`   → envío ambiguo: pudo salir. NUNCA se reenvía a ciegas.
 */
export const AGENT_RUN_STATUSES = [
  'processing',
  'sending',
  'completed',
  'skipped_paused',
  'failed',
  'send_unknown',
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** Barrera de pausa que detuvo el run. Solo se puebla en `skipped_paused`. */
export const AGENT_RUN_BARRIERS = ['pre_openai', 'pre_send'] as const;
export type AgentRunBarrier = (typeof AGENT_RUN_BARRIERS)[number];

export const AGENT_CONTROL_ACTIONS = ['pause', 'resume'] as const;
export type AgentControlAction = (typeof AGENT_CONTROL_ACTIONS)[number];

/** Origen de un cambio de control. Mismo dominio que `pause_source`. */
export const AGENT_CONTROL_SOURCES = [
  'business_app',
  'dashboard',
  'api',
  'system',
] as const;
export type AgentControlSource = (typeof AGENT_CONTROL_SOURCES)[number];

// ── Filas ──

export interface MenuItem {
  id: string;
  code: string;
  name: string;
  category: MenuCategory;
  price: number;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Order {
  id: string;
  order_number: string;
  customer_phone: string;
  customer_name: string | null;
  delivery_type: DeliveryType;
  notes: string | null;
  status: OrderStatus;
  subtotal_amount: number;
  delivery_amount: number;
  total_amount: number;
  currency: string;
  flow_token: string | null;
  source_message_id: string | null;
  location_request_message_id: string | null;
  raw_flow_response: unknown | null;
  delivery_latitude: number | null;
  delivery_longitude: number | null;
  delivery_address: string | null;
  delivery_location_name: string | null;
  /** Sesión de menú que originó el pedido (checkout web). `null` en pedidos de WhatsApp Flow. */
  menu_session_id: string | null;
  /** Huella SHA-256 del carrito; distingue reintento de reutilización del enlace. */
  checkout_fingerprint: string | null;
  /** Modo de tarificación del envío (6D.2B). `'dynamic'` o `null` (legacy). */
  delivery_pricing: DeliveryPricing | null;
  /** Estado de la cotización de envío dinámico (6D.2B). `null` en legacy/pickup. */
  delivery_quote_status: DeliveryQuoteStatus | null;
  /** Distancia real de ruta usada para cotizar (m, auditoría). `null` hasta cotizar. */
  delivery_distance_meters: number | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
}

export interface OrderItem {
  id: string;
  order_id: string;
  menu_item_id: string | null;
  product_code: string;
  product_name_snapshot: string;
  unit_price_snapshot: number;
  quantity: number;
  subtotal: number;
  created_at: string;
}

export interface WebhookEvent {
  id: string;
  event_id: string | null;
  message_id: string | null;
  event_name: string | null;
  payload: unknown | null;
  status: WebhookEventStatus;
  error_message: string | null;
  processed_at: string | null;
  created_at: string;
}

export interface MenuSession {
  id: string;
  source_message_id: string;
  token_hash: string;
  customer_phone: string;
  phone_number_id: string;
  created_at: string;
  expires_at: string;
}

// ── Filas del Agent Foundation (0014) ──

/**
 * Estado ACTUAL de la conversación (el historial de pausas vive en
 * `agent_control_events`). `customer_phone` es la identidad durable.
 */
export interface AgentConversation {
  id: string;
  /** Solo dígitos, normalizado con `normalizePhone`. UNIQUE. */
  customer_phone: string;
  /** Referencia técnica cambiante del proveedor; nunca identidad. */
  last_provider_conversation_id: string | null;
  /** Número del negocio por el que responder. Nullable: no bloquea persistir. */
  provider_phone_number_id: string | null;
  state: AgentConversationState;
  paused_at: string | null;
  /** `null` con `state='paused'` = pausa indefinida (takeover humano). */
  pause_expires_at: string | null;
  pause_reason: string | null;
  pause_source: AgentControlSource | null;
  /** Último resume. Solo poblado mientras `state='active'`. */
  resumed_at: string | null;
  first_customer_message_at: string | null;
  first_ai_message_at: string | null;
  /** DERIVADA por trigger: máximo exacto de los cuatro `last_*`. No escribir. */
  last_message_at: string | null;
  last_customer_message_at: string | null;
  last_ai_message_at: string | null;
  last_human_message_at: string | null;
  last_automation_message_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Mensaje REAL del canal. Nunca marcadores internos. */
export interface AgentMessage {
  id: string;
  agent_conversation_id: string;
  /** WAMID. `null` mientras un envío de IA siga ambiguo (`send_unknown`). */
  provider_message_id: string | null;
  provider_conversation_id: string | null;
  direction: AgentMessageDirection;
  role: AgentMessageRole;
  actor: AgentMessageActor;
  /** Obligatorio si `content_type='text'`; `null` permitido en el resto. */
  content: string | null;
  content_type: AgentMessageContentType;
  /** Objeto JSON o `null`. Sin secretos, tokens ni URLs tokenizadas. */
  metadata: Record<string, unknown> | null;
  message_timestamp: string;
  created_at: string;
}

/** Ejecución del agente para UN mensaje entrante (`source_message_id` UNIQUE). */
export interface AgentRun {
  id: string;
  agent_conversation_id: string;
  /** WAMID entrante. UNIQUE: idempotencia semántica de la reacción de la IA. */
  source_message_id: string;
  source_agent_message_id: string | null;
  /** `null` en un `completed` puede significar mensaje purgado por retención. */
  response_message_id: string | null;
  status: AgentRunStatus;
  attempt_count: number;
  model: string | null;
  tool_rounds: number;
  skipped_at_barrier: AgentRunBarrier | null;
  started_at: string;
  completed_at: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

/** Auditoría append-only de pausa/reanudación. */
export interface AgentControlEvent {
  id: string;
  agent_conversation_id: string;
  action: AgentControlAction;
  source: AgentControlSource;
  reason: string | null;
  provider_message_id: string | null;
  /** Solo válido con `action='pause'`. */
  expires_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

// ── Usuarios del acceso interno (0020) ───────────────────────────────────

/**
 * Roles del panel interno. `admin` gobierna el panel del encargado
 * (/dashboard); `kitchen` el tablero de cocina (/cocina).
 */
export const DASHBOARD_USER_ROLES = ['admin', 'kitchen'] as const;
export type DashboardUserRole = (typeof DASHBOARD_USER_ROLES)[number];

/**
 * Usuario del acceso interno. Sustituye a las contrasenas compartidas por
 * variable de entorno: cada persona tiene su usuario y su rol.
 *
 * `password_hash` guarda SIEMPRE un hash bcrypt, nunca texto plano, y no debe
 * salir jamas de la capa server-only.
 */
export interface DashboardUser {
  id: string;
  username: string;
  password_hash: string;
  role: DashboardUserRole;
  /** Baja logica: desactivar conserva el historial del alta. */
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
