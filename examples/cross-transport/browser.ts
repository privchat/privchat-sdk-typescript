import { decodeMessagePayloadEnvelope, parseRpcJson, PrivchatClient } from '../../src/index.js';
import { CacheDB } from '../../src/cache-idb.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function check(condition: unknown, text: string): asserts condition {
  if (!condition) throw new Error(text);
}

async function until<T>(description: string, test: () => T | undefined): Promise<T> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const result = test();
    if (result !== undefined) return result;
    await delay(150);
  }
  throw new Error(`timed out: ${description}`);
}

async function read<T>(name: string): Promise<T> {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const response = await fetch(`/state/${name}`, { cache: 'no-store' });
    if (response.status === 200) return response.json() as Promise<T>;
    await delay(150);
  }
  throw new Error(`timed out: ${name}`);
}

async function signal(name: string, value: unknown = {}) {
  const response = await fetch(`/state/${name}`, { method: 'POST', body: JSON.stringify(value) });
  check(response.ok, `failed to signal ${name}`);
}

async function run() {
  const fixture = await read<{ group: string; uid: string; token: string; device: string }>('fixture');
  const group = fixture.group;
  const type = 2;
  const client = new PrivchatClient({
    url: `ws://${location.host}/gate`,
    cache: { enabled: true, db: new CacheDB(`sd12-${fixture.uid}`) },
    reconnect: { initialDelayMs: 250, maxDelayMs: 1000 },
  });
  await client.connect();
  await client.authenticate(fixture.uid, fixture.token, fixture.device);
  await client.bootstrapChannels();
  await client.subscribeChannel(group, type);
  await client.openConversation(group, type);

  function row(id: string) {
    const rows = client.getCachedMessages(group, type).filter(m => m.server_message_id === id);
    check(rows.length <= 1, 'duplicate browser local projection');
    return rows[0];
  }
  const localChannel = () => client.cachedChannels().find(c => c.channel_id === group);
  await signal('browser-ready');

  const online = await read<{ quic: string; tcp: string }>('online');
  await until('QUIC and TCP messages in browser cache', () =>
    row(online.quic)?.content === 'sd12-from-quic' && row(online.tcp)?.content === 'sd12-from-tcp' ? true : undefined);
  const sent = await client.sendTextMessage({
    channel_id: group, channel_type: type, from_uid: fixture.uid, content: 'sd12-from-browser',
  });
  check(sent.status === 'sent', 'browser send queued instead of sent');
  await signal('browser-sent', { id: String(sent.response.server_message_id) });

  const attachment = await read<{ message: string; file: string }>('attachment');
  const received = await until('attachment in browser cache', () => row(attachment.message));
  const metadata = received.payload[0] === 0x7b
    ? parseRpcJson<{ metadata?: { file_id?: string | number } }>(new TextDecoder().decode(received.payload)).metadata
    : decodeMessagePayloadEnvelope(received.payload).metadata as { file_id?: string };
  check(received.message_type === 'image' && String(metadata?.file_id) === attachment.file, 'browser metadata has wrong file ID');
  const file = Number(attachment.file);
  check(Number.isSafeInteger(file), 'file ID cannot be sent losslessly through downloadAttachmentBlob');
  const blob = await client.downloadAttachmentBlob(file);
  const actual = new Uint8Array(await blob.arrayBuffer());
  const expected = new Uint8Array(await (await fetch('/attachment.png')).arrayBuffer());
  check(actual.length > 0 && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]), 'attachment bytes differ');

  // The fixture closes the actual WebSocket and blocks handshakes until Rust
  // has committed both the revoke and the next message.
  await signal('drop-websocket');
  await until('browser observed transport loss', () =>
    client.connectionState() === 'reconnecting' ? true : undefined);
  await signal('browser-offline');

  const resume = await read<{ revoked: string; message: string; pts: string }>('resume');
  await until('SDK automatic reconnect and local catch-up', () =>
    row(resume.revoked)?.revoked === true && row(resume.message)?.content === 'sd12-offline' &&
    (localChannel()?.unread_count ?? 0) > 0 ? true : undefined);
  await client.markRead(group, type, resume.pts);
  await until('local read cursor and unread cleared', () =>
    localChannel()?.read_pts === resume.pts && localChannel()?.unread_count === 0 ? true : undefined);
  await signal('browser-read');
  document.body.textContent = 'PASS: browser WebSocket';
  await client.disconnect();
}

run().catch(async error => {
  document.body.textContent = String(error);
  await signal('browser-error', { error: String(error) });
});
