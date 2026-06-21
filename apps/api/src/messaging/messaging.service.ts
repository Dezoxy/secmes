import { Injectable } from '@nestjs/common';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { PushService } from '../push/push.service.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { ConversationService } from './conversation.service.js';
import { MessageDeliveryService } from './message-delivery.service.js';
import { MessageHistoryService } from './message-history.service.js';
import { WelcomeService } from './welcome.service.js';
import type {
  CommitBody,
  DeliverWelcome,
  ListCommitsQuery,
  ListMessagesQuery,
  RecordReceipt,
  SendMessage,
  SyncQuery,
} from './messaging.schemas.js';
import type {
  CommitResult,
  ConversationReceipt,
  CreatedConversation,
  FetchedCommit,
  MessagePage,
  PendingWelcome,
  SentMessage,
  SyncPage,
  WelcomeMaterial,
} from './messaging.types.js';

// Re-export the return-type interfaces so existing imports from this module keep resolving after the
// Track-1 split (realtime-bus.ts → FetchedMessage, messaging.controller.ts → FetchedCommit, etc.).
export type {
  CommitResult,
  ConversationReceipt,
  CreatedConversation,
  FetchedCommit,
  FetchedMessage,
  MessagePage,
  PendingWelcome,
  SentMessage,
  SyncedMessage,
  SyncPage,
  WelcomeMaterial,
} from './messaging.types.js';

/**
 * Façade over the messaging domain — the single public entry point the controllers and the realtime
 * gateway inject. Its method surface is unchanged; each call delegates to one of four focused
 * collaborators (conversation lifecycle, MLS welcomes, message/commit delivery, history/receipts).
 *
 * The collaborators are internal implementation details with no independent lifecycle and need only the
 * `(bus, push)` this façade already holds, so they're constructed here rather than registered as DI
 * providers. That keeps the public DI surface and the contract spec (`messaging.service.spec.ts`)
 * byte-for-byte unchanged — the whole point of this zero-behavior-change refactor.
 */
@Injectable()
export class MessagingService {
  private readonly conversation: ConversationService;
  private readonly welcome: WelcomeService;
  private readonly delivery: MessageDeliveryService;
  private readonly history: MessageHistoryService;

  constructor(bus: RealtimeBus, push: PushService) {
    this.conversation = new ConversationService();
    this.welcome = new WelcomeService(bus);
    this.delivery = new MessageDeliveryService(bus, push);
    this.history = new MessageHistoryService(bus);
  }

  // --- conversation lifecycle + membership ---

  isMember(auth: VerifiedAuth, conversationId: string): Promise<boolean> {
    return this.conversation.isMember(auth, conversationId);
  }

  createConversation(
    auth: VerifiedAuth,
    memberUserIds: string[],
    isDirect: boolean,
  ): Promise<CreatedConversation> {
    return this.conversation.createConversation(auth, memberUserIds, isDirect);
  }

  getConversationMembers(
    auth: VerifiedAuth,
    conversationId: string,
  ): Promise<
    Array<{
      userId: string;
      argusId: string;
      displayName: string | null;
      avatarSeed: string | null;
    }>
  > {
    return this.conversation.getConversationMembers(auth, conversationId);
  }

  // --- MLS welcomes ---

  deliverWelcome(
    auth: VerifiedAuth,
    conversationId: string,
    body: DeliverWelcome,
  ): Promise<{ welcomeId: string }> {
    return this.welcome.deliverWelcome(auth, conversationId, body);
  }

  listMyWelcomes(auth: VerifiedAuth, deviceId: string, limit = 50): Promise<PendingWelcome[]> {
    return this.welcome.listMyWelcomes(auth, deviceId, limit);
  }

  getWelcomeMaterial(
    auth: VerifiedAuth,
    welcomeId: string,
    deviceId: string,
    proof: string,
  ): Promise<WelcomeMaterial> {
    return this.welcome.getWelcomeMaterial(auth, welcomeId, deviceId, proof);
  }

  consumeWelcome(
    auth: VerifiedAuth,
    welcomeId: string,
    deviceId: string,
    proof: string,
  ): Promise<void> {
    return this.welcome.consumeWelcome(auth, welcomeId, deviceId, proof);
  }

  // --- message + commit delivery ---

  sendMessage(auth: VerifiedAuth, conversationId: string, body: SendMessage): Promise<SentMessage> {
    return this.delivery.sendMessage(auth, conversationId, body);
  }

  postCommit(auth: VerifiedAuth, conversationId: string, body: CommitBody): Promise<CommitResult> {
    return this.delivery.postCommit(auth, conversationId, body);
  }

  listCommits(
    auth: VerifiedAuth,
    conversationId: string,
    query: ListCommitsQuery,
  ): Promise<FetchedCommit[]> {
    return this.delivery.listCommits(auth, conversationId, query);
  }

  // --- history, sync + receipts ---

  listMessages(
    auth: VerifiedAuth,
    conversationId: string,
    query: ListMessagesQuery,
  ): Promise<MessagePage> {
    return this.history.listMessages(auth, conversationId, query);
  }

  syncMessages(auth: VerifiedAuth, query: SyncQuery): Promise<SyncPage> {
    return this.history.syncMessages(auth, query);
  }

  recordReceipt(auth: VerifiedAuth, conversationId: string, body: RecordReceipt): Promise<void> {
    return this.history.recordReceipt(auth, conversationId, body);
  }

  getReceipts(auth: VerifiedAuth, conversationId: string): Promise<ConversationReceipt[]> {
    return this.history.getReceipts(auth, conversationId);
  }
}
