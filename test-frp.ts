#!/usr/bin/env ts-node
/**
 * Quick test script to verify FRP tunnel integration
 * This script:
 * 1. Starts a simple HTTP server on a random port
 * 2. Creates an FRP tunnel to that port
 * 3. Tests accessing the tunnel URL
 * 4. Cleans up
 */

import { FrpManager } from './src/services/frp-manager';
import { Logger } from './src/utils/logger';
import * as http from 'http';

async function testFrpTunnel() {
  console.log('🧪 Testing FRP Tunnel Integration\n');

  // Create logger
  const logger = new Logger('test-frp');

  // Start a simple HTTP server
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Hello from FRP tunnel test!');
  });

  // Listen on a random port
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to get server address');
  }

  const port = address.port;
  console.log(`✅ Test HTTP server started on port ${port}`);

  // Create FRP tunnel
  const frpManager = new FrpManager(logger);
  console.log('📡 Creating FRP tunnel...');

  try {
    const tunnel = await frpManager.createTunnel({ port });
    console.log(`✅ FRP tunnel created: ${tunnel.url}`);

    // Wait a bit for the tunnel to be fully ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Test accessing the tunnel
    console.log(`🔍 Testing tunnel access...`);
    const fetch = (await import('node-fetch')).default;

    try {
      const response = await fetch(tunnel.url);
      const text = await response.text();

      if (text === 'Hello from FRP tunnel test!') {
        console.log('✅ Tunnel works! Successfully accessed via FRP');
      } else {
        console.log('❌ Tunnel responded but with unexpected content:', text);
      }
    } catch (error: any) {
      console.error('❌ Failed to access tunnel:', error.message);
    }

    // Clean up
    console.log('\n🧹 Cleaning up...');
    await tunnel.close();
    console.log('✅ Tunnel closed');

    server.close();
    console.log('✅ HTTP server stopped');

    console.log('\n✨ Test complete!');
  } catch (error: any) {
    console.error('❌ Test failed:', error.message);
    server.close();
    throw error;
  }
}

testFrpTunnel().catch(console.error);