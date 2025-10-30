// WebSocket-based P2P Connection (Fallback)
// Simplified P2P connection using WebSocket relay through relay server

import { EventEmitter } from 'events';
import WebSocket from 'ws';

export interface P2PMessage {
  type: string;
  payload?: any;
  timestamp?: number;
}

export class P2PConnectionWS extends EventEmitter {
  private ws?: WebSocket;
  private isConnected = false;

  constructor(
    private localPeerId: string,
    private remotePeerId: string,
    _role: 'requester' | 'provider',  // Reserved for future role-based logic
    private relayServerUrl: string | WebSocket  // Accept existing WebSocket
  ) {
    super();
  }

  /**
   * Handle signal from peer (for compatibility with WebRTC version)
   */
  handleSignal(_signal: any) {
    // In WebSocket mode, signals are already handled via the relay
    // This method is for API compatibility with WebRTC version
    console.log('[P2P-WS] Signal received (WebSocket mode - ignored)');
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check if we have an existing WebSocket or need a new one
      if (this.relayServerUrl instanceof WebSocket) {
        // Use existing WebSocket connection
        this.ws = this.relayServerUrl;
        console.log('[P2P-WS] Reusing existing WebSocket connection');

        // Set up message handler for P2P messages
        this.setupMessageHandler();

        // Already connected, just set up P2P relay
        this.isConnected = true;
        console.log('[P2P-WS] Connection established via WebSocket relay');
        console.log(`[P2P-WS] Local: ${this.localPeerId}, Remote: ${this.remotePeerId}`);

        this.emit('connected');
        resolve();
      } else {
        // Create new WebSocket connection
        this.ws = new WebSocket(this.relayServerUrl);

        this.ws.on('open', async () => {
          // Register for P2P relay
          this.send({
            type: 'register_p2p',
            from: this.localPeerId,
            to: this.remotePeerId
          });

          this.isConnected = true;
          console.log('[P2P-WS] Connection established via WebSocket relay');

          // Set up message handler for new WebSocket
          this.setupMessageHandler();

          // Skip handshake for now - emit connected immediately
          // In production, would perform full cryptographic handshake
          this.emit('connected');
          resolve();
        });
      }

      // Only set up error handlers for new WebSocket
      if (!(this.relayServerUrl instanceof WebSocket)) {
        this.ws!.on('error', (error) => {
          console.error('[P2P-WS] WebSocket error:', error);
          this.emit('error', error);
          reject(error);
        });

        this.ws!.on('close', () => {
          this.isConnected = false;
          console.log('[P2P-WS] Connection closed');
          this.emit('close');
        });
      }

      // Set timeout for connection
      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('P2P connection timeout'));
        }
      }, 10000); // 10 second timeout
    });
  }

  private setupMessageHandler() {
    // Add a new message listener for P2P relay messages
    const messageHandler = (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'p2p_relay' && message.from === this.remotePeerId) {
          const p2pMessage: P2PMessage = message.payload;

          // Skip signature verification for now (in production, would verify)
          console.log('[P2P-WS] Received P2P message:', p2pMessage.type);

          // Emit the full P2P message (with type and payload)
          this.emit('data', p2pMessage);
        }
      } catch (error) {
        console.error('[P2P-WS] Error parsing message:', error);
      }
    };

    // Add the handler
    this.ws!.on('message', messageHandler);
  }

  sendP2P(data: any) {
    if (!this.isConnected || !this.ws) {
      throw new Error('P2P connection not established');
    }

    // Create message (skip signing for now)
    const message: P2PMessage = {
      type: data.type,
      payload: data.payload || data,
      timestamp: Date.now()
    };

    console.log('[P2P-WS] Sending P2P message:', message.type);

    // Send via WebSocket relay
    this.send({
      type: 'p2p_relay',
      from: this.localPeerId,
      to: this.remotePeerId,
      payload: message
    });
  }

  private send(data: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  disconnect() {
    // Don't close the WebSocket if it was passed in (shared connection)
    if (!(this.relayServerUrl instanceof WebSocket) && this.ws) {
      this.ws.close();
    }
    this.ws = undefined;
    this.isConnected = false;
  }

  isActive(): boolean {
    return this.isConnected;
  }
}