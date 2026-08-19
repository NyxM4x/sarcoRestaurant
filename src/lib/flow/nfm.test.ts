import { describe, it, expect } from 'vitest';
import { extractMessageContext, parseNfmReply } from './nfm';

const DRAFT_ID = '9f1c8f2e-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const FLOW_TOKEN = `order_${DRAFT_ID}`;

function nfmMessageWithKapso() {
  return {
    id: 'wamid.AAA',
    type: 'interactive',
    from: '59170000000',
    interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{"garbage":true}' } },
    kapso: { flow_response: { order_draft_id: DRAFT_ID, flow_token: FLOW_TOKEN } },
  };
}

function nfmMessageWithResponseJson(responseJson: string) {
  return {
    id: 'wamid.BBB',
    type: 'interactive',
    from: '59170000000',
    interactive: { type: 'nfm_reply', nfm_reply: { response_json: responseJson } },
  };
}

describe('extractMessageContext (V2 sin buffering)', () => {
  it('lee message, conversation.phone_number y phone_number_id en la raíz', () => {
    const ctx = extractMessageContext({
      message: { id: 'wamid.X', type: 'interactive', from: '591700' },
      conversation: { phone_number: '59170000000' },
      phone_number_id: 'pnid-123',
      is_new_conversation: false,
    });
    expect(ctx.messageId).toBe('wamid.X');
    expect(ctx.messageType).toBe('interactive');
    expect(ctx.conversationPhone).toBe('59170000000');
    expect(ctx.from).toBe('591700');
    expect(ctx.phoneNumberId).toBe('pnid-123');
  });

  it('NO usa el fallback payload.data.* (eso sería un batch)', () => {
    const ctx = extractMessageContext({ data: { message: { id: 'wamid.Y' } } });
    expect(ctx.messageId).toBeNull();
    expect(ctx.message).toBeUndefined();
  });
});

describe('parseNfmReply', () => {
  it('prefiere message.kapso.flow_response', () => {
    const res = parseNfmReply(nfmMessageWithKapso());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.source).toBe('kapso');
      expect(res.data.order_draft_id).toBe(DRAFT_ID);
      expect(res.data.flow_token).toBe(FLOW_TOKEN);
    }
  });

  it('usa el fallback response_json cuando no hay kapso.flow_response', () => {
    const res = parseNfmReply(
      nfmMessageWithResponseJson(
        JSON.stringify({ order_draft_id: DRAFT_ID, flow_token: FLOW_TOKEN }),
      ),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.source).toBe('response_json');
  });

  it('response_json inválido -> invalid_json', () => {
    const res = parseNfmReply(nfmMessageWithResponseJson('{no-es-json'));
    expect(res).toEqual({ ok: false, reason: 'invalid_json' });
  });

  it('shape inválido (order_draft_id no UUID) -> invalid_shape', () => {
    const res = parseNfmReply(
      nfmMessageWithResponseJson(JSON.stringify({ order_draft_id: 'x', flow_token: FLOW_TOKEN })),
    );
    expect(res).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('flow_token con formato inválido -> invalid_shape', () => {
    const res = parseNfmReply(
      nfmMessageWithResponseJson(JSON.stringify({ order_draft_id: DRAFT_ID, flow_token: DRAFT_ID })),
    );
    expect(res).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('mensaje no interactivo -> not_nfm', () => {
    const res = parseNfmReply({ id: 'wamid.T', type: 'text', text: { body: 'hola' } });
    expect(res).toEqual({ ok: false, reason: 'not_nfm' });
  });

  it('interactivo pero no nfm_reply -> not_nfm', () => {
    const res = parseNfmReply({
      id: 'wamid.T',
      type: 'interactive',
      interactive: { type: 'button_reply' },
    });
    expect(res).toEqual({ ok: false, reason: 'not_nfm' });
  });
});
