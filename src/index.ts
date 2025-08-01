#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';

import { GoogleMapsService } from './services/googleMapsService.js';
import { RestaurantRecommendationService } from './services/restaurantRecommendationService.js';
import { BookingService } from './services/bookingService.js';
import { RestaurantSearchParams, BookingRequest } from './types/index.js';

// Load environment variables
dotenv.config();

// Default coordinates for Taiwan
const DEFAULT_LATITUDE = parseFloat(
  process.env.DEFAULT_LATITUDE || '24.1501164'
);
const DEFAULT_LONGITUDE = parseFloat(
  process.env.DEFAULT_LONGITUDE || '120.6692299'
);
const DEFAULT_SEARCH_RADIUS = parseInt(
  process.env.DEFAULT_SEARCH_RADIUS || '3000'
); // 3km in meters
const PORT = parseInt(process.env.PORT || '3000');

class RestaurantBookingServer {
  private googleMapsService: GoogleMapsService;
  private recommendationService: RestaurantRecommendationService;
  private bookingService: BookingService;

  constructor() {
    // Initialize services
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_MAPS_API_KEY environment variable is required');
    }

    this.googleMapsService = new GoogleMapsService(apiKey);
    this.recommendationService = new RestaurantRecommendationService();
    this.bookingService = new BookingService();
  }

  private createServer(): McpServer {
    const server = new McpServer({
      name: 'restaurant-booking-server',
      version: '1.0.0',
    });

    this.setupTools(server);
    return server;
  }

  private setupTools(server: McpServer) {
    // Search restaurants tool
    server.registerTool(
      'search_restaurants',
      {
        title: 'Search for restaurants',
        description:
          'Search for restaurants based on location, cuisine, keyword, mood, event, radius, price level, and locale',
        inputSchema: {
          latitude: z
            .number()
            .optional()
            .describe(
              `Latitude of the search location (default: ${DEFAULT_LATITUDE} - Taiwan)`
            ),
          longitude: z
            .number()
            .optional()
            .describe(
              `Longitude of the search location (default: ${DEFAULT_LONGITUDE} - Taiwan)`
            ),
          placeName: z
            .string()
            .optional()
            .describe(
              'Place name to search near (e.g., "New York", "Tokyo", "London"). Alternative to providing latitude/longitude coordinates.'
            ),
          cuisineTypes: z
            .array(z.string())
            .optional()
            .describe(
              'Array of preferred cuisine types (e.g., ["Italian", "Japanese", "Mexican"])'
            ),
          keyword: z
            .string()
            .optional()
            .describe(
              'Search for specific food types or dishes (e.g., "hotpot", "sushi", "pizza", "ramen", "dim sum", "barbecue")'
            ),
          mood: z
            .string()
            .describe(
              'Desired mood/atmosphere (e.g., "romantic", "casual", "upscale", "fun", "quiet")'
            ),
          event: z
            .string()
            .describe(
              "Type of event or occasion (e.g., 'dating', 'gathering', 'business', 'casual', 'celebration')"
            ),
          radius: z
            .number()
            .optional()
            .describe(
              `Search radius in meters (default: ${DEFAULT_SEARCH_RADIUS} = ${DEFAULT_SEARCH_RADIUS / 1000}km)`
            ),
          priceLevel: z
            .number()
            .min(1)
            .max(4)
            .optional()
            .describe(
              'Price level preference (1=inexpensive, 4=very expensive)'
            ),
          locale: z
            .string()
            .optional()
            .describe(
              'Locale for search results and Google API responses (e.g., "en" for English, "zh-TW" for Traditional Chinese, "ja" for Japanese, "ko" for Korean, "th" for Thai). Affects restaurant names, reviews, and other text content.'
            ),
        },
      },
      async args => {
        return await this.handleSearchRestaurants(args);
      }
    );

    // Get restaurant details tool
    server.registerTool(
      'get_restaurant_details',
      {
        title: 'Get detailed restaurant information',
        description: 'Get comprehensive details about a specific restaurant using its place ID',
        inputSchema: {
          placeId: z
            .string()
            .describe('Google Places place ID of the restaurant'),
          locale: z
            .string()
            .optional()
            .describe(
              'Locale for the response (e.g., "en" for English, "zh-TW" for Traditional Chinese)'
            ),
        },
      },
      async args => {
        return await this.handleGetRestaurantDetails(args);
      }
    );

    // Get booking instructions tool
    server.registerTool(
      'get_booking_instructions',
      {
        title: 'Get booking instructions for a restaurant',
        description: 'Get detailed instructions on how to make a reservation at a specific restaurant',
        inputSchema: {
          placeId: z
            .string()
            .describe('Google Places place ID of the restaurant'),
          locale: z
            .string()
            .optional()
            .describe(
              'Locale for the response (e.g., "en" for English, "zh-TW" for Traditional Chinese)'
            ),
        },
      },
      async args => {
        return await this.handleGetBookingInstructions(args);
      }
    );

    // Check availability tool
    server.registerTool(
      'check_availability',
      {
        title: 'Check restaurant availability',
        description: 'Check if a restaurant has availability for a specific date, time, and party size',
        inputSchema: {
          placeId: z
            .string()
            .describe('Google Places place ID of the restaurant'),
          dateTime: z
            .string()
            .describe('Desired reservation date and time in ISO format (e.g., "2024-01-15T19:00:00")'),
          partySize: z
            .number()
            .min(1)
            .max(20)
            .describe('Number of people in the party (1-20)'),
        },
      },
      async args => {
        return await this.handleCheckAvailability(args);
      }
    );

    // Make reservation tool
    server.registerTool(
      'make_reservation',
      {
        title: 'Make a restaurant reservation',
        description: 'Attempt to make a reservation at a restaurant',
        inputSchema: {
          placeId: z
            .string()
            .describe('Google Places place ID of the restaurant'),
          dateTime: z
            .string()
            .describe('Desired reservation date and time in ISO format (e.g., "2024-01-15T19:00:00")'),
          partySize: z
            .number()
            .min(1)
            .max(20)
            .describe('Number of people in the party (1-20)'),
          contactName: z
            .string()
            .describe('Name for the reservation'),
          contactPhone: z
            .string()
            .describe('Phone number for the reservation'),
          specialRequests: z
            .string()
            .optional()
            .describe('Any special requests or notes for the reservation'),
        },
      },
      async args => {
        return await this.handleMakeReservation(args);
      }
    );
  }

  private async handleSearchRestaurants(args: any) {
    const searchParams: RestaurantSearchParams = {
      // Only include location if placeName is not provided
      ...(args.placeName
        ? { placeName: args.placeName }
        : {
            location: {
              latitude: args.latitude || DEFAULT_LATITUDE,
              longitude: args.longitude || DEFAULT_LONGITUDE,
            },
          }),
      cuisineTypes: args.cuisineTypes || [],
      keyword: args.keyword,
      mood: args.mood,
      event: args.event,
      radius: args.radius || DEFAULT_SEARCH_RADIUS,
      priceLevel: args.priceLevel,
      locale: args.locale || 'en',
    };

    // Search for restaurants
    const restaurants =
      await this.googleMapsService.searchRestaurants(searchParams);

    if (restaurants.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No restaurants found matching your criteria. Try expanding your search radius or adjusting your preferences.',
          },
        ],
      };
    }

    // Get AI recommendations
    const recommendations = await this.recommendationService.getRecommendations(
      restaurants,
      searchParams
    );

    const result = {
      searchCriteria: searchParams,
      totalFound: restaurants.length,
      recommendations: recommendations.map(rec => ({
        restaurant: {
          placeId: rec.restaurant.placeId,
          name: rec.restaurant.name,
          address: rec.restaurant.address,
          rating: rec.restaurant.rating,
          userRatingsTotal: rec.restaurant.userRatingsTotal,
          priceLevel: rec.restaurant.priceLevel,
          cuisineTypes: rec.restaurant.cuisineTypes,
          phoneNumber: rec.restaurant.phoneNumber,
          website: rec.restaurant.website,
          googleMapsUrl: rec.restaurant.googleMapsUrl,
          openingHours: rec.restaurant.openingHours,
          distance: rec.restaurant.distance,
          bookingInfo: rec.restaurant.bookingInfo,
          reservable: rec.restaurant.reservable,
          curbsidePickup: rec.restaurant.curbsidePickup,
          delivery: rec.restaurant.delivery,
          dineIn: rec.restaurant.dineIn,
          takeout: rec.restaurant.takeout,
          servesBreakfast: rec.restaurant.servesBreakfast,
          servesLunch: rec.restaurant.servesLunch,
          servesDinner: rec.restaurant.servesDinner,
          servesBrunch: rec.restaurant.servesBrunch,
          servesBeer: rec.restaurant.servesBeer,
          servesWine: rec.restaurant.servesWine,
          servesVegetarianFood: rec.restaurant.servesVegetarianFood,
        },
        score: Math.round(rec.score * 10) / 10,
        reasoning: rec.reasoning,
        suitabilityForEvent: rec.suitabilityForEvent,
        moodMatch: rec.moodMatch,
      })),
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleGetRestaurantDetails(args: any) {
    try {
      const restaurant = await this.googleMapsService.getRestaurantDetails(
        args.placeId,
        args.locale || 'en'
      );

      if (!restaurant) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Restaurant not found or unable to retrieve details.',
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(restaurant, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error('Error getting restaurant details:', error);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error retrieving restaurant details: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
      };
    }
  }

  private async handleGetBookingInstructions(args: any) {
    try {
      // First get the restaurant details
      const restaurant = await this.googleMapsService.getRestaurantDetails(
        args.placeId,
        args.locale || 'en'
      );

      if (!restaurant) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Restaurant not found or unable to retrieve details.',
            },
          ],
        };
      }

      // Get booking instructions
      const instructions = await this.bookingService.getBookingInstructions(restaurant);

      return {
        content: [
          {
            type: 'text' as const,
            text: instructions,
          },
        ],
      };
    } catch (error) {
      console.error('Error getting booking instructions:', error);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error retrieving booking instructions: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
      };
    }
  }

  private async handleCheckAvailability(args: any) {
    try {
      // First get the restaurant details
      const restaurant = await this.googleMapsService.getRestaurantDetails(
        args.placeId,
        'en'
      );

      if (!restaurant) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Restaurant not found or unable to retrieve details.',
            },
          ],
        };
      }

      // Check availability
      const availability = await this.bookingService.checkAvailability(
        restaurant,
        args.dateTime,
        args.partySize
      );

      const result = {
        restaurant: {
          name: restaurant.name,
          placeId: restaurant.placeId,
        },
        requestedDateTime: args.dateTime,
        partySize: args.partySize,
        availability,
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error('Error checking availability:', error);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error checking availability: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
      };
    }
  }

  private async handleMakeReservation(args: any) {
    try {
      // First get the restaurant details
      const restaurant = await this.googleMapsService.getRestaurantDetails(
        args.placeId,
        'en'
      );

      if (!restaurant) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Restaurant not found or unable to retrieve details.',
            },
          ],
        };
      }

      // Create booking request
      const bookingRequest: BookingRequest = {
        restaurant,
        preferredDateTime: args.dateTime,
        partySize: args.partySize,
        contactInfo: {
          name: args.contactName,
          phone: args.contactPhone,
        },
        specialRequests: args.specialRequests,
      };

      // Attempt to make reservation
      const bookingResponse = await this.bookingService.makeReservation(bookingRequest);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(bookingResponse, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error('Error making reservation:', error);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error making reservation: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
      };
    }
  }

  async run() {
    const app = express();
    app.use(express.json());

    // Map to store transports by session ID for stateful connections
    const transports: { [sessionId: string]: StreamableHTTPServerTransport } =
      {};

    // Health check endpoint
    app.get('/health', (req, res) => {
      res.json({ status: 'ok', service: 'restaurant-booking-mcp-server' });
    });

    // Handle POST requests for client-to-server communication
    app.post('/mcp', async (req, res) => {
      try {
        // Check for existing session ID
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport;
        let server: McpServer;

        if (sessionId && transports[sessionId]) {
          // Reuse existing transport
          transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
          // New initialization request
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: sessionId => {
              // Store the transport by session ID
              transports[sessionId] = transport;
            },
          });

          // Clean up transport when closed
          transport.onclose = () => {
            if (transport.sessionId) {
              delete transports[transport.sessionId];
            }
          };

          // Create new server instance
          server = this.createServer();

          // Connect to the MCP server
          await server.connect(transport);
        } else {
          // Invalid request
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: No valid session ID provided',
            },
            id: null,
          });
          return;
        }

        // Handle the request
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error',
            },
            id: null,
          });
        }
      }
    });

    // Reusable handler for GET and DELETE requests
    const handleSessionRequest = async (
      req: express.Request,
      res: express.Response
    ) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }

      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    };

    // Handle GET requests for server-to-client notifications via SSE
    app.get('/mcp', handleSessionRequest);

    // Handle DELETE requests for session termination
    app.delete('/mcp', handleSessionRequest);

    // Start the server
    app.listen(PORT, '0.0.0.0', () => {
      console.log(
        `Restaurant Booking MCP Server running on http://0.0.0.0:${PORT}`
      );
      console.log(`Health check available at http://0.0.0.0:${PORT}/health`);
      console.log(`MCP endpoint available at http://0.0.0.0:${PORT}/mcp`);
    });
  }
}

// Start the server
const server = new RestaurantBookingServer();
server.run().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

// Handle server shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  process.exit(0);
});
