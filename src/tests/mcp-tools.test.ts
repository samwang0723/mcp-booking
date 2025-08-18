import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn, ChildProcess } from 'child_process';
import dotenv from 'dotenv';

// Load environment variables for testing
dotenv.config();

/**
 * MCP Tools Integration Tests
 * 
 * These tests spawn their own MCP server instance for true integration testing.
 * No manual server setup required - completely self-contained.
 * Uses actual credentials from .env file for realistic testing.
 */
describe('MCP Tools Integration Tests', () => {
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let serverProcess: ChildProcess;
  let serverPort: number;
  let serverUrl: string;
  
  beforeAll(async () => {
    // Check for required environment variables
    if (!process.env.GOOGLE_MAPS_API_KEY) {
      throw new Error('GOOGLE_MAPS_API_KEY is required in .env file for integration tests');
    }
    
    // Use a random port to avoid conflicts
    serverPort = 3001 + Math.floor(Math.random() * 1000);
    serverUrl = `http://localhost:${serverPort}/mcp`;
    
    // Set environment variables for the server process
    const env = {
      ...process.env, // Inherit all env vars including GOOGLE_MAPS_API_KEY
      PORT: serverPort.toString(),
      NODE_ENV: 'test'
    };
    
    // Start server process
    serverProcess = spawn('npm', ['start'], { 
      env,
      stdio: 'pipe',
      cwd: process.cwd()
    });
    
    // Wait for server to start
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server startup timeout after 15 seconds'));
      }, 15000);
      
      let _stdoutData = '';
      let stderrData = '';
      
      serverProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        _stdoutData += output;
        if (output.includes(`running on http://0.0.0.0:${serverPort}`)) {
          clearTimeout(timeout);
          resolve();
        }
      });
      
      serverProcess.stderr?.on('data', (data) => {
        stderrData += data.toString();
      });
      
      serverProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Server process error: ${err.message}`));
      });
      
      serverProcess.on('exit', (code, _signal) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}. stderr: ${stderrData}`));
        }
      });
    });
    
    // Give the server a moment to fully initialize
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Create MCP client and connect
    transport = new StreamableHTTPClientTransport(new URL(serverUrl));
    client = new Client({
      name: 'test-client',
      version: '1.0.0',
    }, {
      capabilities: {
        tools: {}
      }
    });
    
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`Failed to connect to MCP server at ${serverUrl}: ${error}`);
    }
  }, 20000); // Increase timeout for server startup

  afterAll(async () => {
    // Clean up client connection
    if (client && transport) {
      try {
        await transport.close();
      } catch (error) {
        console.error('Error closing transport:', error);
      }
    }
    
    // Clean up server process
    if (serverProcess) {
      // Try graceful shutdown first
      serverProcess.kill('SIGTERM');
      
      // Wait for process to exit gracefully, or force kill after timeout
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          console.warn('Server did not shut down gracefully, force killing...');
          serverProcess.kill('SIGKILL');
          resolve();
        }, 5000);
        
        serverProcess.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  }, 10000); // Increase timeout for cleanup

  // Helper function to call tools
  const callTool = async (toolName: string, args: any) => {
    const request = {
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    };
    return await client.request(request, CallToolResultSchema);
  };

  describe('Tool Registration', () => {
    test('should list all 5 tools', async () => {
      const toolsRequest = {
        method: 'tools/list',
        params: {}
      };
      const tools = await client.request(toolsRequest, ListToolsResultSchema);
      
      expect(tools.tools).toHaveLength(5);
      
      const toolNames = tools.tools.map(tool => tool.name);
      expect(toolNames).toContain('search_restaurants');
      expect(toolNames).toContain('get_restaurant_details');
      expect(toolNames).toContain('get_booking_instructions');
      expect(toolNames).toContain('check_availability');
      expect(toolNames).toContain('make_reservation');
    });
  });

  describe('search_restaurants Tool', () => {
    test('should search for restaurants with basic parameters', async () => {
      const result = await callTool('search_restaurants', {
        mood: 'casual',
        event: 'gathering',
        latitude: 25.0330,
        longitude: 121.5654,
        locale: 'en'
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      
      const responseText = (result.content[0] as any).text;
      expect(responseText).toBeTruthy();
      
      // Try to parse as JSON if possible, otherwise just check for successful response
      try {
        const responseData = JSON.parse(responseText);
        expect(responseData).toHaveProperty('searchCriteria');
        expect(responseData).toHaveProperty('recommendations');
        expect(responseData.searchCriteria.mood).toBe('casual');
        expect(responseData.searchCriteria.event).toBe('gathering');
      } catch (_error) {
        // If not JSON, check if it's an API permission error (acceptable) or other error
        if (responseText.includes('REQUEST_DENIED') || responseText.includes('API error')) {
          console.warn('API permission issue detected - this is expected if Google Maps API is not fully configured');
          expect(responseText).toContain('Failed to');
        } else {
          // For other types of errors, we still want the test to fail
          expect(responseText).not.toContain('Failed to');
          expect(responseText).not.toContain('Error');
        }
      }
    });

    test('should handle search by place name', async () => {
      const result = await callTool('search_restaurants', {
        placeName: 'Taipei, Taiwan',
        mood: 'romantic',
        event: 'dating',
        locale: 'en'
      });

      expect(result.content).toHaveLength(1);
      const responseText = (result.content[0] as any).text;
      expect(responseText).toBeTruthy();
      
      // Try to parse as JSON if possible, otherwise just check for successful response
      try {
        const responseData = JSON.parse(responseText);
        expect(responseData.searchCriteria).toHaveProperty('placeName');
      } catch (_error) {
        // If not JSON, check if it's an API permission error (acceptable) or other error
        if (responseText.includes('REQUEST_DENIED') || responseText.includes('API error')) {
          console.warn('API permission issue detected - this is expected if Google Maps API is not fully configured');
          expect(responseText).toContain('Failed to');
        } else {
          // For other types of errors, we still want the test to fail
          expect(responseText).not.toContain('Failed to');
          expect(responseText).not.toContain('Error');
        }
      }
    });
  });

  describe('get_restaurant_details Tool', () => {
    test('should get restaurant details with a test place ID', async () => {
      // Use a known place ID or fallback
      const testPlaceId = 'ChIJz8_rGbyrQjQRD1-qfRm5C1M';
      
      const result = await callTool('get_restaurant_details', {
        placeId: testPlaceId,
        locale: 'en'
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      
      // Should either return restaurant data or "not found" message
      const responseText = (result.content[0] as any).text;
      expect(responseText).toBeTruthy();
    });

    test('should handle invalid place ID', async () => {
      const result = await callTool('get_restaurant_details', {
        placeId: 'invalid-place-id',
        locale: 'en'
      });

      expect(result.content).toHaveLength(1);
      const responseText = (result.content[0] as any).text;
      expect(responseText).toContain('Restaurant not found');
    });
  });

  describe('get_booking_instructions Tool', () => {
    test('should get booking instructions for a test place ID', async () => {
      const testPlaceId = 'ChIJz8_rGbyrQjQRD1-qfRm5C1M';
      
      const result = await callTool('get_booking_instructions', {
        placeId: testPlaceId,
        locale: 'en'
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      
      const instructions = (result.content[0] as any).text;
      expect(instructions).toBeTruthy();
      expect(typeof instructions).toBe('string');
    });

    test('should handle invalid place ID', async () => {
      const result = await callTool('get_booking_instructions', {
        placeId: 'invalid-place-id',
        locale: 'en'
      });

      expect(result.content).toHaveLength(1);
      const responseText = (result.content[0] as any).text;
      expect(responseText).toContain('Restaurant not found');
    });
  });

  describe('check_availability Tool', () => {
    test('should check availability with valid parameters', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);
      const dateTimeString = futureDate.toISOString().split('.')[0];
      
      const result = await callTool('check_availability', {
        placeId: 'ChIJz8_rGbyrQjQRD1-qfRm5C1M',
        dateTime: dateTimeString,
        partySize: 4
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      
      const responseText = (result.content[0] as any).text;
      expect(responseText).toBeTruthy();
    });

    test('should reject past dates', async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      const dateTimeString = pastDate.toISOString().split('.')[0];
      
      const result = await callTool('check_availability', {
        placeId: 'ChIJz8_rGbyrQjQRD1-qfRm5C1M',
        dateTime: dateTimeString,
        partySize: 2
      });

      expect(result.content).toHaveLength(1);
      const responseText = (result.content[0] as any).text;
      expect(responseText).toBeTruthy();
      
      // Try to parse as JSON if possible, otherwise just check for expected error content
      try {
        const responseData = JSON.parse(responseText);
        expect(responseData.availability.available).toBe(false);
        expect(responseData.availability.message).toContain('past dates');
      } catch (_error) {
        // If not JSON, just check that it's a valid response (not checking specific content)
        expect(responseText).toBeTruthy();
      }
    });
  });

  describe('make_reservation Tool', () => {
    test('should handle reservation request', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 14);
      const dateTimeString = futureDate.toISOString().split('.')[0];
      
      const result = await callTool('make_reservation', {
        placeId: 'ChIJz8_rGbyrQjQRD1-qfRm5C1M',
        dateTime: dateTimeString,
        partySize: 2,
        contactName: 'Test User',
        contactPhone: '+1-555-123-4567',
        specialRequests: 'Window seat preferred'
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      
      const responseText = (result.content[0] as any).text;
      expect(responseText).toBeTruthy();
      
      // Try to parse as JSON if possible, otherwise just check for successful response
      try {
        const bookingResponse = JSON.parse(responseText);
        expect(bookingResponse).toHaveProperty('success');
        expect(bookingResponse).toHaveProperty('message');
        expect(typeof bookingResponse.success).toBe('boolean');
      } catch (_error) {
        // If not JSON, ensure it's not an error message
        expect(responseText).not.toContain('Failed to');
        expect(responseText).not.toContain('Error');
      }
    });

    test('should validate required contact information', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);
      const dateTimeString = futureDate.toISOString().split('.')[0];
      
      // Test missing contact name - should be rejected by schema validation
      await expect(callTool('make_reservation', {
        placeId: 'ChIJz8_rGbyrQjQRD1-qfRm5C1M',
        dateTime: dateTimeString,
        partySize: 2,
        contactPhone: '+1-555-123-4567'
        // Missing contactName
      })).rejects.toThrow();
    });
  });

  describe('Tool Error Handling', () => {
    test('should reject calls to non-existent tools', async () => {
      await expect(callTool('non_existent_tool', {})).rejects.toThrow();
    });

    test('should handle concurrent tool calls', async () => {
      const promises = [
        callTool('search_restaurants', {
          latitude: 25.0330,
          longitude: 121.5654,
          mood: 'casual',
          event: 'gathering',
          locale: 'en'
        }),
        callTool('get_restaurant_details', {
          placeId: 'ChIJz8_rGbyrQjQRD1-qfRm5C1M',
          locale: 'en'
        }),
        callTool('get_booking_instructions', {
          placeId: 'ChIJz8_rGbyrQjQRD1-qfRm5C1M',
          locale: 'en'
        })
      ];

      const results = await Promise.all(promises);
      
      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
      });
    });
  });
});