import { describe, expect, it } from 'vitest';
import {
  mergeOnPushAbsorb,
  type MessageRecord,
} from '../../src/cache/index.js';

const SELF_UID = 'self-1';
const PEER_UID = 'peer-2';

function rec(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    channel_id: '12345',
    channel_type: 1,
    server_message_id: 's-1',
    from_uid: PEER_UID,
    message_type: 'text',
    content: 'hello',
    payload: new Uint8Array(),
    timestamp: 1_700_000_000_000,
    status: 'received',
    ...overrides,
  };
}

describe('mergeOnPushAbsorb', () => {
  it('returns incoming verbatim when there is no existing row', () => {
    const incoming = rec();
    const result = mergeOnPushAbsorb(undefined, incoming, { currentUserId: SELF_UID });
    expect(result).toBe(incoming);
  });

  it('preserves an acked own-message row when self-push lands with empty content', () => {
    const existing = rec({
      from_uid: SELF_UID,
      content: 'phase14 outbox @ 1234',
      local_message_id: 'L-9',
      status: 'sent',
      pts: '7',
    });
    const incoming = rec({
      from_uid: SELF_UID,
      content: '', // push wire doesn't carry content
      status: 'received',
      pts: '7',
    });
    const result = mergeOnPushAbsorb(existing, incoming, { currentUserId: SELF_UID });
    expect(result.status).toBe('sent');
    expect(result.content).toBe('phase14 outbox @ 1234');
    expect(result.local_message_id).toBe('L-9');
    expect(result.pts).toBe('7');
  });

  it('absorbs incoming.pts into an acked row that lacked it', () => {
    const existing = rec({
      from_uid: SELF_UID,
      content: 'hi',
      status: 'sent',
      pts: undefined,
    });
    const incoming = rec({ from_uid: SELF_UID, content: '', status: 'received', pts: '42' });
    const result = mergeOnPushAbsorb(existing, incoming, { currentUserId: SELF_UID });
    expect(result.status).toBe('sent');
    expect(result.content).toBe('hi');
    expect(result.pts).toBe('42');
  });

  it('promotes a pending local echo when self-push wins the ACK race', () => {
    const existing = rec({
      server_message_id: undefined,
      local_message_id: 'L-10',
      from_uid: SELF_UID,
      content: '不能变空',
      payload: new TextEncoder().encode('不能变空'),
      status: 'pending',
      pts: undefined,
    });
    const incoming = rec({
      server_message_id: 's-10',
      local_message_id: 'L-10',
      from_uid: SELF_UID,
      content: '',
      payload: new Uint8Array(),
      status: 'received',
      pts: '43',
    });
    const result = mergeOnPushAbsorb(existing, incoming, { currentUserId: SELF_UID });
    expect(result).toMatchObject({
      server_message_id: 's-10',
      local_message_id: 'L-10',
      content: '不能变空',
      status: 'sent',
      pts: '43',
    });
    expect(result.payload).toEqual(existing.payload);
  });

  it('promotes revoked from incoming when existing was non-revoked', () => {
    const existing = rec({ from_uid: SELF_UID, status: 'sent', revoked: false });
    const incoming = rec({ from_uid: SELF_UID, content: '', status: 'received', revoked: true });
    const result = mergeOnPushAbsorb(existing, incoming, { currentUserId: SELF_UID });
    expect(result.revoked).toBe(true);
    expect(result.status).toBe('sent');
  });

  it('takes incoming as-is for remote pushes (from_uid !== currentUserId)', () => {
    const existing = rec({
      from_uid: PEER_UID,
      content: 'placeholder',
      status: 'sent', // unusual but tests the branch
    });
    const incoming = rec({ from_uid: PEER_UID, content: 'real-content', status: 'received' });
    const result = mergeOnPushAbsorb(existing, incoming, { currentUserId: SELF_UID });
    expect(result).toBe(incoming);
  });

  it('takes incoming as-is when existing row is not in `sent` status', () => {
    const existing = rec({ from_uid: SELF_UID, content: 'old', status: 'received' });
    const incoming = rec({ from_uid: SELF_UID, content: 'new', status: 'received' });
    const result = mergeOnPushAbsorb(existing, incoming, { currentUserId: SELF_UID });
    expect(result).toBe(incoming);
  });

  it('treats incoming as remote when currentUserId is undefined', () => {
    const existing = rec({ from_uid: SELF_UID, status: 'sent', content: 'old' });
    const incoming = rec({ from_uid: SELF_UID, status: 'received', content: '' });
    const result = mergeOnPushAbsorb(existing, incoming, { currentUserId: undefined });
    expect(result).toBe(incoming); // no auth → no own-message branch → take incoming
  });
});
