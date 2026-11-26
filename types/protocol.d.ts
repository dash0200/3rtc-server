/**
 * Type definitions for 3RTC signaling protocol (server-side).
 * Reference: docs/PROTOCOL.md
 */

import type { WebSocket } from 'ws';

export interface SignalingSocket extends WebSocket {
  peerId: string;
  roomId: string | null;
  isAlive: boolean;
  failedJoins: number[];
  msgTokens: number;
  lastTokenRefill: number;
  /** Byte budget of this connection (ABUSE_LIMITS in signaling.js). */
  bytes: { take(n: number, at?: number): boolean };
  ip: string;
  clientIp: string;
}

export interface SignalingMessageBase {
  type: string;
  [key: string]: unknown;
}

export interface CreateRoomMessage extends SignalingMessageBase {
  type: 'create-room';
  peerId?: string;
  roomId?: string | number;
  hostToken?: string;
  seatToken?: string;
}

export interface JoinMessage extends SignalingMessageBase {
  type: 'join';
  roomId?: string | number;
  room?: string | number;
  peerId?: string;
  rejoin?: boolean;
  seatToken?: string;
  hostToken?: string;
}

export interface OfferMessage extends SignalingMessageBase {
  type: 'offer';
  targetPeerId?: string;
  offer: unknown;
}

export interface AnswerMessage extends SignalingMessageBase {
  type: 'answer';
  targetPeerId?: string;
  answer: unknown;
}

export interface IceCandidateMessage extends SignalingMessageBase {
  type: 'ice-candidate';
  targetPeerId?: string;
  candidate: unknown;
}

export interface PingMessage extends SignalingMessageBase {
  type: 'ping';
}

/** The host makes someone else in the room the host (answered with host-token to them and host to all) */
export interface TransferHostMessage extends SignalingMessageBase {
  type: 'transfer-host';
  targetPeerId: string;
}

export interface SetTopologyMessage extends SignalingMessageBase {
  type: 'set-topology';
  topology: 'mesh' | 'hub';
}

/** The host dynamically sets maximum peers allowed in the room */
export interface SetRoomSizeMessage extends SignalingMessageBase {
  type: 'set-room-size';
  maxUsers: number;
}

export interface RoomSizeChangedMessage extends SignalingMessageBase {
  type: 'room-size-changed';
  maxUsers: number;
  from?: string;
}

/** "Is room X on this server?" (answered with { type: 'room-found', roomId, exists }) */
export interface FindRoomMessage extends SignalingMessageBase {
  type: 'find-room';
  roomId: string;
  /** A circle's members are also told how many people are in it (`people` in the answer) */
  circleGrant?: string;
  circleToken?: string;
}

/** A reserved Hangout Circle on this server */
export interface CircleReservation {
  /** Hash of its PIN, 'public' without one, or 'grant' while only `pinTag` is known */
  pinHash: string;
  /** Keyed tag of the PIN hash, from a grant (see seats.js) */
  pinTag?: string;
  name?: string;
  /** When the circle was made (on any server): of two claims to a code, the earlier is the circle */
  createdAt: number;
  lastUsedAt: number;
  /** Only while its room is open (a circle that failed over here without a grant) */
  temporary?: boolean;
  /** The circle token that checks the PIN of a temporary one */
  token?: string;
}

export interface RoomInfo {
  epoch: string;
  hostPeerId: string | null;
  /** Whose room it is: who made it, or whom the owner handed it to. While the owner is away a
   *  stand-in is host; the owner gets it back on return. null: not known (brought back by a guest) */
  ownerPeerId?: string | null;
  /** Times the owner handed the room on; host tokens of an earlier generation no longer work */
  hostGen?: number;
  /** Network topology: 'mesh' (default full P2P) or 'hub' (host star relay) */
  topology?: 'mesh' | 'hub';
  /** Configured capacity of the room (max users) */
  maxUsers?: number;
}

export interface TokensResult {
  seatToken?: string;
  hostToken?: string;
}
