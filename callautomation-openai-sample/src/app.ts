import { config } from 'dotenv';
import express, { Application } from 'express';
import { PhoneNumberIdentifier, createIdentifierFromRawId } from "@azure/communication-common";
import { CallAutomationClient, CallConnection, AnswerCallOptions, CallMedia, TextSource, AnswerCallResult, CallMediaRecognizeSpeechOptions, CallMediaRecognizeDtmfOptions, CallIntelligenceOptions, PlayOptions, DtmfTone } from "@azure/communication-call-automation";
import { v4 as uuidv4 } from 'uuid';
import { AzureKeyCredential, OpenAIClient } from '@azure/openai';
import * as nodemailer from 'nodemailer';
config( {override: true} );

const PORT = process.env.PORT;
const app: Application = express();
app.use(express.json());

let callConnectionId: string;
let callConnection: CallConnection;
let acsClient: CallAutomationClient;
let openAiClient : OpenAIClient;
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

const answerPromptSystemTemplate = `You are a sales agent designed to gather information from a potential customer regarding a Wellness retreat to Luxor, Egypt. Your task is to try to sell the idea of going to Luxor for Egypt's mysterious ancient history, the customer's health and peace of mind. Ask the customer questions and gather information about their needs and preferences. Find out when they want to travel, how long they want to stay, what type of activities they are interested in, and any other relevant customer contact information.

When you need to collect their phone number, explicitly ask if they would like to use the number they're currently calling from as their contact number. If they say yes or agree in any way, tell them that you'll record their current number and they don't need to provide it.

If the sentiment is going well, ask if they have a budget in mind for the trip. If the customer is not interested in traveling to Egypt, ask if they are interested in any other destinations or wellness retreats. Keep your responses short and concise, and avoid using filler words. Ask a couple of questions at a time and wait for the customer's response before moving on to the next couple of questions. If the customer is not responsive, ask them if they need assistance. If they are still unresponsive, politely end the call. Have a friendly and motivating tone and use positive language.

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

const helloPrompt = "'Raw who bat', thank you for calling! Welcome to the House of Royals Wellness Temple. Do you want to travel to Egypt? You can speak your answers or enter them using your phone keypad. Press 0 at any time to transfer to a human agent.";
const timeoutSilencePrompt = "I'm sorry, I didn't hear anything. If you need assistance please let me know how I can help you.";
const goodbyePrompt = "Thank you for calling! I hope I was able to assist you. Have a great day!";
const connectAgentPrompt = "I'm sorry, I was not able to assist you with your request. Let me transfer you to an agent who can help you further. Please hold the line and I'll connect you shortly.";
const callTransferFailurePrompt = "It looks like all I can't connect you to an agent right now, but we will get the next available agent to call you back as soon as possible.";
const agentPhoneNumberEmptyPrompt = "I'm sorry, we're currently experiencing high call volumes and all of our agents are currently busy. Our next available agent will call you back as soon as possible.";
const EndCallPhraseToConnectAgent = "Sure, please stay on the line. I'm going to transfer you to an agent.";

const transferFailedContext = "TransferFailed";
const connectAgentContext = "ConnectAgent";
const goodbyeContext = "Goodbye";

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
let currentCallVoice = "en-US-NancyNeural"; // Default voice

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
	// Create email transporter
	const transporter = nodemailer.createTransport({
	  host: process.env.SMTP_SERVER,
	  port: parseInt(process.env.SMTP_PORT || '587'),
	  secure: false, // true for 465, false for other ports
	  auth: {
		user: process.env.SMTP_EMAIL,
		pass: process.env.SMTP_PASSWORD,
	  },
	});

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
	`;    // Send email
	const info = await transporter.sendMail({
	  from: `"House of Royals Wellness Temple" <${process.env.SMTP_EMAIL}>`,
	  to: process.env.TOURDL_EMAIL, // Use environment variable only
	  cc: customerData.email !== "unknown" ? customerData.email : undefined, // Only CC if we have a valid email
	  subject: `New Wellness Retreat Inquiry - ${customerData.customerName} on - ${customerData.travelDate}`,
	  html: emailBody,
	});

	console.log(`Email sent: ${info.messageId}`);
	return true;
  } catch (error) {
	console.error("Error sending email:", error);
	return false;
  }
}

// Send email when technical difficulties occur
async function sendTechnicalDifficultyEmail(): Promise<boolean> {
  try {
	// Create email transporter
	const transporter = nodemailer.createTransport({
	  host: process.env.SMTP_SERVER,
	  port: parseInt(process.env.SMTP_PORT || '587'),
	  secure: false, // true for 465, false for other ports
	  auth: {
		user: process.env.SMTP_EMAIL,
		pass: process.env.SMTP_PASSWORD,
	  },
	});

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

	// Send email to tour registration email only (no CC to customer)
	const info = await transporter.sendMail({
	  from: `"House of Royals Wellness Temple" <${process.env.SMTP_EMAIL}>`,
	  to: process.env.TOURDL_EMAIL, // Only send to tour registration, not to the customer
	  subject: `Technical Difficulty - Call from ${customerData.calledFromNumber}`,
	  html: emailBody,
	});

	console.log(`Technical difficulty email sent: ${info.messageId}`);
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
	const openAiServiceEndpoint = process.env.AZURE_OPENAI_SERVICE_ENDPOINT || "";
	const openAiKey = process.env.AZURE_OPENAI_SERVICE_KEY || "";
	openAiClient = new OpenAIClient(
		openAiServiceEndpoint, 
		new AzureKeyCredential(openAiKey)
	  );
	console.log("Initialized Open Ai Client.");
}

async function hangUpCall() {
	try {
		await callConnection.hangUp(true);
		console.log("Call hung up successfully");
	} catch (error) {
		console.error("Error hanging up call:", error);
	}
}

async function startRecognizing(callMedia: CallMedia, callerId: string, message: string, context: string){
	try {
		const play : TextSource = { text: message, voiceName: currentCallVoice, kind: "textSource"}
		const recognizeOptions: CallMediaRecognizeSpeechOptions = {
			endSilenceTimeoutInSeconds: 2,
			playPrompt: play,
			initialSilenceTimeoutInSeconds: 15,
			interruptPrompt: true,
			operationContext: context,
			kind: "callMediaRecognizeSpeechOptions",
		};
		const dtmfOptions: CallMediaRecognizeDtmfOptions = {
			maxTonesToCollect: 20,
			interToneTimeoutInSeconds: 5000,
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
	} catch (error) {		
		console.error(`Error in startRecognizing: ${error}`);
		technicalDifficultiesCount++; // Increment the technical difficulties counter
		console.log(`Technical difficulties count: ${technicalDifficultiesCount}`);
		
		// If this is the third technical difficulty, end the call
		if (technicalDifficultiesCount >= 3) {
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
						voiceName: "en-US-NancyNeural", 
						kind: "textSource"
					};
					
					// Use a promise with a timeout to ensure the call gets hung up even if playToAll fails
					try {
						await Promise.race([
							callMedia.playToAll([finalMessage]),
							new Promise((_, reject) => setTimeout(() => reject(new Error("Play timeout")), 10000))
						]);
					} catch (playError) {
						console.error(`Error playing final message: ${playError}`);
					}
					
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
					voiceName: "en-US-NancyNeural", 
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
		} catch (fallbackError) {
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
						voiceName: "en-US-NancyNeural", 
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

function getSentimentScore(sentimentScore: string){
	const pattern = /(\d)+/g;
	const match = sentimentScore.match(pattern);
	return match ? parseInt(match[0]): -1;
}

async function handlePlay(callConnectionMedia:CallMedia, textToPlay: string, context: string){
	try {
		// Split long messages into manageable chunks to prevent timeouts
		const messageChunks = splitLongMessage(textToPlay);
		
		if (messageChunks.length === 1) {
			// Single chunk - proceed normally
			const play: TextSource = { text: textToPlay, voiceName: "en-US-NancyNeural", kind: "textSource" };
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
					voiceName: "en-US-NancyNeural", 
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
					console.error(`Error playing chunk ${i+1}/${messageChunks.length}: ${chunkError}`);
					
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

async function detectEscalateToAgentIntent(speechInput:string) {
	return hasIntent(speechInput, "talk to agent");
}

async function hasIntent(userQuery: string, intentDescription: string){
	const systemPrompt = "You are a helpful assistant";
	const userPrompt = `In 1 word: does ${userQuery} have similar meaning as ${intentDescription}?`;
	const result = await getChatCompletions(systemPrompt, userPrompt);
	var isMatch = result.toLowerCase().startsWith("yes");
	console.log("OpenAI results: isMatch=%s, customerQuery=%s, intentDescription=%s", isMatch, userQuery, intentDescription);
	return isMatch;
}

async function getChatCompletions(systemPrompt: string, userPrompt: string){
	try {
		const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_NAME;
		const messages = [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: userPrompt },
		];

		const response = await openAiClient.getChatCompletions(deploymentName, messages);
		const responseContent = response.choices[0].message.content;
		console.log(responseContent);
		return responseContent;
	} catch (error) {
		console.error("Error in getChatCompletions:", error);
		// Return a fallback response to prevent null/undefined errors
		return "I apologize, but I'm having trouble processing your request right now.";
	}
}

function updateCustomerDataFromResponse(response: string): void {
	try {
		// Extract JSON between DATA_START and DATA_END
		const dataMatch = response.match(/DATA_START\s*({[\s\S]*?})\s*DATA_END/);
		
		if (dataMatch && dataMatch[1]) {
			const extractedData = JSON.parse(dataMatch[1]);
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
		} else {
			console.log("No customer data found in the response");
		}
	} catch (error) {
		console.error("Error updating customer data:", error);
	}
}

function extractConversationalResponse(fullResponse: string): string {
	// If there's no DATA_START marker, return the full response
	if (!fullResponse.includes("DATA_START")) {
		return fullResponse;
	}
	
	// Otherwise return only the part before DATA_START
	return fullResponse.split("DATA_START")[0].trim();
}

async function getChatGptResponse(speechInput: string){
	// Pass the current customer data to ensure continuity between responses
	const systemPromptWithData = `${answerPromptSystemTemplate}

Current customer data:
DATA_START
${JSON.stringify(customerData, null, 2)}
DATA_END`;
	
	const response = await getChatCompletions(systemPromptWithData, speechInput);
	
	// Extract and update customer data from the response
	updateCustomerDataFromResponse(response);
	
	// Return only the conversational part (before DATA_START)
	const conversationalResponse = extractConversationalResponse(response);
	return conversationalResponse;
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
  // Maximum length for a single response (characters)
  const maxChunkLength = 1000;
  
  if (message.length <= maxChunkLength) {
	return [message];
  }
  
  const chunks: string[] = [];
  
  // Try to split on sentences to maintain natural pauses
  const sentences = message.match(/[^.!?]+[.!?]+/g) || [];
  
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
			wordChunk += ' ' + word;
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
  maxTimeout = 2;
  
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

app.post("/api/incomingCall", async (req: any, res:any)=>{
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
	catch(error){
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

app.post('/api/callbacks/:contextId', async (req:any, res:any) => {
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

		if(event.type === "Microsoft.Communication.CallConnected"){
			console.log("Received CallConnected event");
			await startRecognizing(callMedia, callerId, helloPrompt, 'GetFreeFormText');
		}
		else if(event.type === "Microsoft.Communication.PlayCompleted"){
			console.log("Received PlayCompleted event");
			
			if(eventData.operationContext && ( eventData.operationContext === transferFailedContext 
				 || eventData.operationContext === goodbyeContext )) {
					console.log("Disconnecting the call");
					await hangUpCall().catch(error => console.error("Error hanging up call:", error));
			}
			else if(eventData.operationContext === connectAgentContext) {
				if(!agentPhonenumber){
					console.log("Agent phone number is empty.");
					await handlePlay(callMedia, agentPhoneNumberEmptyPrompt, transferFailedContext);
				}
				else{
					try {
						console.log("Initiating the call transfer.");
						const phoneNumberIdentifier: PhoneNumberIdentifier = { phoneNumber: agentPhonenumber };
						const result = await callConnection.transferCallToParticipant(phoneNumberIdentifier);
						console.log("Transfer call initiated");
					} catch (transferError) {
						console.error("Error transferring call:", transferError);
						await handlePlay(callMedia, callTransferFailurePrompt, transferFailedContext)
							.catch(playError => console.error("Error playing transfer failure message:", playError));
					}
				}
			}
		}
		else if(event.type === "Microsoft.Communication.playFailed"){
			console.log("Received PlayFailed event");
			await hangUpCall().catch(error => console.error("Error hanging up call:", error));
		}
		else if(event.type === "Microsoft.Communication.callTransferAccepted"){
			console.log("Call transfer accepted event received");
		}
		else if(event.type === "Microsoft.Communication.callTransferFailed"){
			console.log("Call transfer failed event received");
			var resultInformation = eventData.resultInformation;
			console.log("Encountered error during call transfer, message=%s, code=%s, subCode=%s", resultInformation?.message, resultInformation?.code, resultInformation?.subCode);
			await handlePlay(callMedia, callTransferFailurePrompt, transferFailedContext)
				.catch(error => console.error("Error playing transfer failure message:", error));
		}		else if(event.type === "Microsoft.Communication.RecognizeCompleted"){
			if(eventData.recognitionType === "speech"){
				const speechText = eventData.speechResult.speech;
				if(speechText !== ''){
					console.log(`Recognized speech: ${speechText}`);
					
					// Check if the user wants to record their calling number
					// if(await wantsToRecordCallingNumber(speechText)) {
					// 	console.log("User wants to record their calling number");
						
					// 	// Extract the phone number from the call data
					// 	if(callerId) {
					// 		// Format the phone number (removing any prefixes like "tel:")
					// 		const formattedNumber = callerId.replace('tel:', '');
							
					// 		// Update the customer data with the calling number
					// 		customerData.phoneNumber = formattedNumber;
							
					// 		// Let the user know we've recorded their number
					// 		const confirmationMessage = `I've recorded your phone number ${formattedNumber}. Thank you! Now, let's continue with your wellness retreat planning.`;
					// 		await startRecognizing(callMedia, callerId, confirmationMessage, 'GetFreeFormText');
					// 		return;
					// 	}
					// }
					
					// Normal flow continues if not recording phone number
					const chatGptResponse = await getChatGptResponse(speechText);
					await startRecognizing(callMedia, callerId, chatGptResponse, 'GetFreeFormText');
				}
			}
		}		else if(event.type === "Microsoft.Communication.RecognizeFailed") {
			try {
				const resultInformation = eventData.resultInformation;
				var code = resultInformation.subCode;
				if(code === 8510 && maxTimeout > 0){
					maxTimeout--;
					await startRecognizing(callMedia, callerId, timeoutSilencePrompt, 'GetFreeFormText');
				}
				else{
					// Check if we have all required data before ending the call
					if (isAllRequiredDataCollected()) {
						// Use personalized goodbye message for customers who provided all necessary info
						const personalizedGoodbye = createPersonalizedGoodbyeMessage();
						await handlePlay(callMedia, personalizedGoodbye, goodbyeContext);
					} else {
						// Use standard goodbye for incomplete interactions
						await handlePlay(callMedia, goodbyePrompt, goodbyeContext);
					}
				}
			} catch (error) {
				console.error("Error handling RecognizeFailed event:", error);
			}
		}else if(event.type === "Microsoft.Communication.CallDisconnected"){
			console.log("Received CallDisconnected event");
			
			// Reset customer data when call is disconnected
			resetCustomerData();
			console.log("Customer data has been reset for the next call");
		}
		
	}
	catch (error) {
		console.error("Error handling callback event:", error);
	}
});


app.get('/', (req, res) => {
	res.send('Hello ACS CallAutomation!');
});

// Start the server
app.listen(PORT, () => {
	console.log(`Server is listening on port ${PORT}`);
	
	// Initialize clients with proper error handling
	Promise.all([createAcsClient(), createOpenAiClient()])
		.then(() => {
			console.log("All clients initialized successfully");
		})
		.catch(error => {
			console.error("Error initializing clients:", error);
		});
});
