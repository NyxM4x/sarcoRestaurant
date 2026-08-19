import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AGENT_CONVERSATION_STATES,
  AGENT_CONTROL_ACTIONS,
  AGENT_CONTROL_SOURCES,
  AGENT_MESSAGE_ACTORS,
  AGENT_MESSAGE_CONTENT_TYPES,
  AGENT_MESSAGE_DIRECTIONS,
  AGENT_MESSAGE_ROLES,
  AGENT_RUN_BARRIERS,
  AGENT_RUN_STATUSES,
} from '@/types';

/**
 * Verificación ESTÁTICA del contrato de 0014_agent_foundation.sql (6D.2F.1B).
 *
 * Fija el schema congelado en SCHEMA_FREEZE_V3_READY: cuatro tablas agent_*,
 * cero cambios sobre tablas existentes, cero RPC, `last_message_at` derivado por
 * trigger, permisos append-only reales en agent_control_events y ausencia total
 * de runtime (OpenAI, tools, organization_id).
 *
 * Los tipos de `@/types` se comparan CONTRA el SQL para que ambos no puedan
 * divergir en silencio.
 */

const sql = readFileSync(
  fileURLToPath(
    new URL('../../../supabase/migrations/0014_agent_foundation.sql', import.meta.url),
  ),
  'utf8',
);
/** Sin comentarios: se verifica el DDL, no la documentación. */
const code = sql.replace(/--[^\n]*/g, '');
/** Espacios colapsados: evita fragilidad por formato/saltos de línea. */
const flat = code.replace(/\s+/g, ' ');

const TABLES = [
  'agent_conversations',
  'agent_messages',
  'agent_runs',
  'agent_control_events',
] as const;

/** Tablas que ya existen en producción y que 0014 NO puede tocar. */
const EXISTING_TABLES = [
  'webhook_events',
  'orders',
  'order_items',
  'menu_items',
  'menu_sessions',
  'order_notifications',
] as const;

/** Sentencias `create [unique] index` reales del archivo. */
const indexStatements = code.match(/create (?:unique )?index[\s\S]*?;/g) ?? [];
/** Sentencias `grant ...` reales del archivo. */
const grantStatements = code.match(/grant [\s\S]*?;/g) ?? [];

describe('0014 — envoltura y alcance de la migración', () => {
  it('es atómica: begin; ... commit;', () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code.trimEnd()).toMatch(/commit;$/);
  });

  it('documenta que NO se ejecuta automáticamente y que va después de 0013', () => {
    expect(sql).toContain('NO ejecutar automáticamente');
    expect(sql).toMatch(/0013/);
  });

  it('crea exactamente las cuatro tablas agent_*, en orden', () => {
    const created = [...code.matchAll(/create table if not exists public\.(\w+)/g)].map(
      (m) => m[1],
    );
    expect(created).toEqual([...TABLES]);
  });

  it('no incluye seed ni backfill', () => {
    expect(code).not.toMatch(/\binsert\s+into\b/i);
    expect(code).not.toMatch(/\bupdate\s+public\./i);
  });

  it('no crea RPC: la única función es el trigger de last_message_at', () => {
    const fns = [...code.matchAll(/create or replace function public\.(\w+)/g)].map(
      (m) => m[1],
    );
    expect(fns).toEqual(['agent_conversations_sync_last_message_at']);
    expect(code).not.toMatch(/grant execute/);
  });

  it('no redefine set_updated_at(): solo la reutiliza', () => {
    expect(code).not.toMatch(/create or replace function (public\.)?set_updated_at/);
    expect(code).toContain('execute function public.set_updated_at()');
  });

  it('sin organization_id, sin capa comercial, sin tabla de tool-calls', () => {
    for (const forbidden of [
      'organization_id',
      'tool_call',
      'agent_action',
      'business_outcome',
      'opportunit',
    ]) {
      expect(code.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('la ÚNICA mención de OpenAI es el valor de barrera `pre_openai`', () => {
    const hits = code.match(/\w*openai\w*/gi) ?? [];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit === 'pre_openai')).toBe(true);
  });
});

describe('0014 — cero cambios sobre tablas existentes', () => {
  it('todo `alter table` apunta a una tabla agent_* (solo RLS)', () => {
    const altered = [...code.matchAll(/alter table public\.(\w+)/g)].map((m) => m[1]);
    expect(altered.length).toBeGreaterThan(0);
    for (const table of altered) {
      expect(TABLES).toContain(table as (typeof TABLES)[number]);
    }
    // Los únicos ALTER son de RLS: ni add/drop column, ni add/drop constraint.
    expect(code).not.toMatch(/alter table[\s\S]*?(add|drop) (column|constraint)/);
  });

  it('no menciona ninguna tabla de producción existente', () => {
    for (const table of EXISTING_TABLES) {
      expect(code).not.toContain(`public.${table}`);
    }
  });
});

describe('0014 — agent_conversations: identidad durable', () => {
  it('customer_phone es UNIQUE (una conversación por teléfono, para siempre)', () => {
    expect(flat).toContain(
      'constraint agent_conversations_customer_phone_unique unique (customer_phone)',
    );
  });

  it('customer_phone solo admite dígitos 8–15 (paridad con normalizePhone)', () => {
    expect(flat).toContain("check (customer_phone ~ '^[0-9]{8,15}$')");
  });

  it('el id de conversación del proveedor es referencia técnica, no identidad', () => {
    expect(flat).toMatch(/last_provider_conversation_id text,/);
    // Nunca UNIQUE ni NOT NULL: cambia con las ventanas del proveedor.
    expect(flat).not.toMatch(/last_provider_conversation_id text (not null|unique)/);
  });

  it('provider_phone_number_id es nullable: persistir historial nunca falla', () => {
    expect(flat).toMatch(/provider_phone_number_id text,/);
    expect(flat).not.toMatch(/provider_phone_number_id text not null/);
  });
});

describe('0014 — agent_conversations: estado ACTUAL, no historial', () => {
  it('el dominio de state coincide con AGENT_CONVERSATION_STATES', () => {
    expect(flat).toContain("check (state in ('active', 'paused'))");
    expect([...AGENT_CONVERSATION_STATES]).toEqual(['active', 'paused']);
  });

  it('paused exige paused_at/reason/source y resumed_at NULL', () => {
    expect(flat).toContain(
      "state = 'paused' and paused_at is not null and pause_reason is not null " +
        'and pause_source is not null and resumed_at is null',
    );
  });

  it('active limpia TODOS los campos de pausa (no conserva la pausa anterior)', () => {
    expect(flat).toContain(
      "state = 'active' and paused_at is null and pause_expires_at is null " +
        'and pause_reason is null and pause_source is null',
    );
  });

  it('resumed_at queda libre en active: es el único discriminante del resume', () => {
    // La rama active NO restringe resumed_at (ni is null ni is not null).
    const branch = flat.slice(
      flat.indexOf("state = 'active' and paused_at is null"),
    );
    expect(branch.slice(0, 200)).not.toContain('resumed_at');
  });

  it('pause_expires_at NULL = indefinida; si existe, posterior a paused_at', () => {
    expect(flat).toContain(
      'check (pause_expires_at is null or (paused_at is not null and pause_expires_at > paused_at))',
    );
  });

  it('pause_source usa el mismo dominio que agent_control_events.source', () => {
    expect(flat).toContain(
      "check (pause_source is null or pause_source in ('business_app', 'dashboard', 'api', 'system'))",
    );
  });

  it('pause_reason usa el charset corto y seguro de los códigos del repo', () => {
    expect(flat).toContain(
      "check (pause_reason is null or pause_reason ~ '^[A-Za-z0-9._:-]{1,64}$')",
    );
  });

  it('NO existe una constraint resumed_at >= paused_at (sería inexpresable)', () => {
    // Bajo esta semántica paused_at y resumed_at nunca son ambos no nulos.
    expect(flat).not.toMatch(/resumed_at >= paused_at/);
  });
});

describe('0014 — agent_conversations: marcas temporales', () => {
  it('incluye first_customer_message_at (una conversación puede nacer sin cliente)', () => {
    expect(flat).toContain('first_customer_message_at timestamptz');
  });

  it('incluye first_ai_message_at (tiempo hasta primera respuesta de la IA)', () => {
    expect(flat).toContain('first_ai_message_at timestamptz');
  });

  it('incluye los cuatro last_* por actor, con automation separado de ai', () => {
    for (const col of [
      'last_customer_message_at',
      'last_ai_message_at',
      'last_human_message_at',
      'last_automation_message_at',
    ]) {
      expect(flat).toContain(`${col} timestamptz`);
    }
  });

  it('NO añade first_automation_message_at ni first_human_message_at', () => {
    expect(code).not.toContain('first_automation_message_at');
    expect(code).not.toContain('first_human_message_at');
  });

  it('empareja y ordena first/last de customer y de ai', () => {
    expect(flat).toContain(
      'check ((first_customer_message_at is null) = (last_customer_message_at is null))',
    );
    expect(flat).toContain(
      'check (first_customer_message_at is null or first_customer_message_at <= last_customer_message_at)',
    );
    expect(flat).toContain(
      'check ((first_ai_message_at is null) = (last_ai_message_at is null))',
    );
    expect(flat).toContain(
      'check (first_ai_message_at is null or first_ai_message_at <= last_ai_message_at)',
    );
  });
});

describe('0014 — last_message_at derivado y exacto (los cuatro actores)', () => {
  it('el CHECK exige el MÁXIMO exacto, con is not distinct from', () => {
    expect(flat).toContain(
      'constraint agent_conversations_last_message_at_is_exact_max check ( ' +
        'last_message_at is not distinct from greatest( last_customer_message_at, ' +
        'last_ai_message_at, last_human_message_at, last_automation_message_at ) )',
    );
  });

  it('la función de trigger deriva el máximo de los cuatro actores', () => {
    expect(flat).toContain(
      'new.last_message_at := greatest( new.last_customer_message_at, ' +
        'new.last_ai_message_at, new.last_human_message_at, new.last_automation_message_at )',
    );
  });

  it('el trigger es BEFORE INSERT OR UPDATE (cubre el primer mensaje)', () => {
    expect(flat).toContain(
      'create trigger trg_agent_conversations_last_message_at before insert or update ' +
        'on public.agent_conversations for each row execute function ' +
        'public.agent_conversations_sync_last_message_at()',
    );
  });

  it('la función fija search_path (patrón de 0004)', () => {
    expect(flat).toContain(
      'create or replace function public.agent_conversations_sync_last_message_at() ' +
        'returns trigger language plpgsql set search_path = public',
    );
  });

  it('updated_at reutiliza el trigger genérico de 0001', () => {
    expect(flat).toContain(
      'create trigger trg_agent_conversations_updated_at before update ' +
        'on public.agent_conversations for each row execute function public.set_updated_at()',
    );
  });
});

describe('0014 — agent_messages: cuatro actores, cuatro combinaciones válidas', () => {
  it('el dominio de actor coincide con AGENT_MESSAGE_ACTORS', () => {
    expect(flat).toContain(
      "check (actor in ('customer', 'ai', 'human', 'automation'))",
    );
    expect([...AGENT_MESSAGE_ACTORS]).toEqual(['customer', 'ai', 'human', 'automation']);
  });

  it('direction y role conservan sus dominios de dos valores', () => {
    expect(flat).toContain("check (direction in ('inbound', 'outbound'))");
    expect(flat).toContain("check (role in ('user', 'assistant'))");
    expect([...AGENT_MESSAGE_DIRECTIONS]).toEqual(['inbound', 'outbound']);
    expect([...AGENT_MESSAGE_ROLES]).toEqual(['user', 'assistant']);
  });

  it('la coherencia deja 4 combinaciones de las 16 posibles', () => {
    expect(flat).toContain(
      "(direction = 'inbound' and role = 'user' and actor = 'customer') or " +
        "(direction = 'outbound' and role = 'assistant' and actor in ('ai', 'human', 'automation'))",
    );
  });

  it('automation es outbound/assistant, nunca un actor de eventos internos', () => {
    // No existe 'system' ni 'internal' como actor: los marcadores son irrepresentables.
    expect(flat).not.toMatch(/actor in \([^)]*'system'/);
    expect(code).not.toContain('MEDIA_SENT');
    expect(code).not.toContain('PRODUCT_CONTEXT');
  });
});

describe('0014 — agent_messages: content nullable con coherencia', () => {
  it('content es NULLABLE (un GPS o un sticker no tienen texto)', () => {
    expect(flat).toMatch(/\bcontent text,/);
    expect(flat).not.toMatch(/\bcontent text not null/);
  });

  it('text exige contenido real; el resto admite NULL pero nunca cadena vacía', () => {
    expect(flat).toContain(
      "(content_type = 'text' and content is not null and btrim(content) <> '') or " +
        "(content_type <> 'text' and (content is null or btrim(content) <> ''))",
    );
  });

  it('el dominio de content_type coincide con AGENT_MESSAGE_CONTENT_TYPES', () => {
    for (const type of AGENT_MESSAGE_CONTENT_TYPES) {
      expect(flat).toMatch(new RegExp(`'${type}'`));
    }
    expect(flat).toContain(
      "content_type in ('text', 'image', 'audio', 'video', 'document', " +
        "'sticker', 'location', 'interactive', 'unknown')",
    );
  });
});

describe('0014 — agent_messages: metadata, WAMID e índices', () => {
  it('metadata es NULL o un objeto JSON, sin schema de claves', () => {
    expect(flat).toContain(
      "check (metadata is null or jsonb_typeof(metadata) = 'object')",
    );
    // Las convenciones action/resource_* son de TypeScript, no del SQL.
    expect(code).not.toContain('resource_key');
  });

  it('no persiste secretos por schema', () => {
    for (const secret of ['session_token', 'api_key', 'token_hash']) {
      expect(code).not.toContain(secret);
    }
  });

  it('provider_message_id es nullable con UNIQUE PARCIAL', () => {
    expect(flat).toMatch(/provider_message_id text,/);
    expect(flat).toContain(
      'create unique index if not exists uq_agent_messages_provider_message_id ' +
        'on public.agent_messages (provider_message_id) where provider_message_id is not null',
    );
  });

  it('índice de historial reciente con desempate estable por id', () => {
    expect(flat).toContain(
      'create index if not exists ix_agent_messages_recent on public.agent_messages ' +
        '(agent_conversation_id, message_timestamp desc, id desc)',
    );
  });

  it('NO crea índices GIN ni de expresión sobre metadata', () => {
    expect(code.toLowerCase()).not.toContain('using gin');
    expect(code.toLowerCase()).not.toContain('jsonb_path_ops');
    for (const stmt of indexStatements) {
      expect(stmt).not.toContain('metadata');
    }
  });

  it('message_timestamp es obligatorio y con rango de cordura', () => {
    expect(flat).toContain('message_timestamp timestamptz not null');
    expect(flat).toContain("message_timestamp >= timestamptz '2000-01-01T00:00:00Z'");
    expect(flat).toContain("message_timestamp < timestamptz '2100-01-01T00:00:00Z'");
  });

  it('la FK a la conversación cascadea', () => {
    expect(flat).toContain(
      'agent_conversation_id uuid not null references public.agent_conversations (id) on delete cascade',
    );
  });
});

describe('0014 — agent_runs: idempotencia semántica y estados', () => {
  it('source_message_id es UNIQUE y no vacío', () => {
    expect(flat).toContain(
      'constraint agent_runs_source_message_id_unique unique (source_message_id)',
    );
    expect(flat).toContain("check (btrim(source_message_id) <> '')");
  });

  it('los seis estados coinciden con AGENT_RUN_STATUSES', () => {
    expect(flat).toContain(
      "check (status in ( 'processing', 'sending', 'completed', 'skipped_paused', " +
        "'failed', 'send_unknown' ))",
    );
    expect([...AGENT_RUN_STATUSES]).toEqual([
      'processing',
      'sending',
      'completed',
      'skipped_paused',
      'failed',
      'send_unknown',
    ]);
  });

  it('skipped_at_barrier coincide con AGENT_RUN_BARRIERS y solo aplica a skipped_paused', () => {
    expect(flat).toContain(
      "check ( skipped_at_barrier is null or skipped_at_barrier in ('pre_openai', 'pre_send') )",
    );
    expect(flat).toContain(
      "check ( skipped_at_barrier is null or status = 'skipped_paused' )",
    );
    expect([...AGENT_RUN_BARRIERS]).toEqual(['pre_openai', 'pre_send']);
  });

  it('attempt_count >= 1 y tool_rounds >= 0 (el tope de rondas es política, no schema)', () => {
    expect(flat).toContain('check (attempt_count >= 1)');
    expect(flat).toContain('check (tool_rounds >= 0)');
    expect(flat).not.toMatch(/tool_rounds between/);
  });

  it('completed_at nunca precede a started_at', () => {
    expect(flat).toContain(
      'check ( completed_at is null or completed_at >= started_at )',
    );
  });

  it('error_code usa el charset corto y seguro', () => {
    expect(flat).toContain(
      "check ( error_code is null or error_code ~ '^[A-Za-z0-9._:-]{1,64}$' )",
    );
  });
});

describe('0014 — agent_runs: coherencia de estados y FKs', () => {
  it('los estados EN CURSO no llevan cierre, puntero ni error', () => {
    expect(flat).toContain(
      "status in ('processing', 'sending') and completed_at is null " +
        'and response_message_id is null and error_code is null',
    );
  });

  it('completed NO exige response_message_id (retención puede hacer SET NULL)', () => {
    expect(flat).toContain(
      "status = 'completed' and completed_at is not null and error_code is null",
    );
    // La clave del ajuste: en ninguna parte se exige el puntero presente.
    expect(code).not.toContain('response_message_id is not null');
  });

  it('skipped_paused es terminal, sin respuesta y con barrera registrada', () => {
    expect(flat).toContain(
      "status = 'skipped_paused' and completed_at is not null " +
        'and response_message_id is null and error_code is null ' +
        'and skipped_at_barrier is not null',
    );
  });

  it('failed y send_unknown son terminales con código de error', () => {
    expect(flat).toContain(
      "status = 'failed' and completed_at is not null and response_message_id is null " +
        'and error_code is not null',
    );
    expect(flat).toContain(
      "status = 'send_unknown' and completed_at is not null and error_code is not null",
    );
  });

  it('los punteros a mensajes son nullable y usan ON DELETE SET NULL', () => {
    expect(flat).toContain(
      'source_agent_message_id uuid references public.agent_messages (id) on delete set null',
    );
    expect(flat).toContain(
      'response_message_id uuid references public.agent_messages (id) on delete set null',
    );
    // Nullable es requisito de SET NULL: ninguno puede ser NOT NULL.
    expect(flat).not.toMatch(/(source_agent_message_id|response_message_id) uuid not null/);
  });

  it('la conversación sí cascadea (borrarla se lleva sus runs)', () => {
    expect(
      (flat.match(/references public\.agent_conversations \(id\) on delete cascade/g) ?? [])
        .length,
    ).toBe(3);
    expect(
      (flat.match(/references public\.agent_messages \(id\) on delete set null/g) ?? [])
        .length,
    ).toBe(2);
  });

  it('índice de runs colgados sobre processing/sending', () => {
    expect(flat).toContain(
      'create index if not exists ix_agent_runs_stale on public.agent_runs (started_at) ' +
        "where status in ('processing', 'sending')",
    );
  });

  it('NO implementa todavía la recuperación de stale', () => {
    expect(code).not.toContain('stale_abandoned');
    expect(code).not.toContain('stale_sending_unknown');
  });
});

describe('0014 — agent_control_events: append-only', () => {
  it('action y source coinciden con los tipos de TypeScript', () => {
    expect(flat).toContain("check (action in ('pause', 'resume'))");
    expect(flat).toContain(
      "check (source in ('business_app', 'dashboard', 'api', 'system'))",
    );
    expect([...AGENT_CONTROL_ACTIONS]).toEqual(['pause', 'resume']);
    expect([...AGENT_CONTROL_SOURCES]).toEqual([
      'business_app',
      'dashboard',
      'api',
      'system',
    ]);
  });

  it('no tiene updated_at ni trigger de updated_at', () => {
    const table = flat.slice(
      flat.indexOf('create table if not exists public.agent_control_events'),
    );
    const body = table.slice(0, table.indexOf(');'));
    expect(body).not.toContain('updated_at');
    expect(flat).not.toContain('trg_agent_control_events_updated_at');
  });

  it('idempotencia parcial por (conversación, action, WAMID)', () => {
    expect(flat).toContain(
      'create unique index if not exists uq_agent_control_events_provider_action ' +
        'on public.agent_control_events (agent_conversation_id, action, provider_message_id) ' +
        'where provider_message_id is not null',
    );
  });

  it('expires_at solo es válido en una pausa', () => {
    expect(flat).toContain("check (expires_at is null or action = 'pause')");
  });

  it('metadata es NULL o un objeto JSON', () => {
    expect(
      (flat.match(/jsonb_typeof\(metadata\) = 'object'/g) ?? []).length,
    ).toBe(2);
  });
});

describe('0014 — índices: recuento derivado del DDL real', () => {
  it('9 sentencias CREATE [UNIQUE] INDEX, 2 de ellas únicas', () => {
    expect(indexStatements.length).toBe(9);
    expect(indexStatements.filter((s) => s.startsWith('create unique index')).length).toBe(2);
  });

  it('5 de esos índices son PARCIALES', () => {
    expect(indexStatements.filter((s) => /\swhere\s/.test(s)).length).toBe(5);
  });

  it('15 índices físicos = 4 PK + 2 UNIQUE constraint + 9 CREATE INDEX', () => {
    const primaryKeys = (code.match(/primary key/g) ?? []).length;
    const uniqueConstraints = (flat.match(/constraint \w+ unique \(/g) ?? []).length;
    expect(primaryKeys).toBe(4);
    expect(uniqueConstraints).toBe(2);
    expect(primaryKeys + uniqueConstraints + indexStatements.length).toBe(15);
  });

  it('todos los índices explícitos son idempotentes', () => {
    for (const stmt of indexStatements) {
      expect(stmt).toContain('if not exists');
    }
  });
});

describe('0014 — RLS y permisos', () => {
  it('habilita RLS en las cuatro tablas', () => {
    for (const table of TABLES) {
      expect(flat).toContain(`alter table public.${table} enable row level security`);
    }
  });

  it('NO crea ninguna policy', () => {
    expect(code).not.toMatch(/create policy/i);
  });

  it('revoca de public, anon, authenticated Y service_role en las cuatro tablas', () => {
    for (const table of TABLES) {
      for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
        expect(flat).toContain(`revoke all on table public.${table} from ${role};`);
      }
    }
  });

  it('conversations, messages y runs: select/insert/update, sin DELETE', () => {
    for (const table of ['agent_conversations', 'agent_messages', 'agent_runs']) {
      expect(flat).toContain(
        `grant select, insert, update on table public.${table} to service_role;`,
      );
    }
  });

  it('control_events es append-only real: solo SELECT e INSERT', () => {
    expect(flat).toContain(
      'grant select, insert on table public.agent_control_events to service_role;',
    );
    const controlGrant = grantStatements.find((s) => s.includes('agent_control_events'));
    expect(controlGrant).toBeDefined();
    expect(controlGrant).not.toContain('update');
    expect(controlGrant).not.toContain('delete');
  });

  it('ninguna tabla concede DELETE a service_role', () => {
    expect(grantStatements.length).toBe(4);
    for (const stmt of grantStatements) {
      expect(stmt).not.toContain('delete');
      expect(stmt).toContain('to service_role');
    }
  });
});
