# Azure OpenAI Client Implementation Guide

This document provides guidelines for implementing Azure OpenAI in Node.js applications using the recommended approach with the official OpenAI Node.js SDK.

## Migration from @azure/openai to openai SDK

The Azure team now recommends using the official OpenAI SDK with Azure-specific configurations rather than the previous Azure-specific client. This approach provides better compatibility with OpenAI features and faster access to new capabilities.

## Installation

```bash
npm install openai @azure/identity
```

## Basic Implementation - API Key Authentication

```typescript
import OpenAI from 'openai';

// Initialize the client
const openAiClient = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_SERVICE_KEY,
  baseURL: `${process.env.AZURE_OPENAI_SERVICE_ENDPOINT}/openai/deployments`,
  defaultQuery: { "api-version": "2023-05-15" },
  defaultHeaders: { "api-key": process.env.AZURE_OPENAI_SERVICE_KEY }
});

// Make a request
async function generateCompletion() {
  const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_NAME;
  
  const response = await openAiClient.chat.completions.create({
    model: deploymentName,
    messages: [
      { role: "system" as const, content: "You are a helpful assistant." },
      { role: "user" as const, content: "Tell me about Azure OpenAI." }
    ],
  });
  
  console.log(response.choices[0].message.content);
}
```

## Advanced Implementation - Microsoft Entra ID Authentication

For enhanced security in production environments, use Microsoft Entra ID (formerly Azure AD) authentication:

```typescript
import OpenAI from 'openai';
import { DefaultAzureCredential } from "@azure/identity";

async function createOpenAiClient() {
  const openAiServiceEndpoint = process.env.AZURE_OPENAI_SERVICE_ENDPOINT || "";
  const credential = new DefaultAzureCredential();
  
  // Get an access token from Azure AD
  const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
  
  // Initialize the client with Azure AD authentication
  const openAiClient = new OpenAI({
    apiKey: "dummy", // Not used with Azure AD auth
    baseURL: `${openAiServiceEndpoint}/openai/deployments`,
    defaultQuery: { "api-version": "2023-05-15" },
    defaultHeaders: { 
      "Authorization": `Bearer ${token.token}`
    }
  });
  
  return openAiClient;
}

// Make a request with the authenticated client
async function generateCompletion() {
  const client = await createOpenAiClient();
  const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_NAME;
  
  const response = await client.chat.completions.create({
    model: deploymentName,
    messages: [
      { role: "system" as const, content: "You are a helpful assistant." },
      { role: "user" as const, content: "Tell me about Azure OpenAI." }
    ],
  });
  
  console.log(response.choices[0].message.content);
}
```

## Key API Methods

| Task | Method |
|------|--------|
| Chat Completions | `openAiClient.chat.completions.create()` |
| Embeddings | `openAiClient.embeddings.create()` |
| Images | `openAiClient.images.generate()` |
| Audio Transcription | `openAiClient.audio.transcriptions.create()` |

## API Versions

The latest API version is specified in the `defaultQuery` parameter when creating the client:

```typescript
defaultQuery: { "api-version": "2023-05-15" }
```

For Azure OpenAI Service, common API versions include:
- `2023-05-15` - Current stable version
- `2023-06-01-preview` - Preview version with additional features
- `2023-07-01-preview` - Latest preview with new capabilities

Always refer to the [Azure OpenAI Service REST API Reference](https://learn.microsoft.com/en-us/azure/ai-services/openai/reference) for the most up-to-date API versions.

## Examples for Specific Tasks

### Function Calling

```typescript
const response = await openAiClient.chat.completions.create({
  model: deploymentName,
  messages: [
    { role: "system" as const, content: "You are a helpful assistant." },
    { role: "user" as const, content: "What's the weather like in New York?" }
  ],
  functions: [
    {
      name: "get_weather",
      description: "Get the current weather in a location",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "The city and state, e.g. New York, NY",
          },
        },
        required: ["location"],
      },
    }
  ],
  function_call: "auto",
});
```

### Streaming Completions

```typescript
const stream = await openAiClient.chat.completions.create({
    model: deploymentName,
    messages: [
      { role: "system" as const, content: "You are a helpful assistant." },
      { role: "user" as const, content: "Write a long story about Azure." }
    ],
    stream: true,
  });

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

## Error Handling

Always implement proper error handling when working with Azure OpenAI:

```typescript
try {
  const response = await openAiClient.chat.completions.create({
    model: deploymentName,
    messages: [{ role: "user" as const, content: userInput }],
  });
  
  return response.choices[0].message.content;
} catch (error) {
  console.error("Azure OpenAI API Error:", error);
  
  if (error.response) {
    console.error("Status:", error.response.status);
    console.error("Data:", error.response.data);
  }
  
  // Implement appropriate fallback behavior
  return "I'm having trouble processing your request right now.";
}
```

## Best Practices

1. **Environment Variables**: Store sensitive information like endpoint URLs and API keys in environment variables, never in code.

2. **Token Management**: For Microsoft Entra ID authentication, implement proper token caching and refresh mechanisms.

3. **Rate Limiting**: Implement retry logic with exponential backoff for rate limit errors (HTTP 429).

4. **Monitoring**: Log API usage and errors for monitoring and troubleshooting.

5. **Security**: Use Microsoft Entra ID authentication in production environments instead of API keys when possible.

6. **Cost Management**: Implement usage tracking to monitor your Azure OpenAI costs.

## Resources

- [OpenAI Node.js SDK Documentation](https://github.com/openai/openai-node)
- [Azure OpenAI Service Documentation](https://learn.microsoft.com/en-us/azure/ai-services/openai/)
- [Azure Identity Library Documentation](https://learn.microsoft.com/en-us/javascript/api/overview/azure/identity-readme?view=azure-node-latest)

## TypeScript Type Safety Best Practices

When using the OpenAI SDK with TypeScript, it's important to ensure proper type safety to avoid runtime errors. Here are some best practices:

### Message Role Type Assertions

When creating message arrays for OpenAI chat completions, use TypeScript's `as const` assertion to ensure the role property is properly typed:

```typescript
const messages = [
  { role: "system" as const, content: "You are a helpful assistant." },
  { role: "user" as const, content: "Tell me a joke." }
];
```

Without the `as const` assertion, TypeScript might infer `role` as just `string` rather than the specific literal types required by the OpenAI SDK (`"system"`, `"user"`, `"assistant"`, etc.).

### Using Type Definitions

For more complex scenarios, consider defining explicit types:

```typescript
import { ChatCompletionMessageParam } from "openai/resources";

const messages: ChatCompletionMessageParam[] = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "Tell me a joke." }
];
```

### Function Calling Type Safety

When using function calling with OpenAI, ensure proper typing for function definitions:

```typescript
const functions = [
  {
    name: "get_weather",
    description: "Get the current weather in a location",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "The city and state, e.g., San Francisco, CA"
        }
      },
      required: ["location"]
    }
  }
] as const;
```

Using these TypeScript best practices will help catch potential errors at compile time rather than runtime.
