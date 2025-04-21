import { config } from 'dotenv';
import express, { Application } from 'express';
import { PhoneNumberIdentifier, createIdentifierFromRawId } from "@azure/communication-common";
import { CallAutomationClient, CallConnection, AnswerCallOptions, CallMedia, TextSource, AnswerCallResult, CallMediaRecognizeSpeechOptions, CallIntelligenceOptions, PlayOptions } from "@azure/communication-call-automation";
import { v4 as uuidv4 } from 'uuid';
import { AzureKeyCredential, OpenAIClient } from '@azure/openai';
config();

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

const answerPromptSystemTemplate = `You are an sales woman designed to gather  information from a potential customer in regards to going on a Wellness retreat to Luxor, Egypt. Your task is to try to sell the idea of going to Luxor. Ask the customer questions and gather information about their needs and preferences. Find out when they want to travel, how long they want to stay, what type of activities they are interested in, and any other relevant information. Obtain their name, email address, and phone number. Once you have those specific details your goal has been reached.
If the sentiment is going well, ask if they have a budget in mind for the trip. If the customer is not interested in traveling to Egypt, ask if they are interested in any other destinations or wellness retreats. Keep your responses short and concise, and avoid using filler words. Ask a couple of questions at a time and wait for the customer's response before moving on to the next couple of questions. If the customer is not responsive, ask them if they need assistance. If they are still unresponsive, politely end the call. Have a friendly and motivating tone and use positive language.`;

const helloPrompt = "'Raw who bat', thank you for calling! Welcome to the House of Royals Wellness Temple. Do you want to travel to Egypt?";
const timeoutSilencePrompt = "I’m sorry, I didn’t hear anything. If you need assistance please let me know how I can help you.";
const goodbyePrompt = "Thank you for calling! I hope I was able to assist you. Have a great day!";
const connectAgentPrompt = "I'm sorry, I was not able to assist you with your request. Let me transfer you to an agent who can help you further. Please hold the line and I'll connect you shortly.";
const callTransferFailurePrompt = "It looks like all I can’t connect you to an agent right now, but we will get the next available agent to call you back as soon as possible.";
const agentPhoneNumberEmptyPrompt = "I’m sorry, we're currently experiencing high call volumes and all of our agents are currently busy. Our next available agent will call you back as soon as possible.";
const EndCallPhraseToConnectAgent = "Sure, please stay on the line. I’m going to transfer you to an agent.";

const transferFailedContext = "TransferFailed";
const connectAgentContext = "ConnectAgent";
const goodbyeContext = "Goodbye";

const agentPhonenumber = process.env.AGENT_PHONE_NUMBER;
const chatResponseExtractPattern = /(?<=: ).*/g;

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
		const play : TextSource = { text: message, voiceName: "en-US-NancyNeural", kind: "textSource"}
		const recognizeOptions: CallMediaRecognizeSpeechOptions = { 
			endSilenceTimeoutInSeconds: 2, 
			playPrompt: play, 
			initialSilenceTimeoutInSeconds: 15, 
			interruptPrompt: true, 
			operationContext: context, 
			kind: "callMediaRecognizeSpeechOptions",
		}; 

		const targetParticipant = createIdentifierFromRawId(callerId);
		await callMedia.startRecognizing(targetParticipant, recognizeOptions);
		console.log(`Started recognizing with context: ${context}`);
	} catch (error) {
		console.error(`Error in startRecognizing: ${error}`);
		// If this fails, we should try to handle the call gracefully
		try {
			if (callMedia) {
				// Try to play an error message and then disconnect
				const errorPlay: TextSource = { 
					text: "I'm sorry, we're experiencing technical difficulties. Please try your call again later.", 
					voiceName: "en-US-NancyNeural", 
					kind: "textSource"
				};
				await callMedia.playToAll([errorPlay]);
			}
		} catch (fallbackError) {
			console.error(`Error in fallback handling: ${fallbackError}`);
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
		const play : TextSource = { text: textToPlay, voiceName: "en-US-NancyNeural", kind: "textSource"}
		const playOptions : PlayOptions = { operationContext: context };
		await callConnectionMedia.playToAll([play], playOptions);
		console.log(`Successfully played message with context: ${context}`);
	} catch (error) {
		console.error(`Error in handlePlay with context ${context}:`, error);
		// Don't rethrow the error to prevent unhandled rejections
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

async function getChatGptResponse(speechInput: string){
	return await getChatCompletions(answerPromptSystemTemplate, speechInput);
}

app.post("/api/incomingCall", async (req: any, res:any)=>{
	console.log(`Received incoming call event - data --> ${JSON.stringify(req.body)} `);
	const event = req.body[0];
	try{
		const eventData = event.data;
		if (event.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
			console.log("Received SubscriptionValidation event");
			res.status(200).json({
				validationResponse: eventData.validationCode,
			});

			return;
		}

		callerId = eventData.from.rawId;
		const uuid = uuidv4();
		const callbackUri = `${process.env.CALLBACK_URI}/api/callbacks/${uuid}?callerId=${callerId}`;
		const incomingCallContext = eventData.incomingCallContext;
		console.log(`Cognitive service endpoint:  ${process.env.COGNITIVE_SERVICE_ENDPOINT.trim()}`);
		const callIntelligenceOptions: CallIntelligenceOptions = { cognitiveServicesEndpoint: process.env.COGNITIVE_SERVICE_ENDPOINT };
		const answerCallOptions: AnswerCallOptions = { callIntelligenceOptions: callIntelligenceOptions }; 
		answerCallResult = await acsClient.answerCall(incomingCallContext, callbackUri, answerCallOptions);
		callConnection = answerCallResult.callConnection;
		callMedia = callConnection.getCallMedia();
	}
	catch(error){
		console.error("Error during the incoming call event.", error);
	}
});

app.post('/api/callbacks/:contextId', 
	async (req:any, res:any) => 
	{
	// Send response immediately to prevent timeouts
	res.status(200).send('Event received');
	
	try 
	{
		const contextId = req.params.contextId;
		
		// Check if req.body exists and is an array with at least one element
		if (!req.body || !Array.isArray(req.body) || req.body.length === 0) 
		{
			console.error("Invalid callback event body:", req.body);
			return;
		}
		
		const event = req.body[0];
		if (!event || !event.data) 
		{
			console.error("Event or event data is missing:", event);
			return;
		}
		
		const eventData = event.data;
		console.log(`Received callback event - data --> ${JSON.stringify(req.body)} `);
		console.log(`event type: ${event.type}`);

		if(event.type === "Microsoft.Communication.CallConnected")
		{
			console.log("Received CallConnected event");
			await startRecognizing(callMedia, callerId, helloPrompt, 'GetFreeFormText');
		}
		else if(event.type === "Microsoft.Communication.PlayCompleted")
		{
			console.log("Received PlayCompleted event");
			
			if(eventData.operationContext && ( eventData.operationContext === transferFailedContext 
				 || eventData.operationContext === goodbyeContext )) 
				{
					console.log("Disconnecting the call");
					await hangUpCall().catch(error => console.error("Error hanging up call:", error));
				}
			else if(eventData.operationContext === connectAgentContext) 
			{
				if(!agentPhonenumber)
				{
					console.log("Agent phone number is empty.");
					await handlePlay(callMedia, agentPhoneNumberEmptyPrompt, transferFailedContext);
				}
				else
				{
					try 
					{
						console.log("Initiating the call transfer.");
						const phoneNumberIdentifier: PhoneNumberIdentifier = { phoneNumber: agentPhonenumber };
						const result = await callConnection.transferCallToParticipant(phoneNumberIdentifier);
						console.log("Transfer call initiated");
					} 
					catch (transferError) 
					{
						console.error("Error transferring call:", transferError);
						await handlePlay(callMedia, callTransferFailurePrompt, transferFailedContext)
							.catch(playError => console.error("Error playing transfer failure message:", playError));
					}
				}
			}
		}
		else if(event.type === "Microsoft.Communication.playFailed")
		{
			console.log("Received PlayFailed event");
			await hangUpCall().catch(error => console.error("Error hanging up call:", error));
		}
		else if(event.type === "Microsoft.Communication.callTransferAccepted")
		{
			console.log("Call transfer accepted event received");
		}
		else if(event.type === "Microsoft.Communication.callTransferFailed")
		{
			console.log("Call transfer failed event received");
			var resultInformation = eventData.resultInformation;
			console.log("Encountered error during call transfer, message=%s, code=%s, subCode=%s", resultInformation?.message, resultInformation?.code, resultInformation?.subCode);
			await handlePlay(callMedia, callTransferFailurePrompt, transferFailedContext)
				.catch(error => console.error("Error playing transfer failure message:", error));
		}
		else if(event.type === "Microsoft.Communication.RecognizeCompleted")
		{
			if(eventData.recognitionType === "speech")
			{
				const speechText = eventData.speechResult.speech;
				if(speechText !== '')
				{
					console.log(`Recognized speech: ${speechText}`);
					
					// if(await detectEscalateToAgentIntent(speechText)){
					// 	handlePlay(callMedia, EndCallPhraseToConnectAgent, connectAgentContext);
					// }
					//else
					//	{
						const chatGptResponse = await getChatGptResponse(speechText);
						//console.log("Chat GPT response: %s", chatGptResponse);

						// const match = chatGptResponse.match(chatResponseExtractPattern);
						// console.log(match);
						// if(match){
						// 	console.log("Chat GPT Answer=%s, Sentiment Rating=%s, Intent=%s, Category=%s",
						// 	match[0], match[1], match[2], match[3]);
						// 	const score = getSentimentScore(match[1].trim());
						// 	console.log("score=%s", score)
						// 	if(score > -1 && score < 5){
						// 		handlePlay(callMedia, connectAgentPrompt, connectAgentContext);
						// 	}
						//	else{
							//handlePlay(callMedia, chatGptResponse, goodbyeContext);
							await startRecognizing(callMedia, callerId, chatGptResponse, 'GetFreeFormText');
						//}
					//}
				}
			}
		}		
		else if(event.type === "Microsoft.Communication.RecognizeFailed") 
		{
			try 
			{
				const resultInformation = eventData.resultInformation;
				var code = resultInformation.subCode;
				if(code === 8510 && maxTimeout > 0){
					maxTimeout--;
					await startRecognizing(callMedia, callerId, timeoutSilencePrompt, 'GetFreeFormText');
				}
				else{
					await handlePlay(callMedia, goodbyePrompt, goodbyeContext);
				}
			} 
			catch (error) {
				console.error("Error handling RecognizeFailed event:", error);
			}
		} 
		else if(event.type === "Microsoft.Communication.CallDisconnected")
		{
			console.log("Received CallDisconnected event");
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
