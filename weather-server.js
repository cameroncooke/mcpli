#!/usr/bin/env node

/**
 * Weather MCP Server
 * 
 * A simple MCP server that provides weather information using the free
 * Open-Meteo API (no API key required).
 * 
 * Supports:
 * - City name lookup (geocoded to coordinates)
 * - Direct latitude/longitude coordinates
 * - Current weather and forecasts
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { 
  ListToolsRequestSchema, 
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// Free geocoding service to convert city names to coordinates
async function geocodeCity(cityName) {
  try {
    const response = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=en&format=json`
    );
    const data = await response.json();
    
    if (!data.results || data.results.length === 0) {
      throw new Error(`City "${cityName}" not found`);
    }
    
    const result = data.results[0];
    return {
      latitude: result.latitude,
      longitude: result.longitude,
      name: result.name,
      country: result.country,
      admin1: result.admin1 // State/region
    };
  } catch (error) {
    throw new Error(`Geocoding failed: ${error.message}`);
  }
}

// Get weather data from Open-Meteo API
async function getWeatherData(latitude, longitude, options = {}) {
  try {
    const params = new URLSearchParams({
      latitude: latitude.toString(),
      longitude: longitude.toString(),
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m',
      timezone: 'auto',
      temperature_unit: options.units === 'fahrenheit' ? 'fahrenheit' : 'celsius',
      wind_speed_unit: 'mph',
      precipitation_unit: 'inch'
    });
    
    if (options.forecast_days) {
      params.append('daily', 'temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum');
      params.append('forecast_days', options.forecast_days.toString());
    }
    
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    const data = await response.json();
    
    if (data.error) {
      throw new Error(`Weather API error: ${data.reason}`);
    }
    
    return data;
  } catch (error) {
    throw new Error(`Weather API failed: ${error.message}`);
  }
}

// Convert weather codes to human-readable descriptions
function getWeatherDescription(code) {
  const descriptions = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with hail',
    99: 'Thunderstorm with heavy hail'
  };
  
  return descriptions[code] || `Unknown weather (code: ${code})`;
}

// Create and configure the MCP server
const server = new Server(
  {
    name: 'weather-server',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// Register the get-weather tool
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_weather',
        description: 'Get current weather information for any location',
        inputSchema: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'City name (e.g., "New York", "London, UK") or coordinates as "lat,lon"'
            },
            units: {
              type: 'string',
              description: 'Temperature units',
              enum: ['celsius', 'fahrenheit'],
              default: 'fahrenheit'
            }
          },
          required: ['location']
        }
      },
      {
        name: 'get_forecast',
        description: 'Get weather forecast for multiple days',
        inputSchema: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'City name (e.g., "New York", "London, UK") or coordinates as "lat,lon"'
            },
            days: {
              type: 'integer',
              description: 'Number of forecast days (1-16)',
              minimum: 1,
              maximum: 16,
              default: 5
            },
            units: {
              type: 'string',
              description: 'Temperature units',
              enum: ['celsius', 'fahrenheit'],
              default: 'fahrenheit'
            }
          },
          required: ['location']
        }
      }
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params ?? { name: undefined, arguments: undefined };
  
  // Zod schemas for robust parameter validation
  const GetWeatherSchema = z.object({
    location: z.string().min(1, 'location must be a non-empty string'),
    units: z.enum(['celsius', 'fahrenheit']).optional(),
  });
  const GetForecastSchema = z.object({
    location: z.string().min(1, 'location must be a non-empty string'),
    days: z
      .number({ invalid_type_error: 'days must be a number' })
      .int('days must be an integer')
      .min(1, 'days must be between 1 and 16')
      .max(16, 'days must be between 1 and 16')
      .optional(),
    units: z.enum(['celsius', 'fahrenheit']).optional(),
  });
  
  try {
    if (name === 'get_weather') {
      const parsed = GetWeatherSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Invalid arguments',
                tool: name,
                issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
      const { location, units = 'fahrenheit' } = parsed.data;
      
      let latitude, longitude, locationName;
      
      // Check if location is coordinates (lat,lon format)
      if (location.includes(',')) {
        const [lat, lon] = location.split(',').map(s => parseFloat(s.trim()));
        if (isNaN(lat) || isNaN(lon)) {
          throw new Error('Invalid coordinates format. Use "latitude,longitude" (e.g., "40.7128,-74.0060")');
        }
        latitude = lat;
        longitude = lon;
        locationName = `${latitude}, ${longitude}`;
      } else {
        // Geocode city name
        const geocoded = await geocodeCity(location);
        latitude = geocoded.latitude;
        longitude = geocoded.longitude;
        locationName = `${geocoded.name}, ${geocoded.admin1 ? geocoded.admin1 + ', ' : ''}${geocoded.country}`;
      }
      
      // Get weather data
      const weatherData = await getWeatherData(latitude, longitude, { units });
      const current = weatherData.current;
      
      const result = {
        location: locationName,
        coordinates: { latitude, longitude },
        temperature: `${Math.round(current.temperature_2m)}°${units === 'celsius' ? 'C' : 'F'}`,
        feels_like: `${Math.round(current.apparent_temperature)}°${units === 'celsius' ? 'C' : 'F'}`,
        humidity: `${current.relative_humidity_2m}%`,
        wind: `${Math.round(current.wind_speed_10m)} mph ${getWindDirection(current.wind_direction_10m)}`,
        condition: getWeatherDescription(current.weather_code),
        precipitation: `${current.precipitation}" rain`,
        timestamp: current.time
      };
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
      
    } else if (name === 'get_forecast') {
      const parsed = GetForecastSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Invalid arguments',
                tool: name,
                issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
      const { location, days = 5, units = 'fahrenheit' } = parsed.data;
      
      let latitude, longitude, locationName;
      
      // Check if location is coordinates
      if (location.includes(',')) {
        const [lat, lon] = location.split(',').map(s => parseFloat(s.trim()));
        if (isNaN(lat) || isNaN(lon)) {
          throw new Error('Invalid coordinates format. Use "latitude,longitude"');
        }
        latitude = lat;
        longitude = lon;
        locationName = `${latitude}, ${longitude}`;
      } else {
        // Geocode city name
        const geocoded = await geocodeCity(location);
        latitude = geocoded.latitude;
        longitude = geocoded.longitude;
        locationName = `${geocoded.name}, ${geocoded.admin1 ? geocoded.admin1 + ', ' : ''}${geocoded.country}`;
      }
      
      // Get forecast data
      const weatherData = await getWeatherData(latitude, longitude, { 
        units, 
        forecast_days: Math.min(Math.max(days, 1), 16) 
      });
      
      const daily = weatherData.daily;
      const forecast = daily.time.map((date, index) => ({
        date,
        high: `${Math.round(daily.temperature_2m_max[index])}°${units === 'celsius' ? 'C' : 'F'}`,
        low: `${Math.round(daily.temperature_2m_min[index])}°${units === 'celsius' ? 'C' : 'F'}`,
        condition: getWeatherDescription(daily.weather_code[index]),
        precipitation: `${daily.precipitation_sum[index]}" rain`
      }));
      
      const result = {
        location: locationName,
        coordinates: { latitude, longitude },
        forecast
      };
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
      
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
    
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: error.message,
            tool: name,
            arguments: args
          }, null, 2)
        }
      ],
      isError: true
    };
  }
});

// Helper function to convert wind direction degrees to cardinal direction
function getWindDirection(degrees) {
  const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const index = Math.round(degrees / 22.5) % 16;
  return directions[index];
}

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Weather MCP Server running...');
}

main().catch(error => {
  console.error('Server error:', error);
  process.exit(1);
});
