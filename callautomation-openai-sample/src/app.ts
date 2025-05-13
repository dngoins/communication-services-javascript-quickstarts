import { config } from 'dotenv';
import express, { Application } from 'express';
import { PhoneNumberIdentifier, createIdentifierFromRawId } from "@azure/communication-common";
import { CallAutomationClient, CallConnection, AnswerCallOptions, CallMedia, TextSource, FileSource, AnswerCallResult, CallMediaRecognizeSpeechOptions, CallMediaRecognizeDtmfOptions, CallIntelligenceOptions, PlayOptions, DtmfTone, TransferCallToParticipantOptions } from "@azure/communication-call-automation";
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

import { AzureOpenAI } from "openai";

import { DefaultAzureCredential } from "@azure/identity";
import { EmailClient } from "@azure/communication-email";
import { formatPhoneNumberForTransfer, processDtmfInput } from './utils';
import { playEnhancedTypingIndicator, stopEnhancedTypingIndicator } from './typing-indicator';
config({ override: true });

const PORT = process.env.PORT;
const MAX_SYSTEM_PROMPT_LENGTH = 7000;
const MAX_USER_PROMPT_LENGTH = 3000;
const MAX_RESPONSE_LENGTH = 10000;
const MAX_RECOGNITION_PROMPT_LENGTH = 3000;
const MAX_SPEECH_INPUT_LENGTH = 2000;

// Audio file URLs - use full URLs that are accessible to Azure Communication Services
const TYPING_INDICATOR_AUDIO_URL = process.env.TYPING_INDICATOR_AUDIO_URL ||
	`${process.env.CALLBACK_URI}/audio/Typing-on-a-keyboard.mp3`; // URL accessible to ACS
// Cache ID to optimize performance when playing the same audio repeatedly
const TYPING_INDICATOR_CACHE_ID = "typing-indicator-1";

const app: Application = express();
app.use(express.json());
app.use(express.static('public')); // Serve static files from the 'public' directory
app.use(express.static('public')); // Serve static files from the 'public' directory

let callConnectionId: string;
let callConnection: CallConnection;
let acsClient: CallAutomationClient;
let openAiClient: AzureOpenAI;
let emailClient: EmailClient;
let answerCallResult: AnswerCallResult;
let callerId: string;
let callMedia: CallMedia;
let maxTimeout = 2;
let technicalDifficultiesCount = 0; // Counter for technical difficulties

// Customer session data storage
let customerData = {
	customerName: "unknown",
	email: "unknown",
	phoneNumber: "unknown",
	calledFromNumber: "unknown", // The number the customer called from
	travelDate: "unknown",
	stayDuration: "unknown",
	activities: "unknown",
	budget: "unknown",
	alternateDestinations: "unknown",
	notes: "unknown",
	interestLevel: "unknown"
};

// Flag to track if customer data has been emailed
let emailSent = false;

const answerPromptSystemTemplate = `You are a sales agent designed to gather information from a potential customer regarding a Wellness retreat to Luxor, Egypt. Your task is to try to sell the idea of going to Luxor for Egypt's mysterious ancient history, the customer's health and peace of mind. Ask the customer questions and gather information about their needs and preferences. Find out when they want to travel, how long they want to stay, what type of activities they are interested in, and any other relevant customer contact information. Try to keep the conversation positive and engaging. Use the customer's name if you have it. If you don't have their name, ask for it. If they are not interested in Egypt, ask if they are interested in any other destinations or wellness retreats. If they are not responsive, ask them if they need assistance. Be brief and concise, and avoid using filler words. Ask a couple of questions at a time and wait for the customer's response before moving on to the next couple of questions. If the customer is not responsive, ask them if they need assistance. If they are still unresponsive, politely end the call. Have a friendly and motivating tone and use positive language.

When you need to collect their phone number, explicitly ask if they would like to use the number they're currently calling from as their contact number. If they say yes or agree in any way, tell them that you'll record their current number and they don't need to provide it.

Remember that customers can respond using their phone keypad. For yes/no questions, instruct them that they can press 1 for yes or 2 for no. When asking for a phone number, tell them they can enter it directly using their keypad followed by the # key to confirm. Remind them they can press 0 at any time to speak with a live agent.

If the sentiment is going well, ask if they have a budget in mind for the trip. Keep your responses short and concise.

You will track the customer's information in a JSON structure at the end of your response but hidden from the customer. Your response will be in two parts:
1. Your conversational response to the customer (without any JSON)
2. A JSON structure after "DATA_START" and before "DATA_END" with the following fields:

DATA_START
{
  "customerName": "",
  "email": "",
  "phoneNumber": "",
  "calledFromNumber": "",
  "travelDate": "",
  "stayDuration": "",
  "activities": "",
  "budget": "",
  "alternateDestinations": "",
  "notes": "",
  "interestLevel": ""
}
DATA_END

Update this JSON with any customer information you collect. Keep previously collected information when responding. Use "unknown" as the value when information hasn't been collected yet. For interestLevel, use: "high", "medium", "low", or "unknown".`;

const helloPrompt = "'Raw who bat', thank you for calling! Welcome to House of Royals Wellness Temple. Do you want to go to Egypt! Well, we offer wellness retreats and services in Luxor, Egypt. How may we assist you today?";
//You can, speak your answers or use your keypad. For yes/no questions, press 1 for yes, 2 for no. Interested in Egypt retreats?";
const timeoutSilencePrompt = "I'm sorry, I didn't hear anything. How can I help you?";
const goodbyePrompt = "Thank you for calling! I hope I was able to assist you. Have a great day!";
const connectAgentPrompt = "I'll transfer you to an agent who can help you further. Please hold.";
const callTransferFailurePrompt = "I can't connect you to an agent right now. The next available agent will call you back soon.";
const agentPhoneNumberEmptyPrompt = "I'm sorry, our agents are currently busy. Someone will call you back as soon as possible.";
const EndCallPhraseToConnectAgent = "Please stay on the line. I'm transferring you to an agent.";

const transferFailedContext = "TransferFailed";
const connectAgentContext = "ConnectAgent";
const goodbyeContext = "Goodbye";
const dtmfTransferContext = "DTMFTransfer";

// DTMF Options
const DTMF_TRANSFER_TO_AGENT = "0";
const DTMF_YES = "1";
const DTMF_NO = "2";

const agentPhonenumber = process.env.AGENT_PHONE_NUMBER;
const chatResponseExtractPattern = /(?<=: ).*/g;

// Array of voices to randomly select from
const voices = [
	"en-US-NancyNeural",  // Female voice
	"en-US-JennyNeural",  // Female voice
	"en-US-AriaNeural",   // Female voice
	"en-US-GuyNeural",    // Male voice
	"en-US-TonyNeural",   // Male voice
	"en-US-DavisNeural",  // Male voice
	"en-US-JasonNeural",  // Male voice
	"en-GB-SoniaNeural",  // British female voice
	"en-AU-NatashaNeural" // Australian female voice
];

// Get a random voice from the available options
function getRandomVoice(): string {
	const randomIndex = Math.floor(Math.random() * voices.length);
	const selectedVoice = voices[randomIndex];
	console.log(`Selected random voice: ${selectedVoice}`);
	return selectedVoice;
}

// Current voice for this call - will be set once per call
let currentCallVoice = getRandomVoice(); // Default voice

// Check if all required customer data is collected
function isAllRequiredDataCollected(): boolean {
	const requiredFields = ['customerName', 'email', 'travelDate', 'stayDuration'];

	for (const field of requiredFields) {
		if (customerData[field] === 'unknown' || customerData[field] === '') {
			console.log(`Missing required field: ${field} = ${customerData[field]}`);
			return false;
		}
	}

	console.log("All required fields are collected!");
	return true;
}

// Send customer data via email
async function sendCustomerDataEmail(): Promise<boolean> {
	try {
		// Make sure we have an email client
		if (!emailClient) {
			await createEmailClient();
		}

		// Format customer data for email body
		const emailBody = `
      <h1>Thank you ${customerData.customerName}</h1>
      <p>We have received your inquiry and will get back to you shortly. We are excited to help you plan your Royal Luxury Egyptian Wellness Retreat!</p>
      <p>If you have any questions, please don't hesitate to reach out, contact our <a href="mailto:moreinfo@horwt.com?subject=General Question&body=Hello,%20I%20have%20a%20question%20about..." >support team</a>.</p>
      <p>Best regards,</p>
      <p><a href="https://houseofroyalswellnesstemple.com">House of Royals Wellness Temple</a></p>
      <br/>
      <p>Here is a summary of your inquiry:</p>	  
      <hr/>
      <h2>New Customer Inquiry</h2>
      <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
      <h3>Customer Information:</h3>
      <ul>
        <li><strong>Name:</strong> ${customerData.customerName}</li>
        <li><strong>Email:</strong> ${customerData.email}</li>
        <li><strong>Phone:</strong> ${customerData.phoneNumber}</li>
        <li><strong>Preferred Travel Date:</strong> ${customerData.travelDate}</li>
        <li><strong>Stay Duration:</strong> ${customerData.stayDuration}</li>
        <li><strong>Interested Activities:</strong> ${customerData.activities}</li>
        <li><strong>Budget:</strong> ${customerData.budget}</li>
        <li><strong>Alternate Destinations:</strong> ${customerData.alternateDestinations}</li>
        <li><strong>Interest Level:</strong> ${customerData.interestLevel}</li>
        <li><strong>Notes:</strong> ${customerData.notes}</li>
      </ul>
    `;

		// Create recipient list
		const toRecipients = [{ address: process.env.TOURDL_EMAIL }];
		const ccRecipients = customerData.email !== "unknown" ? [{ address: customerData.email }] : [];

		// Create the email message
		const emailMessage = {
			senderAddress: process.env.ACS_SENDER_EMAIL, // This should be your verified domain in ACS
			content: {
				subject: `New Wellness Retreat Inquiry - ${customerData.customerName} on - ${customerData.travelDate}`,
				html: emailBody,
			},
			recipients: {
				to: toRecipients,
				cc: ccRecipients
			}
		};

		// Send the email using ACS
		const poller = await emailClient.beginSend(emailMessage);
		const result = await poller.pollUntilDone();

		console.log(`Email sent with message ID: ${result.id}`);
		return true;
	} catch (error) {
		console.error("Error sending email:", error);
		return false;
	}
}

// Send email when technical difficulties occur
async function sendTechnicalDifficultyEmail(): Promise<boolean> {
	try {
		// Make sure we have an email client
		if (!emailClient) {
			await createEmailClient();
		}

		// Format customer data for email body
		const emailBody = `
      <h2>Technical Difficulty Notification</h2>
      <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
      <p>A technical difficulty occurred during a call. Below is the information collected so far:</p>
      <h3>Customer Information:</h3>
      <ul>
        <li><strong>Called From Number:</strong> ${customerData.calledFromNumber}</li>
        <li><strong>Name:</strong> ${customerData.customerName}</li>
        <li><strong>Email:</strong> ${customerData.email}</li>
        <li><strong>Preferred Phone:</strong> ${customerData.phoneNumber}</li>
        <li><strong>Preferred Travel Date:</strong> ${customerData.travelDate}</li>
        <li><strong>Stay Duration:</strong> ${customerData.stayDuration}</li>
        <li><strong>Interested Activities:</strong> ${customerData.activities}</li>
        <li><strong>Budget:</strong> ${customerData.budget}</li>
        <li><strong>Alternate Destinations:</strong> ${customerData.alternateDestinations}</li>
        <li><strong>Interest Level:</strong> ${customerData.interestLevel}</li>
        <li><strong>Notes:</strong> ${customerData.notes}</li>
      </ul>
    `;

		// Create the email message for technical difficulty (only send to admin, not to customer)
		const emailMessage = {
			senderAddress: process.env.ACS_SENDER_EMAIL, // This should be your verified domain in ACS
			content: {
				subject: `Technical Difficulty - Call from ${customerData.calledFromNumber}`,
				html: emailBody,
			},
			recipients: {
				to: [{ address: process.env.TOURDL_EMAIL }]
			}
		};

		// Send the email using ACS
		const poller = await emailClient.beginSend(emailMessage);
		const result = await poller.pollUntilDone();

		console.log(`Technical difficulty email sent with message ID: ${result.id}`);
		return true;
	} catch (error) {
		console.error("Error sending technical difficulty email:", error);
		return false;
	}
}

async function createAcsClient() {
	const connectionString = process.env.CONNECTION_STRING || "";

	// Add client options with retry settings to handle transient failures
	const clientOptions = {
		retryOptions: {
			maxRetries: 3,
			retryDelayInMs: 800,
			maxRetryDelayInMs: 5000
		}
	};

	acsClient = new CallAutomationClient(connectionString, clientOptions);
	console.log("Initialized ACS Client with retry options.");
}

async function createOpenAiClient() {
	try {
		console.log("=== Starting Azure OpenAI Client Initialization ===");

		// Get configuration values with validation
		const endpoint = process.env.AZURE_OPENAI_SERVICE_ENDPOINT || "";
		const apiKey = process.env.AZURE_OPENAI_SERVICE_KEY || "";
		const apiVersion = process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_VERSION || "";
		const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_NAME || "";

		// Create an array to collect validation issues
		const configIssues = [];

		// Validate required configuration with more detailed feedback
		if (!endpoint) {
			configIssues.push("MISSING: AZURE_OPENAI_SERVICE_ENDPOINT is not configured in environment variables");
		} else if (!endpoint.startsWith("https://")) {
			configIssues.push(`INVALID: AZURE_OPENAI_SERVICE_ENDPOINT should start with 'https://' (current: ${endpoint})`);
		}

		if (!apiKey) {
			configIssues.push("MISSING: AZURE_OPENAI_SERVICE_KEY is not configured in environment variables");
		} else if (apiKey.length < 10) {
			configIssues.push("SUSPICIOUS: AZURE_OPENAI_SERVICE_KEY appears to be too short for a valid API key");
		}

		if (!deployment) {
			configIssues.push("MISSING: AZURE_OPENAI_DEPLOYMENT_MODEL_NAME is not configured in environment variables");
		}

		// If we have validation issues, log them and throw an error
		if (configIssues.length > 0) {
			console.error("=== Azure OpenAI Configuration Validation Failed ===");
			configIssues.forEach(issue => console.error(`- ${issue}`));
			console.error("========================================");
			throw new Error(`OpenAI client configuration issues: ${configIssues.join("; ")}`);
		}

		// Log configuration (with masked API key)
		console.log("Azure OpenAI Configuration:");
		console.log(`- Endpoint: ${endpoint}`);
		console.log(`- API Key: ${apiKey ? apiKey.substring(0, 3) + "..." + apiKey.substring(apiKey.length - 3) : "Not set"}`);
		console.log(`- Deployment: ${deployment}`);
		console.log(`- API Version: ${apiVersion || "Using SDK default"}`);

		// Add additional configuration guidance
		const modelHint = deployment.includes("gpt-4") ? "GPT-4" :
			deployment.includes("gpt-3.5") ? "GPT-3.5" :
				"Unknown model type";

		console.log(`- Model type appears to be: ${modelHint}`);

		// Create SDK options with improved error handling
		const options = {
			endpoint,
			apiKey,
			deployment,
			apiVersion,
			// Add some additional SDK options for better stability
			maxRetries: 3,
			timeout: 60000  // 60 second timeout
		};

		console.log("Initializing Azure OpenAI Client with the latest SDK...");

		// Use the modern OpenAI SDK with Azure OpenAI support
		try {
			openAiClient = new AzureOpenAI(options);
			console.log("OpenAI client instance created successfully");
		} catch (initError) {
			console.error("Failed to create OpenAI client instance:", initError);
			throw initError;
		}

		// Try to make a minimal API call to validate the connection
		try {
			console.log("Validating OpenAI connection with test request...");

			// Using a minimal system message to test connectivity with minimal tokens
			const testResponse = await openAiClient.chat.completions.create({
				model: deployment,
				messages: [{ role: "system", content: "Test connection" }],
				max_completion_tokens: 5, // Minimal response to save on tokens
				
				//temperature: 0  // Use deterministic response for testing
			});

			console.log("✓ Successfully validated OpenAI connection with test request");
			console.log(`- Model used: ${testResponse.model}`);
			console.log(`- Response tokens: ${testResponse.usage?.completion_tokens || 0}`);
			console.log(`- Total tokens used in test: ${testResponse.usage?.total_tokens || 0}`);
			console.log(`- Test response content: "${testResponse.choices[0]?.message?.content || 'No content'}"`);

			// Check if the model matches what we expect
			if (testResponse.model && !testResponse.model.includes(deployment.toLowerCase())) {
				console.warn(`WARNING: The model returned (${testResponse.model}) doesn't match the configured deployment (${deployment})`);
				console.warn("This might indicate that your deployment is configured for a different model than expected");
				console.warn("Check your Azure OpenAI Studio settings for this deployment");
			}
		} catch (testError) {
			console.warn("⚠ Warning: Could not validate OpenAI connection with test request");
			console.warn("Error details:", testError.message);
			console.warn("The OpenAI client was initialized, but connectivity couldn't be confirmed");

			// Check for common error types and provide more specific guidance
			if (testError.message && testError.message.toLowerCase().includes("authentication")) {
				console.error("DIAGNOSIS: This appears to be an authentication error.");
				console.error("CHECK THESE ITEMS:");
				console.error("1. Verify your AZURE_OPENAI_SERVICE_KEY is correct");
				console.error("2. Make sure the key has permission to access the deployment");
				console.error("3. Check if the key has expired or been rotated");
			} else if (testError.message && (testError.message.includes("not found") || testError.message.includes("does not exist"))) {
				console.error("DIAGNOSIS: This appears to be a deployment name error.");
				console.error("CHECK THESE ITEMS:");
				console.error("1. Verify your AZURE_OPENAI_DEPLOYMENT_MODEL_NAME matches exactly what's in Azure OpenAI Studio");
				console.error("2. Check for typos or case sensitivity issues in the deployment name");
				console.error("3. Ensure the deployment has been successfully created and is active");
			} else if (testError.message && testError.message.includes("endpoint")) {
				console.error("DIAGNOSIS: This appears to be an endpoint error.");
				console.error("CHECK THESE ITEMS:");
				console.error("1. Verify your AZURE_OPENAI_SERVICE_ENDPOINT URL is correct");
				console.error("2. Ensure the URL format follows: https://YOUR-RESOURCE-NAME.openai.azure.com/");
				console.error("3. Check network connectivity to this endpoint");
			} else if (testError.message && testError.message.includes("quota")) {
				console.error("DIAGNOSIS: This appears to be a quota or rate limit error.");
				console.error("CHECK THESE ITEMS:");
				console.error("1. Verify your Azure subscription has quota available for this model");
				console.error("2. Consider reducing your requests per minute or adjusting your retry policy");
				console.error("3. Check if you need to request a quota increase in the Azure portal");
			}

			// Log the error in more detail for troubleshooting
			if (testError.status) console.error(`- Error status: ${testError.status}`);
			if (testError.code) console.error(`- Error code: ${testError.code}`);
			if (testError.type) console.error(`- Error type: ${testError.type}`);

			// Don't throw here - allow the application to continue even if the test fails
			// The real error will be caught during actual usage if there's a configuration issue
		}

		console.log("=== Azure OpenAI Client Initialization Complete ===");
	} catch (error) {
		console.error("CRITICAL ERROR: Failed to initialize Azure OpenAI client:", error.message);

		// Add troubleshooting guidance
		console.error("\nTROUBLESHOOTING STEPS:");
		console.error("1. Check your .env file for correct Azure OpenAI configuration");
		console.error("2. Verify your Azure OpenAI resource is properly deployed");
		console.error("3. Ensure your deployment is active and properly configured");
		console.error("4. Check network connectivity to the Azure OpenAI endpoint");
		console.error("5. Verify API keys and permissions\n");

		throw error; // Re-throw to be handled by the Promise.all catch
	}
}

async function createEmailClient() {
	// Use the same connection string as the ACS client for simplicity
	const connectionString = process.env.CONNECTION_STRING || "";

	// Add client options with retry settings to handle transient failures
	const clientOptions = {
		retryOptions: {
			maxRetries: 3,
			retryDelayInMs: 800,
			maxRetryDelayInMs: 5000
		}
	};

	emailClient = new EmailClient(connectionString, clientOptions);
	console.log("Initialized ACS Email Client with retry options.");
}

async function hangUpCall() {
	try {
		await callConnection.hangUp(true);
		console.log("Call hung up successfully");
	} catch (error) {
		console.error("Error hanging up call:", error);
	}
}

async function startRecognizing(callMedia: CallMedia, callerId: string, message: string, context: string) {
	try {
		// Add DTMF instructions to message if needed
		let messageWithDtmfInstructions = message;
		if (context !== connectAgentContext && context !== goodbyeContext && context !== transferFailedContext && context !== dtmfTransferContext) {
			messageWithDtmfInstructions = addDtmfInstructions(message);
		}

		// Check if the message exceeds the limit for direct prompts (700 chars is safer for recognition prompts)

		let recognizeOptions: CallMediaRecognizeSpeechOptions;

		if (messageWithDtmfInstructions.length > MAX_RECOGNITION_PROMPT_LENGTH) {
			console.log(`Recognition prompt too long (${messageWithDtmfInstructions.length} chars). Splitting into chunks.`);

			// Play the message first in chunks, then start recognition separately
			await handlePlay(callMedia, messageWithDtmfInstructions, "PreRecognitionPlay");

			// Start recognition with a minimal prompt
			const shortPrompt: TextSource = {
				text: "I'm listening.",
				voiceName: currentCallVoice,
				kind: "textSource"
			};

			recognizeOptions = {
				endSilenceTimeoutInSeconds: 2,
				playPrompt: shortPrompt,
				initialSilenceTimeoutInSeconds: 21,
				interruptPrompt: true,
				operationContext: context,
				kind: "callMediaRecognizeSpeechOptions",
			};
		} else {
			// Original flow for messages under the limit
			const play: TextSource = {
				text: messageWithDtmfInstructions,
				voiceName: currentCallVoice,
				kind: "textSource"
			};

			recognizeOptions = {
				endSilenceTimeoutInSeconds: 2,
				playPrompt: play,
				initialSilenceTimeoutInSeconds: 21,
				interruptPrompt: true,
				operationContext: context,
				kind: "callMediaRecognizeSpeechOptions",
			};
		}

		const dtmfOptions: CallMediaRecognizeDtmfOptions = {
			maxTonesToCollect: 20,
			interToneTimeoutInSeconds: 5,
			stopDtmfTones: [DtmfTone.Pound],
			operationContext: context,
			kind: "callMediaRecognizeDtmfOptions",
		};

		const targetParticipant = createIdentifierFromRawId(callerId);
		// Start both speech and DTMF recognition
		await Promise.all([
			callMedia.startRecognizing(targetParticipant, recognizeOptions),
			callMedia.startRecognizing(targetParticipant, dtmfOptions)
		]);
		console.log(`Started speech and DTMF recognizing with context: ${context}`);
	}
	catch (error) {
		console.error(`Error in startRecognizing: ${error}`);
		technicalDifficultiesCount++; // Increment the technical difficulties counter
		console.log(`Technical difficulties count: ${technicalDifficultiesCount}`);

		// If this is the third technical difficulty, end the call
		if (technicalDifficultiesCount >= 10) {
			try {
				if (callMedia) {
					// Create a helpful message with their contact information
					let contactInfo = "";
					if (customerData.phoneNumber !== "unknown") {
						contactInfo = `your phone number (${customerData.phoneNumber})`;
					} else if (customerData.calledFromNumber !== "unknown") {
						contactInfo = `the number you called from (${customerData.calledFromNumber})`;
					} else if (customerData.email !== "unknown") {
						contactInfo = `your email (${customerData.email})`;
					} else {
						contactInfo = "your contact information once you provide it";
					}

					// Play the goodbye message
					const finalMessage: TextSource = {
						text: `We seem to be experiencing ongoing technical difficulties. I'm sorry for the inconvenience. Someone from our team will reach out to you at ${contactInfo} shortly to assist with your Egypt travel plans. Thank you for your patience.`,
						voiceName: currentCallVoice,
						kind: "textSource"
					};

					// Use a promise with a timeout to ensure the call gets hung up even if playToAll fails
					// try {
					// 	await Promise.race([
					// 		callMedia.playToAll([finalMessage]),
					// 		new Promise((_, reject) => setTimeout(() => reject(new Error("Play timeout")), 10000))
					// 	]);
					// } catch (playError) {
					// 	console.error(`Error playing final message: ${playError}`);
					// }

					// Send email with current data
					if (!emailSent) {
						console.log("Sending technical difficulty email before ending call...");
						await sendTechnicalDifficultyEmail().catch(err => console.error("Error sending technical difficulty email:", err));
					}

					// End the call after a short delay to allow the message to be heard
					setTimeout(async () => {
						await hangUpCall().catch(err => console.error("Error hanging up call after technical difficulties:", err));
					}, 8000);

					return;
				} else {
					// If callMedia is not available, just hang up directly
					await hangUpCall().catch(err => console.error("Error hanging up call with no callMedia:", err));
					return;
				}
			} catch (endCallError) {
				console.error(`Error ending call after multiple technical difficulties: ${endCallError}`);
				// Try to hang up anyway if we caught another error
				await hangUpCall().catch(err => console.error("Error in final hang up attempt:", err));
				return;
			}
		}

		// If this fails, we should try to handle the call gracefully
		try {
			if (callMedia) {
				// Try to play an error message but continue from where we left off
				const errorPlay: TextSource = {
					text: "I'm sorry, we're experiencing technical difficulties. Let's continue from where we left off.",
					voiceName: currentCallVoice,
					kind: "textSource"
				};

				// Use a promise with a timeout to ensure we don't get stuck
				try {
					await Promise.race([
						callMedia.playToAll([errorPlay]),
						new Promise((_, reject) => setTimeout(() => reject(new Error("Play timeout")), 5000))
					]);
				} catch (playError) {
					console.error(`Error playing error message: ${playError}`);
				}

				// Send email with current data if there are technical difficulties
				if (!emailSent) {
					console.log("Sending technical difficulty email with current data...");
					await sendTechnicalDifficultyEmail();
				}

				// Create a continuation message based on collected data
				let continuationMessage = "";
				if (customerData.customerName !== "unknown") {
					// If we have customer's name, use a personalized continuation
					continuationMessage = generateContinuationPrompt(customerData);
				} else {
					// If we don't have any meaningful data yet, restart with the hello prompt
					continuationMessage = helloPrompt;
				}

				// Continue the conversation with appropriate context
				setTimeout(async () => {
					await startRecognizing(callMedia, callerId, continuationMessage, 'GetFreeFormText')
						.catch(err => {
							console.error(`Failed to continue conversation: ${err}`);
							// If we can't continue the conversation, hang up after a final message
							hangUpCall().catch(hangupErr => console.error("Error hanging up call after failing to continue:", hangupErr));
						});
				}, 3000); // Short delay before continuing
			}
		}
		catch (fallbackError) {
			console.error(`Error in fallback handling: ${fallbackError}`);

			// Try to inform the user and hang up the call if we can't continue
			try {
				if (callMedia) {
					console.log("Attempting to play error message and hang up the call due to fallback error");

					// Create a helpful message based on collected data
					let farewellMessage = "";
					if (isAllRequiredDataCollected()) {
						// Use personalized goodbye if we have all required data
						farewellMessage = createPersonalizedGoodbyeMessage();
					} else {
						// Use an apologetic message for incomplete data
						farewellMessage = "I'm sorry, but we're experiencing technical difficulties with this call. Our team will follow up with you shortly. Thank you for your patience.";
					}

					// Try to play the message
					const finalMessage: TextSource = {
						text: farewellMessage,
						voiceName: currentCallVoice,
						kind: "textSource"
					};

					// Use a promise with a timeout to ensure we don't get stuck
					try {
						await Promise.race([
							callMedia.playToAll([finalMessage]),
							new Promise((_, reject) => setTimeout(() => reject(new Error("Play timeout")), 5000))
						]);

						console.log("Successfully played farewell message, hanging up call in 5 seconds");

						// Short delay to ensure message is heard
						setTimeout(async () => {
							await hangUpCall().catch(err => console.error("Error hanging up call after fallback error:", err));
						}, 5000);
					} catch (playError) {
						console.error("Failed to play farewell message:", playError);
						// If playing message fails, try to hang up immediately
						await hangUpCall().catch(err => console.error("Error during emergency hangup:", err));
					}

					// Send email with current data if not already sent
					if (!emailSent && Object.values(customerData).some(val => val !== 'unknown' && val !== '')) {
						console.log("Sending technical difficulty email due to fallback error...");
						await sendTechnicalDifficultyEmail().catch(err =>
							console.error("Failed to send technical difficulty email:", err)
						);
					}
				} else {
					// If we don't have callMedia, just try to hang up
					console.log("No call media available, attempting direct hangup");
					await hangUpCall().catch(err => console.error("Error during emergency hangup:", err));
				}
			} catch (emergencyError) {
				console.error(`Critical error in emergency fallback handling: ${emergencyError}`);
				// Last resort - try direct hangup if everything else fails
				try {
					await hangUpCall();
				} catch (finalError) {
					console.error("All attempts to gracefully end the call have failed");
				}

				// Even if everything fails, ensure the technical difficulty email is sent
				if (!emailSent && Object.values(customerData).some(val => val !== 'unknown' && val !== '')) {
					sendTechnicalDifficultyEmail().catch(err =>
						console.error("Failed to send final technical difficulty email:", err)
					);
				}
			}
		}
	}
}

// Helper function to add DTMF instructions based on the content
function addDtmfInstructions(message: string): string {

	let updatedMessage = message;

	// Define regex patterns for better readability
	const yesNoQuestionPattern = new RegExp("would you like|are you interested|do you want|have you|are you|did you", "i");
	const phoneNumberRequestPattern = new RegExp("phone number|contact number|reach you|call you", "i");


	// Check for yes/no questions
	if (yesNoQuestionPattern.test(message)) {
		if (!message.includes("press 1 for yes") && !message.includes("press 2 for no")) {
			updatedMessage += " Press 1 for yes or 2 for no.";
		}
	}
	// Check for phone number requests
	if (phoneNumberRequestPattern.test(message) &&
		!message.includes("calling from") &&
		!message.includes("press")) {
		updatedMessage += " Enter your phone number using your keypad followed by the # key.";
	}

	// Add a shortened agent transfer option to prevent long messages
	//   if (!message.includes("press 0") && !message.includes("live agent")) {
	//     // Keep this short to avoid making the prompt too long
	//     updatedMessage += " Press 0 for agent.";
	//   }

	return updatedMessage;
}

function getSentimentScore(sentimentScore: string) {
	const pattern = /(\d)+/g;
	const match = sentimentScore.match(pattern);
	return match ? parseInt(match[0]) : -1;
}

async function handlePlay(callConnectionMedia: CallMedia, textToPlay: string, context: string) {
	try {
		// Split long messages into manageable chunks to prevent timeouts
		const messageChunks = splitLongMessage(textToPlay);

		if (messageChunks.length === 1) {
			// Single chunk - proceed normally
			const play: TextSource = { text: textToPlay, voiceName: currentCallVoice, kind: "textSource" };
			const playOptions: PlayOptions = { operationContext: context };

			// Use the safe call operation helper
			await safeCallOperation(
				() => callConnectionMedia.playToAll([play], playOptions),
				`Error in handlePlay with context ${context}`
			);
		} else {
			// Multiple chunks - play them sequentially with short pauses between
			console.log(`Message too long, splitting into ${messageChunks.length} chunks`);

			for (let i = 0; i < messageChunks.length; i++) {
				const isLastChunk = i === messageChunks.length - 1;
				const chunkContext = isLastChunk ? context : "ChunkPlay";

				const play: TextSource = {
					text: messageChunks[i],
					voiceName: currentCallVoice,
					kind: "textSource"
				};
				const playOptions: PlayOptions = { operationContext: chunkContext };

				// Use a try-catch for each chunk so one failure doesn't stop the entire sequence
				try {
					await callConnectionMedia.playToAll([play], playOptions);

					// Small pause between chunks for more natural speech
					if (!isLastChunk) {
						await new Promise(resolve => setTimeout(resolve, 500));
					}
				} catch (chunkError) {
					console.error(`Error playing chunk ${i + 1}/${messageChunks.length}: ${chunkError}`);

					// Only break the loop if it's a "Call not found" error
					if (chunkError.toString().includes("Call not found")) {
						if (!emailSent && Object.values(customerData).some(val => val !== 'unknown' && val !== '')) {
							console.log("Call was lost during chunk playback. Sending technical difficulty email...");
							await sendTechnicalDifficultyEmail().catch(err =>
								console.error("Failed to send technical difficulty email:", err)
							);
						}
						break;
					}
				}
			}
		}

		console.log(`Successfully played message with context: ${context}`);
	} catch (error) {
		// We already logged the error in safeCallOperation
		// No need to rethrow to prevent unhandled rejections
	}
}

async function detectEscalateToAgentIntent(speechInput: string) {
	return hasIntent(speechInput, "talk to human agent");
}

async function hasIntent(userQuery: string, intentDescription: string) {
	const systemPrompt = "You are a helpful assistant";
	const userPrompt = `In 1 word: does ${userQuery} have similar meaning as ${intentDescription}?`;
	const result = await getChatCompletions(systemPrompt, userPrompt);
	var isMatch = result.toLowerCase().startsWith("yes");
	console.log("OpenAI results: isMatch=%s, customerQuery=%s, intentDescription=%s", isMatch, userQuery, intentDescription);
	return isMatch;
}

async function getChatCompletions(systemPrompt: string, userPrompt: string) {
	try {
		const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_NAME;

		// Log original input sizes
		console.log(`[SIZE_DEBUG] Original input sizes - System prompt: ${systemPrompt.length} bytes, User prompt: ${userPrompt.length} bytes`);

		// Calculate JSON string size to better understand actual request payload
		const originalMessages = [
			{ role: "system" as const, content: systemPrompt },
			{ role: "user" as const, content: userPrompt },
		];
		const originalRequestSize = JSON.stringify(originalMessages).length;
		console.log(`[SIZE_DEBUG] Original request JSON size: ${originalRequestSize} bytes`);

		// Prevent system prompts that are too long
		let trimmedSystemPrompt = systemPrompt;
		if (systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
			console.warn(`System prompt too long (${systemPrompt.length} chars), trimming to ${MAX_SYSTEM_PROMPT_LENGTH} chars`);
			trimmedSystemPrompt = systemPrompt.substring(0, MAX_SYSTEM_PROMPT_LENGTH) +
				"... [Content trimmed due to length limits. Focus on gathering key customer information.]";
		}

		// Also limit user prompt length
		let trimmedUserPrompt = userPrompt;
		if (userPrompt.length > MAX_USER_PROMPT_LENGTH) {
			console.warn(`User prompt too long (${userPrompt.length} chars), trimming to ${MAX_USER_PROMPT_LENGTH} chars`);
			trimmedUserPrompt = userPrompt.substring(0, MAX_USER_PROMPT_LENGTH) +
				"... [Content trimmed due to length limits]";
		}

		// Log trimmed sizes
		console.log(`[SIZE_DEBUG] Trimmed input sizes - System prompt: ${trimmedSystemPrompt.length} bytes, User prompt: ${trimmedUserPrompt.length} bytes`);

		// Properly cast messages to the expected type for chat completions
		const messages = [
			{ role: "system" as const, content: trimmedSystemPrompt },
			{ role: "user" as const, content: trimmedUserPrompt },
		];

		// Calculate trimmed JSON size
		const trimmedRequestSize = JSON.stringify(messages).length;
		console.log(`[SIZE_DEBUG] Trimmed request JSON size: ${trimmedRequestSize} bytes (Diff: ${originalRequestSize - trimmedRequestSize} bytes)`);

		console.log(`Sending request to OpenAI with message lengths - System: ${trimmedSystemPrompt.length}, User: ${trimmedUserPrompt.length}`);

		// Use the new OpenAI SDK ChatCompletion format
		const response = await openAiClient.chat.completions.create({
			model: deploymentName,
			messages: messages,
		});

		const responseContent = response.choices[0].message.content;
		var str_responses = response.choices.map(choice => choice.message.content || "").join("\n");

		// Enhanced response size logging with more details
		const responseSize = responseContent ? responseContent.length : 0;
		console.log(`[SIZE_DEBUG] Response size: ${responseSize} bytes`);

		// Log token usage from the API response if available
		if (response.usage) {
			console.log(`[SIZE_DEBUG] Token usage information from API:`);
			console.log(`[SIZE_DEBUG] - Prompt tokens: ${response.usage.prompt_tokens}`);
			console.log(`[SIZE_DEBUG] - Completion tokens: ${response.usage.completion_tokens}`);
			console.log(`[SIZE_DEBUG] - Total tokens: ${response.usage.total_tokens}`);

			// Use our new metrics logger with comprehensive information
			logApiUsageMetrics({
				systemPromptLength: trimmedSystemPrompt.length,
				userPromptLength: trimmedUserPrompt.length,
				responseLength: responseSize,
				tokenUsage: {
					prompt_tokens: response.usage.prompt_tokens,
					completion_tokens: response.usage.completion_tokens,
					total_tokens: response.usage.total_tokens
				}
			});

			// Check if approaching model limits
			const deploymentModelName = process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_NAME || "unknown";
			const tokenLimit =
				deploymentModelName.includes("gpt-3.5") ? 4096 :
					deploymentModelName.includes("gpt-4-32k") ? 32768 :
						deploymentModelName.includes("gpt-4") ? 8192 :
							4096; // default to 4096 if unknown

			const usagePercent = (response.usage.total_tokens / tokenLimit) * 100;
			console.log(`[SIZE_DEBUG] Using ${response.usage.total_tokens} of ${tokenLimit} tokens (${usagePercent.toFixed(1)}%)`);

			if (usagePercent > 80) {
				console.warn(`[SIZE_DEBUG] WARNING: Token usage is over 80% of model limit (${usagePercent.toFixed(1)}%)`);
				console.warn(`[SIZE_DEBUG] Consider reducing prompt sizes or using a model with higher token limits`);
			}
		}

		console.log("OpenAI responses: ", str_responses);
		if (responseContent && responseContent.length > MAX_RESPONSE_LENGTH) {
			console.warn(`Response from OpenAI too long (${responseContent.length} chars), need to trim the conversational part`);
			console.log(`[SIZE_DEBUG] Response exceeds MAX_RESPONSE_LENGTH (${MAX_RESPONSE_LENGTH})`);
			console.log(`[SIZE_DEBUG] Excess characters: ${responseContent.length - MAX_RESPONSE_LENGTH}`);
			console.log(`[SIZE_DEBUG] Response is ${(responseContent.length / MAX_RESPONSE_LENGTH).toFixed(2)}x longer than allowed`);

			// Log the first and last parts of the response to help with debugging
			const previewLength = 100;
			console.log(`[SIZE_DEBUG] Response preview (first ${previewLength} chars): "${responseContent.substring(0, previewLength)}..."`);
			console.log(`[SIZE_DEBUG] Response ending (last ${previewLength} chars): "...${responseContent.substring(responseContent.length - previewLength)}"`);

			// If response contains customer data section, handle it separately
			if (responseContent.includes("DATA_START") && responseContent.includes("DATA_END")) {
				// Split into conversational part and data part
				const parts = responseContent.split("DATA_START");
				const conversationalPart = parts[0].trim();

				// Log the data section size to help understand what's causing the large response
				console.log(`[SIZE_DEBUG] Response contains DATA section. Conversational part: ${conversationalPart.length} chars`);
				console.log(`[SIZE_DEBUG] DATA section size: ${responseContent.length - conversationalPart.length} chars`);
				const dataPart = "DATA_START" + parts[1]; // This preserves the data section

				console.log(`[SIZE_DEBUG] Conversational part size: ${conversationalPart.length} bytes, Data part size: ${dataPart.length} bytes`);

				// Trim only the conversational part
				if (conversationalPart.length > MAX_RESPONSE_LENGTH) {
					const trimmedConversation = conversationalPart.substring(0, MAX_RESPONSE_LENGTH) +
						"... [Response was trimmed due to length limits]";

					const finalResponse = trimmedConversation + "\n\n" + dataPart;
					console.log(`[SIZE_DEBUG] Final trimmed response size: ${finalResponse.length} bytes (Reduced by: ${responseContent.length - finalResponse.length} bytes)`);

					// Return the trimmed conversation with the intact data section
					return finalResponse;
				}

				// If conversational part is not too long, return as is
				console.log(`[SIZE_DEBUG] No trimming needed for conversational part`);
				return responseContent;
			}
			else {
				// No data section, just trim the whole response
				console.log(`[SIZE_DEBUG] No DATA section found, trimming the entire response`);

				// Look for logical break points to make a cleaner trim
				let trimPoint = MAX_RESPONSE_LENGTH;
				const possibleBreakPoints = ['. ', '? ', '! ', '\n\n', '\n'];

				// Try to find a natural break point within the last 20% of the allowed length
				const searchStartPos = Math.floor(MAX_RESPONSE_LENGTH * 0.8);

				// Find the best break point if possible
				for (const breakPoint of possibleBreakPoints) {
					const lastBreak = responseContent.lastIndexOf(breakPoint, MAX_RESPONSE_LENGTH);
					if (lastBreak > searchStartPos) {
						trimPoint = lastBreak + 1; // Include the period/question mark but not the space
						console.log(`[SIZE_DEBUG] Found natural break point at position ${trimPoint} (${breakPoint.replace('\n', '\\n')})`);
						break;
					}
				}

				const trimmedResponse = responseContent.substring(0, trimPoint) +
					"... [Response was trimmed due to length limits]";

				console.log(`[SIZE_DEBUG] Trimmed response size: ${trimmedResponse.length} bytes (Reduced by: ${responseContent.length - trimmedResponse.length} bytes)`);
				console.log(`[SIZE_DEBUG] Trimming removed ${responseContent.length - trimPoint} characters of content`);
				return trimmedResponse;
			}
		}

		// Log the final response size if no trimming was needed
		console.log(`[SIZE_DEBUG] Final response size (no trimming needed): ${str_responses.length} bytes`);
		return str_responses || "I apologize, but I couldn't generate a response.";
	} catch (error) {
		console.error("Error in getChatCompletions:", error);

		// Enhanced error logging for better troubleshooting
		console.error(`[ERROR_DEBUG] Error type: ${error.constructor.name}`);
		console.error(`[ERROR_DEBUG] Error message: ${error.message}`);

		// Use our metrics logger for the error case too
		console.error("[ERROR_DEBUG] Request metrics at time of error:");
		try {
			const trimmedSystemPrompt = systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH
				? systemPrompt.substring(0, MAX_SYSTEM_PROMPT_LENGTH) + "..."
				: systemPrompt;

			const trimmedUserPrompt = userPrompt.length > MAX_USER_PROMPT_LENGTH
				? userPrompt.substring(0, MAX_USER_PROMPT_LENGTH) + "..."
				: userPrompt;

			logApiUsageMetrics({
				systemPromptLength: systemPrompt.length,
				userPromptLength: userPrompt.length,
				responseLength: 0, // No response in error case
				// No token usage available in error case
			});
		}
		catch (metricsError) {
			console.error("[ERROR_DEBUG] Failed to log metrics:", metricsError.message);
		}

		// Log more details about the error for debugging
		if (error.response) {
			console.error(`[ERROR_DEBUG] Status code: ${error.response.status}`);
			console.error(`[ERROR_DEBUG] Status text: ${error.response.statusText || 'N/A'}`);

			if (error.response.headers) {
				try {
					console.error(`[ERROR_DEBUG] Headers: ${JSON.stringify(error.response.headers)}`);
				} catch (e) {
					console.error(`[ERROR_DEBUG] Headers: Could not stringify headers`);
				}
			}

			if (error.response.data) {
				try {
					console.error(`[ERROR_DEBUG] Response data: ${JSON.stringify(error.response.data)}`);
				} catch (e) {
					console.error(`[ERROR_DEBUG] Response data: Could not stringify response data`);
				}
			}
		}

		// Get detailed diagnosis of the error
		const errorDiagnosis = diagnoseAzureOpenAIError(error);
		console.error("\n" + errorDiagnosis);

		// For specific errors, provide additional context about input sizes
		if (error.message && error.message.includes("Invalid Request")) {
			console.error("[ERROR_DEBUG] The 'Invalid Request' error often occurs due to messages that are too long");
			console.error(`[ERROR_DEBUG] System prompt original length: ${systemPrompt.length}`);
			console.error(`[ERROR_DEBUG] User prompt original length: ${userPrompt.length}`);

			// Calculate total request size with detailed breakdown
			const messages = [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt }
			];
			const requestSize = JSON.stringify(messages).length;
			console.error(`[ERROR_DEBUG] Total request JSON payload size: ${requestSize} bytes`);

			// Check if the size exceeds common limits for different models
			const tokenEstimate = Math.ceil(requestSize / 4); // Rough estimate: 1 token ≈ 4 bytes in English
			console.error(`[ERROR_DEBUG] Estimated token count: ~${tokenEstimate} tokens`);

			// Log common token limits for reference
			console.error("[ERROR_DEBUG] Common token limits by model:");
			console.error("[ERROR_DEBUG] - gpt-3.5-turbo: 4,096 tokens");
			console.error("[ERROR_DEBUG] - gpt-4: 8,192 tokens");
			console.error("[ERROR_DEBUG] - gpt-4-32k: 32,768 tokens");

			if (tokenEstimate > 4000) {
				console.error(`[ERROR_DEBUG] Request likely exceeds token limit for gpt-3.5-turbo`);
			}
			if (tokenEstimate > 8000) {
				console.error(`[ERROR_DEBUG] Request likely exceeds token limit for gpt-4`);
			}
			// More specific guidance based on the deployment model
			const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_NAME || "unknown";
			console.error(`[ERROR_DEBUG] Your current deployment model is: ${deploymentName}`);

			if (deploymentName.includes("gpt-3.5")) {
				console.error("[ERROR_DEBUG] For gpt-3.5-turbo, consider keeping total tokens under 4,000");
			} else if (deploymentName.includes("gpt-4") && !deploymentName.includes("32k")) {
				console.error("[ERROR_DEBUG] For gpt-4, consider keeping total tokens under 8,000");
			} else if (deploymentName.includes("gpt-4-32k")) {
				console.error("[ERROR_DEBUG] For gpt-4-32k, consider keeping total tokens under 32,000");
			}

			// Suggestion for fixing the issue
			console.error("[ERROR_DEBUG] Consider:");
			console.error("[ERROR_DEBUG] 1. Reducing MAX_SYSTEM_PROMPT_LENGTH and MAX_USER_PROMPT_LENGTH in your .env file");
			console.error("[ERROR_DEBUG] 2. Using a model with higher token limits");
			console.error("[ERROR_DEBUG] 3. Simplifying your prompts to be more concise");
			console.error("[ERROR_DEBUG] 4. Implementing a retry mechanism with progressive prompt reduction");
			console.error("[ERROR_DEBUG] 5. Check for context growth in conversation history");
		} else if (error.message && error.message.toLowerCase().includes("rate limit")) {
			// Rate limit handling guidance
			console.error("[ERROR_DEBUG] This appears to be a rate limit error.");
			console.error("[ERROR_DEBUG] RECOMMENDED ACTIONS:");
			console.error("[ERROR_DEBUG] 1. Implement exponential backoff with retry mechanism");
			console.error("[ERROR_DEBUG] 2. Reduce concurrent requests to the API");
			console.error("[ERROR_DEBUG] 3. Consider increasing your quota in Azure portal");
			console.error("[ERROR_DEBUG] 4. Monitor TPM (tokens per minute) usage");
		}
		else if (error.message && (error.message.toLowerCase().includes("timeout") || error.message.toLowerCase().includes("timed out"))) {
			// Timeout handling guidance
			console.error("[ERROR_DEBUG] This appears to be a timeout error.");
			console.error("[ERROR_DEBUG] RECOMMENDED ACTIONS:");
			console.error("[ERROR_DEBUG] 1. Check network connectivity to Azure OpenAI endpoint");
			console.error("[ERROR_DEBUG] 2. Increase timeout settings in your OpenAI client configuration");
			console.error("[ERROR_DEBUG] 3. Reduce the size of prompt or complexity of request");
			console.error("[ERROR_DEBUG] 4. Implement a retry mechanism with longer timeouts");
		}

		console.error("[ERROR_DEBUG] 3. Restructuring your prompts to be more concise");

		console.error("[ERROR_DEBUG] 4. Simplifying any complex JSON or formatting in your prompts");

	}

	// Return a fallback response to prevent null/undefined errors
	return "I apologize, but I'm having trouble processing your request right now. Let me help you with the basics of your trip planning. Can you tell me more about when you'd like to travel?";
}


function updateCustomerDataFromResponse(response: string): void {
	try {
		// Extract JSON between DATA_START and DATA_END
		const dataMatch = response.match(/DATA_START\s*({[\s\S]*?})\s*DATA_END/);

		if (dataMatch && dataMatch[1]) {
			let extractedJson = dataMatch[1];

			// Clean up common issues with JSON before parsing
			extractedJson = extractedJson.replace(/\n/g, ' ').replace(/,\s*}/g, '}');

			try {
				const extractedData = JSON.parse(extractedJson);
				console.log("Extracted customer data:", extractedData);

				// Update global customer data with new information
				customerData = { ...customerData, ...extractedData };
				console.log("Updated customer data:", customerData);

				// Check if all required fields are filled and email hasn't been sent yet
				if (isAllRequiredDataCollected() && !emailSent) {
					console.log("All required customer data collected! Sending email...");

					// Send email with customer data
					sendCustomerDataEmail()
						.then(success => {
							if (success) {
								emailSent = true;
								console.log("Customer data email sent successfully");
							}
						})
						.catch(error => {
							console.error("Failed to send customer data email:", error);
						});
				}
			} catch (jsonError) {
				console.error("Error parsing JSON from response:", jsonError);
				console.error("Problematic JSON string:", extractedJson);
			}
		}
		else {
			console.log("No customer data found in the response");
		}
	} catch (error) {
		console.error("Error updating customer data:", error);
	}
}

function extractConversationalResponse(fullResponse: string): string {
	// If there's no DATA_START marker, return the full response or a trimmed version
	if (!fullResponse.includes("DATA_START")) {
		// For very long responses, trim them 

		if (fullResponse.length > MAX_RESPONSE_LENGTH) {
			console.warn(`Response too long (${fullResponse.length} chars), trimming...`);
			return fullResponse.substring(0, MAX_RESPONSE_LENGTH) + "...";
		}
		return fullResponse;
	}

	// Otherwise return only the part before DATA_START
	const conversationalPart = fullResponse.split("DATA_START")[0].trim();

	// No need to check and trim the length again here - already handled in getChatCompletions
	// Just return the conversation part as is, since trimming is now handled upstream
	return conversationalPart;
}

async function getChatGptResponse(speechInput: string, callConnectionMedia?: CallMedia) {
	// Limit speech input length to prevent issues
	let trimmedSpeechInput = speechInput;
	if (speechInput.length > MAX_SPEECH_INPUT_LENGTH) {
		console.warn(`Speech input too long (${speechInput.length} chars), trimming to ${MAX_SPEECH_INPUT_LENGTH}`);
		trimmedSpeechInput = speechInput.substring(0, MAX_SPEECH_INPUT_LENGTH) + "...";
	}

	// Add DTMF context to the system prompt if the input contains DTMF information
	let systemPromptWithDtmf = answerPromptSystemTemplate;
	if (trimmedSpeechInput.includes("DTMF")) {
		// Using a shorter DTMF guidance to reduce overall prompt length
		systemPromptWithDtmf = answerPromptSystemTemplate + `\n\nCustomer using keypad: 1=yes, 2=no, 0=agent, digits=possible phone/date.`;
	}

	// Compress the customer data JSON to save space
	const compressedData = JSON.stringify(customerData);
	// Pass the current customer data to ensure continuity between responses, but keep it minimal
	const systemPromptWithData = `${systemPromptWithDtmf}\n\nCurrent data: ${compressedData}`;

	// Try to get a response with potential retries for invalid requests
	let tries = 0;
	const MAX_TRIES = 3;

	// Start playing typing indicator if media connection is provided
	let typingIndicatorPromise: Promise<void> | null = null;
	if (callConnectionMedia) {
		console.log("Starting enhanced typing indicator...");
		typingIndicatorPromise = playEnhancedTypingIndicator(
			callConnectionMedia,
			TYPING_INDICATOR_AUDIO_URL,
			TYPING_INDICATOR_CACHE_ID,
			currentCallVoice
		);
	}

	try {
		while (tries < MAX_TRIES) {
			try {
				const response = await getChatCompletions(systemPromptWithData, trimmedSpeechInput);
				// Stop the typing indicator with better error handling
				if (callConnectionMedia) {
					console.log("Response ready - stopping typing indicator and applying delay");
					stopEnhancedTypingIndicator();
					// Give a longer delay to ensure typing indicator has fully stopped
					await new Promise(resolve => setTimeout(resolve, 500));
					console.log("Delay completed, proceeding with response");
				}

				// Extract and update customer data from the response
				// The full response is passed, even if it was trimmed, because
				// our trimming logic now preserves the customer data section
				updateCustomerDataFromResponse(response);

				// Return only the conversational part (before DATA_START)
				const conversationalResponse = extractConversationalResponse(response);

				// No need for additional length checks here - already handled in getChatCompletions

				return conversationalResponse;
			} catch (error) {
				tries++;
				console.error(`Error in getChatGptResponse (attempt ${tries}):`, error);

				// Make sure we stop the typing indicator if there's an error
				if (callConnectionMedia) {
					console.error("Error occurred - making sure typing indicator is stopped");
					stopEnhancedTypingIndicator();
					// Add delay here too to ensure it stops
					await new Promise(resolve => setTimeout(resolve, 300));
					console.log("Error recovery delay completed");
				}

				if (tries >= MAX_TRIES) {
					// Return a fallback response
					return "I apologize for the technical difficulty. Can you please tell me more about when you'd like to travel to Egypt?";
				}

				// If we're retrying, make the prompts even shorter
				systemPromptWithDtmf = "You are a travel agent gathering info for a wellness retreat to Egypt. Be brief.";
			}
		}

		// Fallback (should not reach here due to the return in the error handling)
		return "I apologize, but I'm having technical difficulties. Please tell me when you'd like to travel, or press 0 for agent.";
	} catch (error) {
		console.error("Unexpected error in getChatGptResponse:", error);

		// Make sure we stop the typing indicator if there's an error
		if (callConnectionMedia) {
			console.error("Unexpected error - making sure typing indicator is forcefully stopped");
			stopEnhancedTypingIndicator();
			// Add delay here too to ensure it stops
			await new Promise(resolve => setTimeout(resolve, 300));
			console.log("Emergency error recovery delay completed");
		}

		return "I apologize, but I'm having technical difficulties. Please tell me when you'd like to travel, or press 0 for agent.";
	}
}

// Generate a continuation prompt based on collected customer data
function generateContinuationPrompt(customerData: any): string {
	let prompt = "";

	// Start with a personalized greeting if we have their name
	if (customerData.customerName !== "unknown") {
		prompt = `Thank you for your patience, ${customerData.customerName}. `;
	} else {
		prompt = "Thank you for your patience. ";
	}

	// Add context based on what we already know
	let missingFields = [];
	if (customerData.travelDate === "unknown") missingFields.push("when you'd like to travel");
	if (customerData.stayDuration === "unknown") missingFields.push("how long you'd like to stay");
	if (customerData.activities === "unknown") missingFields.push("what activities interest you");
	if (customerData.email === "unknown") missingFields.push("your email for contact purposes");
	if (customerData.phoneNumber === "unknown") missingFields.push("your preferred contact number");

	if (missingFields.length > 0) {
		// Format the list of missing information
		if (missingFields.length === 1) {
			prompt += `Let's continue our conversation about your Wellness retreat to Luxor, Egypt. I'd still like to know ${missingFields[0]}.`;
		} else {
			const lastItem = missingFields.pop();
			prompt += `Let's continue our conversation about your Wellness retreat to Luxor, Egypt. I'd still like to know ${missingFields.join(", ")} and ${lastItem}.`;
		}
	} else {
		// If we have all the key information
		prompt += "Let's continue our conversation about your Wellness retreat to Luxor, Egypt. Is there anything else you'd like to know or share about your trip?";
	}

	return prompt;
}

// Splits a long message into smaller chunks to prevent timeouts
function splitLongMessage(message: string): string[] {
	// Maximum length for a single response (characters) - reduced for Azure Communication Services
	const maxChunkLength = 800; // Reduced from 1000 to be safer with Azure Communication Services limits

	if (message.length <= maxChunkLength) {
		return [message];
	}

	const chunks: string[] = [];

	// Try to split on sentences to maintain natural pauses
	const sentences = message.match(/[^.!?]+[.!?]+/g) || [];

	// If no sentences were found (rare case), split by character count
	if (sentences.length === 0) {
		for (let i = 0; i < message.length; i += maxChunkLength) {
			chunks.push(message.substring(i, Math.min(i + maxChunkLength, message.length)));
		}
		return chunks;
	}

	let currentChunk = "";
	for (const sentence of sentences) {
		// If adding this sentence would exceed the limit, start a new chunk
		if (currentChunk.length + sentence.length > maxChunkLength) {
			if (currentChunk.length > 0) {
				chunks.push(currentChunk.trim());
				currentChunk = "";
			}

			// If a single sentence is longer than maxChunkLength, split it by words
			if (sentence.length > maxChunkLength) {
				const words = sentence.split(' ');
				let wordChunk = "";

				for (const word of words) {
					if (wordChunk.length + word.length + 1 > maxChunkLength) {
						chunks.push(wordChunk.trim());
						wordChunk = word;
					} else {
						wordChunk += (wordChunk.length > 0 ? ' ' : '') + word;
					}
				}

				if (wordChunk.length > 0) {
					currentChunk = wordChunk;
				}
			} else {
				currentChunk = sentence;
			}
		} else {
			currentChunk += sentence;
		}
	}

	if (currentChunk.length > 0) {
		chunks.push(currentChunk.trim());
	}

	// Log chunk information for debugging
	console.log(`Split message into ${chunks.length} chunks. Original length: ${message.length} chars`);
	chunks.forEach((chunk, i) => {
		console.log(`Chunk ${i + 1}: ${chunk.length} chars`);
	});

	return chunks;
}

// Helper function to safely handle call operations
async function safeCallOperation(operation: () => Promise<any>, errorMessage: string): Promise<any> {
	try {
		return await operation();
	} catch (error) {
		console.error(`${errorMessage}: ${error}`);

		// Check specifically for "Call not found" errors
		if (error.toString().includes("Call not found") || error.toString().includes("not found")) {
			console.log("Call appears to have been disconnected or no longer exists.");

			// Send email if we have any meaningful data and haven't already sent one
			if (!emailSent && Object.values(customerData).some(val => val !== 'unknown' && val !== '')) {
				console.log("Call was lost but some data was collected. Sending technical difficulty email...");
				await sendTechnicalDifficultyEmail().catch(err =>
					console.error("Failed to send technical difficulty email:", err)
				);
			}
		}

		// Rethrow the error so caller can handle it if needed
		throw error;
	}
}

// Function to reset customer data to initial state
function resetCustomerData(): void {
	// Store the called-from number temporarily as we want to keep that
	const calledFromNumber = customerData.calledFromNumber;

	// Reset all customer data
	customerData = {
		customerName: "unknown",
		email: "unknown",
		phoneNumber: "unknown",
		calledFromNumber: calledFromNumber, // Preserve the called-from number
		travelDate: "unknown",
		stayDuration: "unknown",
		activities: "unknown",
		budget: "unknown",
		alternateDestinations: "unknown",
		notes: "unknown",
		interestLevel: "unknown"
	};

	// Reset other global state
	emailSent = false;
	technicalDifficultiesCount = 0;
	maxTimeout = 3;

	currentCallVoice = getRandomVoice();
	console.log("Customer data and session variables have been reset");
}

// Create a personalized goodbye message based on collected customer data
function createPersonalizedGoodbyeMessage(): string {
	// Base goodbye message
	let message = "Thank you for your interest in our Wellness Retreat to Luxor, Egypt. ";

	// Add personalization if we have their name
	if (customerData.customerName !== "unknown") {
		message = `Thank you ${customerData.customerName} for your interest in our Wellness Retreat to Luxor, Egypt. `;
	}

	// Add contact method-specific message
	let contactMethod = "";
	if (customerData.phoneNumber !== "unknown") {
		contactMethod = `call you back at ${customerData.phoneNumber}`;
	} else if (customerData.email !== "unknown") {
		contactMethod = `reach out to you at ${customerData.email}`;
	} else if (customerData.calledFromNumber !== "unknown") {
		contactMethod = `call you back at ${customerData.calledFromNumber}`;
	} else {
		contactMethod = "contact you using the information you've provided";
	}

	// Complete the message
	message += `One of our travel specialists will ${contactMethod} shortly to discuss your trip details further. Have a wonderful day!`;

	return message;
}

// Handle transfer to agent
async function transferToAgent(callMedia: CallMedia): Promise<void> {
	try {
		console.log("Initiating transfer to agent");

		// First, verify we have an agent phone number
		if (!process.env.AGENT_PHONE_NUMBER) {
			console.error("Agent phone number is not configured");
			await handlePlay(callMedia, agentPhoneNumberEmptyPrompt, transferFailedContext);
			return;
		}

		// Tell the caller we're transferring them - use dtmfTransferContext to avoid recognition during transfer
		await handlePlay(
			callMedia,
			"Thank you for your interest. I'm transferring you to a live agent who can provide more personalized assistance. Please hold the line.",
			dtmfTransferContext
		);

		// Get and format the agent phone number - use a more rigorous formatting approach
		let agentPhoneNumber = formatPhoneNumberForTransfer(process.env.AGENT_PHONE_NUMBER);

		// Validate the number before attempting transfer
		const phoneRegex = /^\+\d{10,15}$/;
		if (!phoneRegex.test(agentPhoneNumber)) {
			console.error(`Invalid phone number format for transfer: ${agentPhoneNumber}`);
			console.error(`Original agent phone number: ${process.env.AGENT_PHONE_NUMBER}`);
			console.error("Fixing format issues and attempting transfer anyway...");

			// Last resort formatting - strip everything except digits and add + at beginning
			agentPhoneNumber = "+" + agentPhoneNumber.replace(/\D/g, '');

			// For US numbers, ensure country code
			if (agentPhoneNumber.length === 11) {
				// Likely already has country code
			} else if (agentPhoneNumber.length === 10) {
				// Add US country code
				agentPhoneNumber = "+1" + agentPhoneNumber.substring(1);
			}

			console.log(`Final attempt with reformatted number: ${agentPhoneNumber}`);
		}

		// Log the transfer with formatted number
		console.log(`Transferring call to agent phone number (formatted): ${agentPhoneNumber}`);

		// Create the transfer options with appropriate context
		const transferOptions: TransferCallToParticipantOptions = {
			operationContext: dtmfTransferContext  // Using dtmfTransferContext to prevent speech recognition
		};

		// Execute the transfer with timeout protection
		const phoneNumberIdentifier: PhoneNumberIdentifier = {
			phoneNumber: agentPhoneNumber
		};

		const transferPromise = callConnection.transferCallToParticipant(
			phoneNumberIdentifier,
			transferOptions
		);

		const timeoutPromise = new Promise<void>((_, reject) =>
			setTimeout(() => reject(new Error("Transfer call timeout")), 15000)
		);

		await Promise.race([transferPromise, timeoutPromise]);
		console.log("Transfer to agent successfully initiated");
	} catch (error) {
		console.error("Error transferring to agent:", error);

		// Enhanced error handling with more details
		if (error.code === 400 && error.subCode === 10129) {
			console.error("Transfer error code 10129: User is not entitled to call this destination");
			console.error("This could indicate one of the following issues:");
			console.error("1. Phone number format is incorrect - should be in E.164 format (+[country code][number])");
			console.error("2. Agent phone number may not have permission to receive transferred calls");
			console.error("3. There may be a restriction on the calling plan or policy");

			// Log the phone number details for debugging
			console.error(`Original agent phone number: ${process.env.AGENT_PHONE_NUMBER}`);
			console.error(`Formatted agent phone number: ${formatPhoneNumberForTransfer(process.env.AGENT_PHONE_NUMBER)}`);
			console.error("E.164 format example: +12065551234 (plus sign, country code, number)");
		} else {
			// Log other errors
			console.error(`Transfer error: ${error.message || error}`);
			if (error.code) console.error(`Error code: ${error.code}`);
			if (error.subCode) console.error(`Error subCode: ${error.subCode}`);
		}

		// If transfer fails, inform the caller
		try {
			await handlePlay(callMedia, callTransferFailurePrompt, transferFailedContext);
		} catch (playError) {
			console.error("Error playing transfer failure message:", playError);
		}
	}
}

app.post("/api/incomingCall", async (req: any, res: any) => {
	console.log(`Received incoming call event - data --> ${JSON.stringify(req.body)} `);

	// Ensure there's at least one event in the array
	if (!req.body || !Array.isArray(req.body) || req.body.length === 0) {
		console.error("Invalid incoming call event body:", req.body);
		res.status(400).send("Invalid event body");
		return;
	}

	const event = req.body[0];

	// Validate event structure
	if (!event || !event.data) {
		console.error("Event or event data is missing:", event);
		res.status(400).send("Invalid event structure");
		return;
	}

	try {
		const eventData = event.data;

		// Handle subscription validation event
		if (event.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
			console.log("Received SubscriptionValidation event");
			res.status(200).json({
				validationResponse: eventData.validationCode,
			});
			return;
		}

		// Respond immediately to prevent timeouts that could lead to busy signals
		res.status(202).send("Processing call");
		// Ensure ACS client is initialized
		if (!acsClient) {
			console.log("ACS client not initialized, creating it now");
			await createAcsClient();
		}

		// Ensure Email client is initialized
		if (!emailClient) {
			console.log("Email client not initialized, creating it now");
			await createEmailClient();
		}

		// Reset any previous call state
		resetCustomerData();
		technicalDifficultiesCount = 0;

		// Select a random voice for this call
		currentCallVoice = getRandomVoice();
		console.log(`Using voice ${currentCallVoice} for this call`);

		// Extract caller ID
		if (!eventData.from || !eventData.from.rawId) {
			throw new Error("Missing caller information in event data");
		}

		callerId = eventData.from.rawId;

		// Store the calling number in customer data
		const formattedCallerNumber = callerId.replace('tel:', '');
		customerData.calledFromNumber = formattedCallerNumber;
		console.log(`Call coming from: ${formattedCallerNumber}`);

		// Validate required data for answering the call
		if (!eventData.incomingCallContext) {
			throw new Error("Missing incomingCallContext in event data");
		}

		if (!process.env.CALLBACK_URI) {
			throw new Error("Missing CALLBACK_URI environment variable");
		}

		if (!process.env.COGNITIVE_SERVICE_ENDPOINT) {
			throw new Error("Missing COGNITIVE_SERVICE_ENDPOINT environment variable");
		}

		// Generate unique ID for this call
		const uuid = uuidv4();
		const callbackUri = `${process.env.CALLBACK_URI}/api/callbacks/${uuid}?callerId=${callerId}`;
		const incomingCallContext = eventData.incomingCallContext;

		console.log(`Cognitive service endpoint: ${process.env.COGNITIVE_SERVICE_ENDPOINT.trim()}`);
		console.log(`Callback URI: ${callbackUri}`);

		// Set up call intelligence options
		const callIntelligenceOptions: CallIntelligenceOptions = {
			cognitiveServicesEndpoint: process.env.COGNITIVE_SERVICE_ENDPOINT
		};

		// Configure answer call options
		const answerCallOptions: AnswerCallOptions = {
			callIntelligenceOptions: callIntelligenceOptions
		};

		// Attempt to answer the call with a timeout guard
		console.log("Attempting to answer the call...");
		try {
			answerCallResult = await Promise.race([
				acsClient.answerCall(incomingCallContext, callbackUri, answerCallOptions),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Answer call timeout")), 15000)
				)
			]);
			console.log("Call answered successfully, setting up call connection");
			callConnection = answerCallResult.callConnection;
			callMedia = callConnection.getCallMedia();

			// Log successful call setup without trying to access private property
			console.log("Call successfully set up and ready to process");
		} catch (answerError) {
			console.error("Error answering call with timeout protection:", answerError);
			throw answerError; // Re-throw to be handled by outer catch
		}
	}
	catch (error) {
		console.error("Error during the incoming call event:", error);

		// Don't try to respond again if we've already sent a response
		if (!res.headersSent) {
			res.status(500).send("Error processing call");
		}

		// Reset variables to prepare for next call
		resetCustomerData();
		technicalDifficultiesCount = 0;
	}
});

app.post('/api/callbacks/:contextId', async (req: any, res: any) => {
	// Send response immediately to prevent timeouts
	res.status(200).send('Event received');

	try {
		const contextId = req.params.contextId;

		// Check if req.body exists and is an array with at least one element
		if (!req.body || !Array.isArray(req.body) || req.body.length === 0) {
			console.error("Invalid callback event body:", req.body);
			return;
		}

		const event = req.body[0];
		if (!event || !event.data) {
			console.error("Event or event data is missing:", event);
			return;
		}

		const eventData = event.data;
		console.log(`Received callback event - data --> ${JSON.stringify(req.body)} `);
		console.log(`event type: ${event.type}`);

		if (event.type === "Microsoft.Communication.CallConnected") {
			console.log("Received CallConnected event");
			await startRecognizing(callMedia, callerId, helloPrompt, 'GetFreeFormText');
		}
		else if (event.type === "Microsoft.Communication.PlayCompleted") {
			console.log("Received PlayCompleted event");

			if (eventData.operationContext && (eventData.operationContext === transferFailedContext
				|| eventData.operationContext === goodbyeContext)) {
				console.log("Disconnecting the call");
				await hangUpCall().catch(error => console.error("Error hanging up call:", error));
			}
			// Don't need to handle transfers here anymore as it's handled directly in the transferToAgent function
			// The dtmfTransferContext is used to prevent speech recognition during transfer
			else if (eventData.operationContext === dtmfTransferContext) {
				console.log("Transfer announcement complete. Transfer should already be in progress.");
				// The actual transfer is now handled directly in the transferToAgent function
				// No action needed here as we don't want to start another recognition
			}
			else {
				await startRecognizing(callMedia, callerId, "", 'GetFreeFormText');
			}
		} else if (event.type === "Microsoft.Communication.playFailed") {
			console.log("Received PlayFailed event");
			//await hangUpCall().catch(error => console.error("Error hanging up call:", error));
		}
		else if (event.type === "Microsoft.Communication.callTransferAccepted") {
			console.log("Call transfer accepted event received");
		} else if (event.type === "Microsoft.Communication.callTransferFailed") {
			console.log("Call transfer failed event received");
			var resultInformation = eventData.resultInformation;
			console.log("Encountered error during call transfer, message=%s, code=%s, subCode=%s", resultInformation?.message, resultInformation?.code, resultInformation?.subCode);

			// Add specific handling based on error codes
			if (resultInformation?.code === 400 && resultInformation?.subCode === 10129) {
				console.error("Transfer error code 10129: User is not entitled to call this destination");
				console.error("This could indicate one of the following issues:");
				console.error("1. Phone number format is incorrect - should be in E.164 format (+[country code][number])");
				console.error("2. Agent phone number may not have permission to receive transferred calls");
				console.error("3. There may be a restriction on the calling plan or policy");

				// Log the phone number details for debugging
				console.error(`Original agent phone number: ${process.env.AGENT_PHONE_NUMBER}`);
				console.error(`Formatted agent phone number: ${formatPhoneNumberForTransfer(process.env.AGENT_PHONE_NUMBER)}`);
				console.error("E.164 format example: +12065551234 (plus sign, country code, number)");

				// Try to verify phone number format again
				const phoneRegex = /^\+\d{10,15}$/;
				const formattedNumber = formatPhoneNumberForTransfer(process.env.AGENT_PHONE_NUMBER);
				if (!phoneRegex.test(formattedNumber)) {
					console.error("Phone number validation failed - number does not match E.164 pattern");
				}
			}

			// Inform the caller about transfer failure and play appropriate message
			await handlePlay(callMedia, callTransferFailurePrompt, transferFailedContext)
				.catch(error => console.error("Error playing transfer failure message:", error));
		}
		else if (event.type === "Microsoft.Communication.RecognizeCompleted") {
			if (eventData.recognitionType === "speech") {
				const speechText = eventData.speechResult.speech; if (speechText !== '') {
					console.log(`Recognized speech: ${speechText}`);

					// Decrease technical difficulties count for successful speech recognition
					if (technicalDifficultiesCount > 0) {
						technicalDifficultiesCount--;
						console.log(`Technical difficulties count decreased to: ${technicalDifficultiesCount}`);
					}

					// Check if user wants to talk to an agent
					if (await detectEscalateToAgentIntent(speechText)) {
						console.log("Escalation to agent detected");
						await transferToAgent(callMedia);
						return;
					}
					// Normal flow continues
					// Use the new version with typing sound by passing callMedia
					const chatGptResponse = await getChatGptResponse(speechText, callMedia);
					await startRecognizing(callMedia, callerId, chatGptResponse, 'GetFreeFormText');
				}
			}
			else if (eventData.recognitionType === "dtmf") {
				// Handle DTMF recognition
				const dtmfResult = eventData.dtmfResult;
				if (dtmfResult && dtmfResult.tones) {
					const tones = dtmfResult.tones;
					console.log(`Received DTMF tones: ${tones}`);

					// Handle different DTMF options
					if (tones.includes(DTMF_TRANSFER_TO_AGENT)) {
						// Transfer to agent when user presses 0
						console.log("DTMF Transfer to agent requested");
						await transferToAgent(callMedia);
					}
					else {
						// Process other DTMF inputs
						let response = await processDtmfInput(tones, eventData.operationContext);

						// Update OpenAI with the DTMF response as well
						const chatGptResponse = await getChatGptResponse(`Customer entered DTMF: ${tones}`);

						// Use either our processed response or the chatGPT response (which should be aware of the DTMF action)
						const finalResponse = response.length > chatGptResponse.length ? response : chatGptResponse;
						await startRecognizing(callMedia, callerId, finalResponse, 'GetFreeFormText');
					}
				}
			}
		}
		else if (event.type === "Microsoft.Communication.RecognizeFailed") {
			// try {
			// 	const resultInformation = eventData.resultInformation;
			// 	var code = resultInformation.subCode;
			// 	if(code === 8510 && maxTimeout > 0){
			// 		maxTimeout--;
			// 		//const chatGptResponse = await getChatGptResponse(speechText);
			// 		//await startRecognizing(callMedia, callerId, chatGptResponse, 'GetFreeFormText');

			// 		await startRecognizing(callMedia, callerId, "", 'GetFreeFormText');
			// 	}
			// 	else{
			// 		// Check if we have all required data before ending the call
			// 		if (isAllRequiredDataCollected()) {
			// 			// Use personalized goodbye message for customers who provided all necessary info
			// 			const personalizedGoodbye = createPersonalizedGoodbyeMessage();
			// 			await handlePlay(callMedia, personalizedGoodbye, goodbyeContext);
			// 		} else {
			// 			// Use standard goodbye for incomplete interactions
			// 			//await handlePlay(callMedia, goodbyePrompt, goodbyeContext);
			// 			await startRecognizing(callMedia, callerId, "", 'GetFreeFormText');
			// 		}
			// 	}
			// } catch (error) {
			// 	console.error("Error handling RecognizeFailed event:", error);
			// }
		}
		else if (event.type === "Microsoft.Communication.CallDisconnected") {
			console.log("Received CallDisconnected event");

			// Reset customer data when call is disconnected
			resetCustomerData();
			console.log("Customer data has been reset for the next call");
		}

	}
	catch (error) {
		//await handlePlay(callMedia, goodbyePrompt, goodbyeContext);
		console.error("Error handling callback event:", error);
	}
});


app.get('/', (req, res) => {
	res.send('Hello ACS CallAutomation!');
});

// Endpoint to serve a SSML-based typing indicator sound for demonstration purposes
app.get('/api/generate-typing-indicator', async (req, res) => {
	try {
		// This endpoint would normally connect to Azure Speech services to generate audio
		// For now, we'll return instructions to manually create and upload the MP3 file
		res.status(200).json({
			message: "Please create a typing indicator MP3 file and place it at public/audio/typing-indicator.mp3",
			ssml: "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='en-US-AriaNeural'>thinking<break time='300ms'/> .<break time='300ms'/> .<break time='300ms'/> .</voice></speak>"
		});
	} catch (error) {
		console.error("Error generating typing indicator:", error);
		res.status(500).json({ error: "Failed to generate typing indicator" });
	}
});

// Start the server
app.listen(PORT, () => {
	console.log(`Server is listening on port ${PORT}`);

	// Validate phone number format before initialization
	if (process.env.AGENT_PHONE_NUMBER) {
		const formattedNumber = formatPhoneNumberForTransfer(process.env.AGENT_PHONE_NUMBER);
		console.log(`Agent phone number: ${process.env.AGENT_PHONE_NUMBER}`);
		console.log(`Formatted for transfer: ${formattedNumber}`);

		// Validate the format with detailed logging
		const phoneRegex = /^\+\d{10,15}$/;
		if (!phoneRegex.test(formattedNumber)) {
			console.warn("WARNING: Agent phone number is not in valid E.164 format.");
			console.warn(`Current format: ${formattedNumber}`);
			console.warn("E.164 format example: +12065551234 (plus sign, country code, number)");
			console.warn("This will likely cause call transfers to fail with code 10129");
			console.warn("Please update your .env file with the proper format and restart the server.");

			// Suggest a possible correct format
			let suggestedFormat = process.env.AGENT_PHONE_NUMBER.replace(/[^\d]/g, '');
			if (suggestedFormat.length === 10) {
				suggestedFormat = "+1" + suggestedFormat; // Add US country code for 10-digit numbers
			} else {
				suggestedFormat = "+" + suggestedFormat; // Add + for other lengths
			}
			console.warn(`Suggested format: ${suggestedFormat}`);
		} else {
			console.log("Agent phone number is in valid E.164 format.");
		}
	} else {
		console.warn("WARNING: Agent phone number is not configured in the environment variables.");
		console.warn("Call transfers to agent will not work. Please add AGENT_PHONE_NUMBER to your .env file.");
	}

	// Initialize clients with proper error handling and detailed status reporting
	console.log("Initializing service clients...");

	// First initialize ACS client as it's the most critical
	createAcsClient()
		.then(() => {
			console.log("✓ ACS client initialized successfully");

			// Then try to initialize the OpenAI client
			return createOpenAiClient()
				.then(() => {
					console.log("✓ Azure OpenAI client initialized successfully");
					// Log OpenAI size limits after successful initialization
					logOpenAiSizeLimits();
				})
				.catch(error => {
					console.error("✗ Azure OpenAI client initialization failed:", error.message);
					console.error("The application may not be able to process language properly.");
					// Try to log limits anyway to help with troubleshooting
					try {
						console.log("Attempting to log size limits for troubleshooting:");
						logOpenAiSizeLimits();
					} catch (e) {
						console.error("Could not log size limits due to error:", e.message);
					}
				});
		})
		.catch(error => {
			console.error("✗ ACS client initialization failed:", error.message);
			console.error("The application will not function correctly without the ACS client.");
		})
		.finally(() => {
			// Finally try to initialize the Email client, but don't block if it fails
			createEmailClient()
				.then(() => {
					console.log("✓ Email client initialized successfully");
				})
				.catch(error => {
					console.error("✗ Email client initialization failed:", error.message);
					console.error("Email notifications will not be available.");
				});
		});
});

// Function to play typing sound indicators while waiting for a response

async function playTypingIndicator(callConnectionMedia: CallMedia): Promise<void> {
	console.log("Using enhanced typing indicator with better error handling");
	return playEnhancedTypingIndicator(callConnectionMedia, TYPING_INDICATOR_AUDIO_URL, TYPING_INDICATOR_CACHE_ID, currentCallVoice);
}

// Function to stop typing indicator sound
function stopTypingIndicator(): void {
	stopEnhancedTypingIndicator();
}

// Check and log the current OpenAI size limits
function logOpenAiSizeLimits(): void {
	console.log('='.repeat(80));
	console.log('OPENAI SIZE LIMITS AND TOKEN INFORMATION');
	console.log('='.repeat(80));

	// Log current configured limits
	console.log('CONFIGURED LIMITS:');
	console.log(`MAX_SYSTEM_PROMPT_LENGTH: ${MAX_SYSTEM_PROMPT_LENGTH} bytes (chars)`);
	console.log(`MAX_USER_PROMPT_LENGTH: ${MAX_USER_PROMPT_LENGTH} bytes (chars)`);
	console.log(`MAX_RESPONSE_LENGTH: ${MAX_RESPONSE_LENGTH} bytes (chars)`);
	console.log(`MAX_RECOGNITION_PROMPT_LENGTH: ${MAX_RECOGNITION_PROMPT_LENGTH} bytes (chars)`);
	console.log(`MAX_SPEECH_INPUT_LENGTH: ${MAX_SPEECH_INPUT_LENGTH} bytes (chars)`);

	// Calculate total input limit
	const totalMaxInput = MAX_SYSTEM_PROMPT_LENGTH + MAX_USER_PROMPT_LENGTH;
	console.log(`Total max input size: ${totalMaxInput} bytes`);

	// Create sample prompts to get better token estimates
	const sampleSystemPrompt = "You are a helpful assistant for trip planning. " + "A".repeat(Math.min(MAX_SYSTEM_PROMPT_LENGTH - 50, 100));
	const sampleUserPrompt = "I need help planning a vacation to Florida next month. " + "B".repeat(Math.min(MAX_USER_PROMPT_LENGTH - 50, 100));

	// Estimate tokens using our improved function
	const estimatedSystemTokens = estimateTokenCount(sampleSystemPrompt);
	const estimatedUserTokens = estimateTokenCount(sampleUserPrompt);
	const totalEstimatedTokens = estimatedSystemTokens + estimatedUserTokens;

	console.log('\nESTIMATED TOKEN USAGE (improved algorithm):');
	console.log(`System prompt: ~${estimatedSystemTokens} tokens`);
	console.log(`User prompt: ~${estimatedUserTokens} tokens`);
	console.log(`Total input: ~${totalEstimatedTokens} tokens`);

	// Also show standard calculation for comparison
	const standardSystemTokens = Math.ceil(MAX_SYSTEM_PROMPT_LENGTH / 4);
	const standardUserTokens = Math.ceil(MAX_USER_PROMPT_LENGTH / 4);
	const standardTotalTokens = standardSystemTokens + standardUserTokens;

	console.log('\nSTANDARD TOKEN ESTIMATE (4 chars/token):');
	console.log(`System prompt: ~${standardSystemTokens} tokens`);
	console.log(`User prompt: ~${standardUserTokens} tokens`);
	console.log(`Standard total estimate: ~${standardTotalTokens} tokens`);

	// Add info about OpenAI model limits
	const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_NAME || 'unknown';
	console.log('\nMODEL INFORMATION:');
	console.log(`Current deployment model: ${deploymentName}`);

	console.log('\nCOMMON TOKEN LIMITS BY MODEL:');
	console.log('- gpt-3.5-turbo: 4,096 tokens (~16KB)');
	console.log('- gpt-4: 8,192 tokens (~32KB)');
	console.log('- gpt-4-32k: 32,768 tokens (~128KB)');

	// Get the appropriate limit for the current model
	let currentModelLimit = 4096; // Default
	if (deploymentName.includes('gpt-3.5')) {
		currentModelLimit = 4096;
	} else if (deploymentName.includes('gpt-4-32k')) {
		currentModelLimit = 32768;
	} else if (deploymentName.includes('gpt-4')) {
		currentModelLimit = 8192;
	}

	// Calculate percentage of limit used by the configuration
	const percentOfLimit = (totalEstimatedTokens / currentModelLimit) * 100;
	console.log(`\nCONFIGURED LIMITS USE APPROXIMATELY ${percentOfLimit.toFixed(1)}% OF YOUR MODEL'S CAPACITY`);

	// Check if current limits might exceed model limits
	if (percentOfLimit > 80) {
		console.log('\nWARNING: Your configured limits are approaching the token limits for your model');
		console.log(`Your configuration may use up to ${percentOfLimit.toFixed(1)}% of available tokens`);
	}
	if (percentOfLimit > 100) {
		console.log('\nCRITICAL WARNING: Your configured limits EXCEED the token limits for your model');
		console.log(`Your configuration may use up to ${percentOfLimit.toFixed(1)}% of available tokens`);
		console.log('You will likely encounter "Invalid Request" errors with these settings');
	}

	console.log('\nNOTE ON TOKEN CALCULATION:');
	console.log('- These are approximate values. Actual token counts may vary by content.');
	console.log('- Non-English languages may use more tokens per character');
	console.log('- Special characters, numbers, and code snippets tokenize differently');
	console.log('- The JSON structure of the request adds additional tokens');
	console.log('- Response tokens also count against your model\'s token limit');

	console.log('\nTROUBLESHOOTING "INVALID REQUEST" ERRORS:');
	console.log('1. If you see "Invalid Request" errors, reduce MAX_SYSTEM_PROMPT_LENGTH and MAX_USER_PROMPT_LENGTH in your .env file');
	console.log('2. Consider using a model with higher token limits if available');
	console.log('3. Make your prompts more concise and remove unnecessary content');
	console.log('4. Remember that the total tokens include both input AND expected output tokens');
	console.log('5. Watch for response token usage in logs to understand your real-world usage patterns');

	console.log('='.repeat(80));
}

// Helper function for diagnosing Azure OpenAI errors in detail
function diagnoseAzureOpenAIError(error: any): string {
	let diagnosis = "Azure OpenAI Error Diagnosis:\n";

	// Check for specific Azure OpenAI error types
	if (error.name === 'AzureOpenAIError') {
		diagnosis += `Error Type: ${error.name}\n`;
		diagnosis += `Error Code: ${error.code || 'Unknown'}\n`;
		diagnosis += `Error Message: ${error.message || 'No message provided'}\n`;

		// Check for token-related errors
		if (error.message?.includes("token") || error.message?.includes("Invalid Request")) {
			diagnosis += "\nThis appears to be a token-related error. The API request likely exceeds the model's token limit.\n";
			diagnosis += "Suggestions:\n";
			diagnosis += "1. Reduce the length of your prompts\n";
			diagnosis += "2. Use a model with higher token limits\n";
			diagnosis += "3. Simplify your request structure\n";
			diagnosis += "4. Check if you're using the correct deployment name\n";
		}

		// Check for authentication errors
		else if (error.message?.includes("authentication") || error.code === "401") {
			diagnosis += "\nThis appears to be an authentication error. Your API key may be invalid or expired.\n";
			diagnosis += "Suggestions:\n";
			diagnosis += "1. Verify your AZURE_OPENAI_SERVICE_KEY environment variable\n";
			diagnosis += "2. Check if your API key has expired\n";
			diagnosis += "3. Confirm that your key has permission to access the deployment\n";
		}

		// Check for quota errors
		else if (error.message?.includes("quota") || error.code === "429") {
			diagnosis += "\nThis appears to be a quota or rate limit error.\n";
			diagnosis += "Suggestions:\n";
			diagnosis += "1. Implement exponential backoff in your retry logic\n";
			diagnosis += "2. Request a quota increase for your Azure OpenAI resource\n";
			diagnosis += "3. Check if you're exceeding your provisioned TPM (tokens per minute) limit\n";
		}
	}
	else {
		// For non-specific Azure OpenAI errors, provide a more general diagnosis
		diagnosis += `Error Type: ${error.constructor?.name || 'Unknown'}\n`;
		diagnosis += `Error Message: ${error.message || 'No message provided'}\n`;

		if (error.message?.includes("Invalid Request")) {
			diagnosis += "\nThis 'Invalid Request' error typically occurs when:\n";
			diagnosis += "1. The request exceeds the model's maximum token limit\n";
			diagnosis += "2. The request contains invalid formatting or parameters\n";
			diagnosis += "3. The model deployment name is incorrect\n";
		}
	}

	return diagnosis;
}

// Helper function for more accurately estimating token counts
function estimateTokenCount(text: string): number {
	if (!text) return 0;

	// More accurate token estimation than simple character count division
	// Average English word is ~4.7 characters, and words are typically ~1.3 tokens
	const words = text.trim().split(/\s+/).length;

	// Count special characters, which tend to be separate tokens
	const specialChars = (text.match(/[^a-zA-Z0-9\s]/g) || []).length;

	// Count numbers, which tend to be separate tokens
	const numbers = (text.match(/\d+/g) || []).length;

	// Base token estimate
	let tokenEstimate = Math.ceil(words * 1.3);

	// Add special characters (as they're often their own tokens)
	tokenEstimate += specialChars * 0.5;

	// Add numbers (as they're typically broken into numeric tokens)
	tokenEstimate += numbers * 0.5;

	// Add overhead for JSON formatting if applicable
	if (text.includes('"role":') || text.includes('"content":')) {
		tokenEstimate += 10; // Approximate overhead for JSON structure
	}

	return Math.ceil(tokenEstimate);
}

// Helper function to log API usage metrics for better diagnostics
function logApiUsageMetrics(requestInfo: {
	systemPromptLength: number,
	userPromptLength: number,
	responseLength: number,
	tokenUsage?: { prompt_tokens?: number, completion_tokens?: number, total_tokens?: number }
}): void {
	const { systemPromptLength, userPromptLength, responseLength, tokenUsage } = requestInfo;

	console.log("API USAGE METRICS:");
	console.log("-----------------");

	// Log sizes in KB for better readability
	const systemPromptKB = (systemPromptLength / 1024).toFixed(2);
	const userPromptKB = (userPromptLength / 1024).toFixed(2);
	const responseLengthKB = (responseLength / 1024).toFixed(2);
	const totalInputKB = ((systemPromptLength + userPromptLength) / 1024).toFixed(2);

	console.log(`System prompt: ${systemPromptLength} bytes (${systemPromptKB} KB)`);
	console.log(`User prompt: ${userPromptLength} bytes (${userPromptKB} KB)`);
	console.log(`Response: ${responseLength} bytes (${responseLengthKB} KB)`);
	console.log(`Total input: ${systemPromptLength + userPromptLength} bytes (${totalInputKB} KB)`);

	// Estimate tokens if actual token usage not provided
	if (!tokenUsage) {
		console.log("\nESTIMATED TOKEN USAGE:");
		const estSystemTokens = estimateTokenCount(Array(systemPromptLength).fill('A').join(''));
		const estUserTokens = estimateTokenCount(Array(userPromptLength).fill('B').join(''));
		const estResponseTokens = estimateTokenCount(Array(responseLength).fill('C').join(''));

		console.log(`System prompt: ~${estSystemTokens} tokens`);
		console.log(`User prompt: ~${estUserTokens} tokens`);
		console.log(`Response: ~${estResponseTokens} tokens`);
		console.log(`Total: ~${estSystemTokens + estUserTokens + estResponseTokens} tokens`);
	} else {
		// Log actual token usage from API response
		console.log("\nACTUAL TOKEN USAGE (from API):");
		console.log(`Prompt tokens: ${tokenUsage.prompt_tokens || 'N/A'}`);
		console.log(`Completion tokens: ${tokenUsage.completion_tokens || 'N/A'}`);
		console.log(`Total tokens: ${tokenUsage.total_tokens || 'N/A'}`);

		// Add model limit context
		const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_NAME || 'unknown';
		let modelLimit = 4096; // Default for gpt-3.5-turbo

		if (deploymentName.includes('gpt-4-32k')) {
			modelLimit = 32768;
		} else if (deploymentName.includes('gpt-4')) {
			modelLimit = 8192;
		}

		if (tokenUsage.total_tokens) {
			const usagePercent = (tokenUsage.total_tokens / modelLimit) * 100;
			console.log(`Usage: ${usagePercent.toFixed(1)}% of ${modelLimit} token limit for ${deploymentName}`);

			// Warn if approaching limits
			if (usagePercent > 80) {
				console.warn(`WARNING: Token usage is at ${usagePercent.toFixed(1)}% of model limit`);
			}
		}
	}

	console.log("-----------------");
}
