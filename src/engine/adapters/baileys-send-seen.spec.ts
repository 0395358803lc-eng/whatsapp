import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysContacts, BaileysContactsHost } from './baileys-contacts';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * `readMessages` reaches `fetchPrivacySettings`, whose body is
 * `const { content } = await query({...})`. On an unanswered query that destructure throws a raw
 * TypeError — no Boom, so nothing can classify it — and the caller gets a bare 500.
 *
 * Marking a chat read is idempotent in effect, so bounding it is safe: a repeat costs nothing.
 * The media send path is deliberately NOT bounded the same way — see the PR.
 */
const never = (): Promise<never> => new Promise<never>(() => undefined);

/**
 * The real fold, not an identity stub. A stub that returned its argument unchanged let the whole
 * suite pass with the `toEngineJid` call deleted outright, and left the fallback case asserting
 * `@s.whatsapp.net` while the supplied-id cases asserted `@c.us` for the same chat.
 */
const toEngineJid = (jid: string): string => {
  const [userPart, host] = jid.split('@');
  return host === 'c.us' || host === 's.whatsapp.net' ? `${userPart}@s.whatsapp.net` : jid;
};

function makeHost(overrides: Partial<Record<keyof BaileysContactsHost, unknown>>): BaileysContactsHost {
  return {
    ensureReady: () => undefined,
    logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
    normalizedSelfJid: () => '628177@s.whatsapp.net',
    listContacts: () => [],
    findContact: () => null,
    resolvePhone: () => null,
    listChats: () => [],
    lastMessage: () => ({ key: { id: 'M1', remoteJid: '628123@s.whatsapp.net' }, timestamp: 1 }),
    getStoredMessages: () => Promise.resolve([]),
    toEngineJid,
    ...overrides,
  } as unknown as BaileysContactsHost;
}

function contacts(sock: Record<string, jest.Mock>, budgetMs: number): BaileysContacts {
  return new BaileysContacts(makeHost({ getSocket: () => sock as unknown as WASocket }), budgetMs);
}

/** A stored message as the message store hands it back: the whole key, not a synthesised one. */
const stored = (key: WAMessage['key']): WAMessage => ({ key, message: {}, messageTimestamp: 1 });

describe('sendSeen', () => {
  it('reports an unanswered read receipt instead of a bare 500', async () => {
    await expect(contacts({ readMessages: jest.fn(never) }, 15).sendSeen('628123@c.us')).rejects.toBeInstanceOf(
      EngineTransportError,
    );
  });

  it('still resolves when WhatsApp answers inside the budget', async () => {
    const readMessages = jest.fn().mockResolvedValue(undefined);
    await expect(contacts({ readMessages }, 500).sendSeen('628123@c.us')).resolves.toBe(true);
  });

  it('acknowledges every supplied message, not just the newest one', async () => {
    // The whole point of the caller-supplied list: a burst of three inbound messages used to leave
    // the first two unread forever, because only lastMessage() was ever acknowledged.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    await expect(contacts({ readMessages }, 500).sendSeen('628123@c.us', ['M1', 'M2', 'M3'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([
      { remoteJid: '628123@s.whatsapp.net', id: 'M1', fromMe: false },
      { remoteJid: '628123@s.whatsapp.net', id: 'M2', fromMe: false },
      { remoteJid: '628123@s.whatsapp.net', id: 'M3', fromMe: false },
    ]);
  });

  it('carries the participant on a group receipt, which a synthesised key cannot', async () => {
    // A group receipt with no `participant` names no sender, so WhatsApp cannot attribute it and
    // the message stays unread on the sender's side while the API answers success: true.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () =>
        Promise.resolve([
          stored({ id: 'G1', remoteJid: '628999-1@g.us', fromMe: false, participant: '628123@s.whatsapp.net' }),
        ]),
    });
    await expect(new BaileysContacts(host, 500).sendSeen('628999-1@g.us', ['G1'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([
      { id: 'G1', remoteJid: '628999-1@g.us', fromMe: false, participant: '628123@s.whatsapp.net' },
    ]);
  });

  it('takes fromMe from the stored key rather than assuming inbound', async () => {
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () =>
        Promise.resolve([stored({ id: 'O1', remoteJid: '628123@s.whatsapp.net', fromMe: true })]),
    });
    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['O1'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ id: 'O1', remoteJid: '628123@s.whatsapp.net', fromMe: true }]);
  });

  it('synthesises a key only for ids the store has never seen', async () => {
    // History-sync backfill is emitted but never persisted, so a legitimate id can miss. Falling
    // back keeps the 1:1 case working instead of silently dropping the message from the receipt.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () =>
        Promise.resolve([stored({ id: 'K1', remoteJid: '628123@s.whatsapp.net', fromMe: true })]),
    });
    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['K1', 'MISSING'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([
      { id: 'K1', remoteJid: '628123@s.whatsapp.net', fromMe: true },
      { remoteJid: '628123@s.whatsapp.net', id: 'MISSING', fromMe: false },
    ]);
  });

  it('marks supplied messages even when the store has nothing cached', async () => {
    // The restart case: the in-memory store is empty, so the old code returned false under a 200
    // and no receipt was ever sent. A caller that persisted the IDs is not subject to that.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({ getSocket: () => ({ readMessages }) as unknown as WASocket, lastMessage: () => null });
    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['M9'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ remoteJid: '628123@s.whatsapp.net', id: 'M9', fromMe: false }]);
  });

  it('works without a message store at all', async () => {
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () => undefined,
    });
    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['M9'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ remoteJid: '628123@s.whatsapp.net', id: 'M9', fromMe: false }]);
  });

  it('acknowledges nothing when the caller supplies an empty list', async () => {
    // An empty list is a caller that computed its unread set and found none. Folding it into the
    // no-list branch would acknowledge the newest message, which is the opposite of the request.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    await expect(contacts({ readMessages }, 500).sendSeen('628123@c.us', [])).resolves.toBe(false);
    expect(readMessages).not.toHaveBeenCalled();
  });

  it('falls back to the cached last message when no list is supplied', async () => {
    const readMessages = jest.fn().mockResolvedValue(undefined);
    await expect(contacts({ readMessages }, 500).sendSeen('628123@c.us')).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ id: 'M1', remoteJid: '628123@s.whatsapp.net' }]);
  });

  it('still short-circuits when there is no last message to mark', async () => {
    const host = makeHost({ getSocket: () => ({}) as unknown as WASocket, lastMessage: () => null });
    await expect(new BaileysContacts(host, 15).sendSeen('628123@c.us')).resolves.toBe(false);
  });
});
