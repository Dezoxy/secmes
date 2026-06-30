import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { Conversation as MlsGroup } from '@argus/crypto';
import { uploadAttachment } from '../../lib/attachments';
import { GroupStateConflict, type StoredMessage } from '../../lib/keystore';
import type { AttachmentRef } from '../../lib/message-envelope';
import { sendLiveMessage, type MessagingDeps } from '../../lib/messaging';
import { getMlsSession } from '../../lib/mls';
import type { Attachment, Conversation, Message } from './seed';
import { currentUser } from './seed';

interface UseMessageSendingOptions {
  selectedId: string | null;
  isLive: (id: string | null) => boolean;
  liveGroups: { current: Map<string, MlsGroup> };
  messagingDeps: MessagingDeps | null;
  appendHistory: (conversationId: string, entries: StoredMessage[]) => void;
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
}

export function appendMessageToConversation(
  conversations: Conversation[],
  conversationId: string,
  message: Message,
): Conversation[] {
  return conversations.map((conversation) =>
    conversation.id === conversationId
      ? { ...conversation, messages: [...conversation.messages, message] }
      : conversation,
  );
}

export function patchConversationMessage(
  conversations: Conversation[],
  conversationId: string,
  messageId: string,
  patch: Partial<Message>,
): Conversation[] {
  return conversations.map((conversation) =>
    conversation.id === conversationId
      ? {
          ...conversation,
          messages: conversation.messages.map((message) =>
            message.id === messageId ? { ...message, ...patch } : message,
          ),
        }
      : conversation,
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('failed to read file'));
    reader.readAsDataURL(file);
  });
}

// Local data-URI attachment (never an object URL or server URL). Images render inline; other files
// become a chip. Attachments are demo-local — only the text body goes through the MLS round-trip.
async function toAttachment(file: File): Promise<Attachment> {
  const id = `att-${crypto.randomUUID()}`;
  const size = `${(file.size / 1024 / 1024).toFixed(1)} MB`;
  if (file.type.startsWith('image/')) {
    return { id, type: 'image', url: await fileToDataUrl(file), name: file.name, size };
  }
  return { id, type: 'file', url: '#', name: file.name, size };
}

export function useMessageSending({
  selectedId,
  isLive,
  liveGroups,
  messagingDeps,
  appendHistory,
  setConversations,
}: UseMessageSendingOptions): (content: string, files?: File[]) => void {
  const patchMessage = useCallback(
    (convId: string, msgId: string, patch: Partial<Message>): void => {
      setConversations((prev) => patchConversationMessage(prev, convId, msgId, patch));
    },
    [setConversations],
  );

  // Live send (Slice 5 + attachments A3): encrypt -> persist the advanced ratchet -> POST ciphertext.
  const sendLive = useCallback(
    (
      convId: string,
      group: MlsGroup,
      deps: MessagingDeps,
      content: string,
      files: File[] = [],
    ): void => {
      const id = `msg-${crypto.randomUUID()}`;
      const timestamp = new Date();
      const ts = timestamp.toISOString();
      let refs: AttachmentRef[] = [];
      const logSend = (status: string, encrypted = false): void =>
        appendHistory(convId, [
          {
            id,
            senderId: currentUser.id,
            content,
            timestamp: ts,
            status,
            encrypted,
            attachments: refs.length ? refs : undefined,
          },
        ]);

      void (async () => {
        const echo: Attachment[] = await Promise.all(
          files.map(async (file): Promise<Attachment> => ({
            id: `att-${crypto.randomUUID()}`,
            type: file.type.startsWith('image/') ? 'image' : 'file',
            name: file.name,
            size: `${(file.size / 1024 / 1024).toFixed(1)} MB`,
            url: file.type.startsWith('image/') ? await fileToDataUrl(file) : undefined,
          })),
        );
        const message: Message = {
          id,
          senderId: currentUser.id,
          content,
          timestamp,
          status: 'sending',
          attachments: echo.length ? echo : undefined,
        };
        setConversations((prev) => appendMessageToConversation(prev, convId, message));
        logSend('sending');
        try {
          refs = await Promise.all(files.map((file) => uploadAttachment(convId, file)));
          await sendLiveMessage(deps, convId, group, content, refs);
          const sentAttachments = echo.map((attachment, index) => ({
            ...attachment,
            ref: refs[index],
          }));
          patchMessage(convId, id, {
            status: 'sent',
            encrypted: true,
            attachments: sentAttachments.length ? sentAttachments : undefined,
          });
          logSend('sent', true);
        } catch (err) {
          patchMessage(convId, id, { status: 'failed' });
          logSend('failed');
          // id/metadata only in the log; never plaintext keys, tokens, or server URLs.
          // eslint-disable-next-line no-console
          console.warn(
            err instanceof GroupStateConflict
              ? 'send: another tab is active for this conversation — reload to continue'
              : 'send failed',
            convId,
            err instanceof Error ? err.message : err,
          );
        }
      })();
    },
    [appendHistory, patchMessage, setConversations],
  );

  return useCallback(
    (content: string, files?: File[]): void => {
      if (!selectedId) return;
      const convId = selectedId;

      if (isLive(convId)) {
        const group = liveGroups.current.get(convId);
        const deps = messagingDeps;
        if (!group || !deps) return;
        const fileList = files ?? [];
        if (!content.trim() && fileList.length === 0) return;
        sendLive(convId, group, deps, content, fileList);
        return;
      }

      const id = `msg-${crypto.randomUUID()}`;
      void (async () => {
        const attachments = files?.length ? await Promise.all(files.map(toAttachment)) : undefined;
        const message: Message = {
          id,
          senderId: currentUser.id,
          content,
          timestamp: new Date(),
          status: 'sending',
          attachments,
        };
        setConversations((prev) => appendMessageToConversation(prev, convId, message));

        try {
          const session = await getMlsSession(convId);
          await session.send(content || '(attachment)');
          patchMessage(convId, id, { status: 'sent', encrypted: true });
          setTimeout(() => patchMessage(convId, id, { status: 'delivered' }), 1000);
          setTimeout(() => patchMessage(convId, id, { status: 'read' }), 2500);
        } catch {
          patchMessage(convId, id, { status: 'failed' });
        }
      })();
    },
    [isLive, liveGroups, messagingDeps, patchMessage, selectedId, sendLive, setConversations],
  );
}
