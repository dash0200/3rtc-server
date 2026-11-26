import { WebSocket } from 'ws';

const URL = 'ws://localhost:8080';
const ROOM = '54321';

console.log('Testing WebRTC Signaling Server...');

const peerA = new WebSocket(URL);
const peerB = new WebSocket(URL);

let peerAId = null;
let peerBId = null;

peerA.on('open', () => {
  console.log('[Peer A] Connected. Joining room...');
  peerA.send(JSON.stringify({ type: 'join', roomId: ROOM, peerId: 'peer-alpha' }));
});

peerA.on('message', (msg) => {
  const data = JSON.parse(msg.toString());
  console.log('[Peer A] Received:', data.type, data);
  if (data.type === 'joined') {
    peerAId = data.peerId;
  }
  if (data.type === 'peer-joined') {
    // Other peer joined, Peer A creates and sends offer
    console.log('[Peer A] Other peer joined! Sending offer...');
    peerA.send(JSON.stringify({
      type: 'offer',
      offer: { type: 'offer', sdp: 'v=0\r\no=alice 123 123 IN IP4 0.0.0.0...' }
    }));
  }
  if (data.type === 'answer') {
    console.log('[Peer A] Answer received! Sending ICE candidate...');
    peerA.send(JSON.stringify({
      type: 'ice-candidate',
      candidate: { candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 }
    }));
  }
});

peerB.on('open', () => {
  setTimeout(() => {
    console.log('[Peer B] Connected. Joining room...');
    peerB.send(JSON.stringify({ type: 'join', roomId: ROOM, peerId: 'peer-beta' }));
  }, 200);
});

peerB.on('message', (msg) => {
  const data = JSON.parse(msg.toString());
  console.log('[Peer B] Received:', data.type, data);
  if (data.type === 'joined') {
    peerBId = data.peerId;
  }
  if (data.type === 'offer') {
    console.log('[Peer B] Offer received! Sending answer...');
    peerB.send(JSON.stringify({
      type: 'answer',
      answer: { type: 'answer', sdp: 'v=0\r\no=bob 456 456 IN IP4 0.0.0.0...' }
    }));
  }
  if (data.type === 'ice-candidate') {
    console.log('[Peer B] ICE candidate received!');
    console.log('\n SUCCESS: Offer, Answer, and ICE Candidate swap verified successfully!');
    peerA.close();
    peerB.close();
    process.exit(0);
  }
});
