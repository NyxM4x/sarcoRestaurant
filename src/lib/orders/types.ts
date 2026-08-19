import type { DeliveryType } from '@/types';

/** Una línea calculada del pedido, con snapshots de nombre y precio. */
export interface CalculatedLine {
  menu_item_id: string;
  product_code: string;
  product_name_snapshot: string;
  unit_price_snapshot: number;
  quantity: number;
  subtotal: number;
}

/** Resultado del cálculo de un pedido a partir de precios reales. */
export interface CalculatedOrder {
  lines: CalculatedLine[];
  subtotal_amount: number;
  delivery_amount: number;
  total_amount: number;
}

/** Entrada para crear/actualizar un borrador desde el Data Endpoint. */
export interface UpsertOrderDraftInput {
  /** Token único del Flow; clave de correlación del borrador. */
  flow_token: string;
  /** Teléfono del cliente (obligatorio al crear el borrador). */
  customer_phone: string;
  /** Correlación adicional (desde `flow_action_payload.data`); no se persiste en columnas propias. */
  order_session_id?: string | null;
  conversation_id?: string | null;
  customer_name?: string | null;
  notes?: string | null;
  delivery_type: DeliveryType;
  /** Cantidades crudas indexadas por `code` de producto (tal como llegan del Flow). */
  quantitiesByCode: Record<string, unknown>;
  /** Payload original del Flow para auditoría (se guarda en `raw_flow_response`). */
  rawFlowResponse?: unknown;
}
