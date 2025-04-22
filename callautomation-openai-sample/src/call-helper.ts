import { CallAutomationClient, AnswerCallOptions, AnswerCallResult, CallIntelligenceOptions } from "@azure/communication-call-automation";
import { v4 as uuidv4 } from 'uuid';

/**
 * Enhanced function to answer an incoming call with better error handling and timeouts
 * @param acsClient The Call Automation Client
 * @param incomingCallContext The context from the incoming call
 * @param callerId The caller ID
 * @param cognitiveServiceEndpoint The cognitive services endpoint
 * @param callbackUriBase The base URI for callbacks
 * @returns The answer call result or throws an error
 */
export async function answerIncomingCall(
  acsClient: CallAutomationClient,
  incomingCallContext: string,
  callerId: string,
  cognitiveServiceEndpoint: string,
  callbackUriBase: string
): Promise<AnswerCallResult> {
  
  if (!acsClient) {
    throw new Error("Call Automation Client is not initialized");
  }
  
  if (!incomingCallContext) {
    throw new Error("Missing incoming call context");
  }
  
  if (!cognitiveServiceEndpoint) {
    throw new Error("Missing cognitive service endpoint");
  }
  
  if (!callbackUriBase) {
    throw new Error("Missing callback URI base");
  }
  
  // Generate a unique ID for this call
  const uuid = uuidv4();
  
  // Create callback URI with call ID
  const callbackUri = `${callbackUriBase}/api/callbacks/${uuid}?callerId=${callerId}`;
  
  console.log(`Answering call with callback URI: ${callbackUri}`);
  console.log(`Using cognitive service endpoint: ${cognitiveServiceEndpoint}`);
  
  // Set up call intelligence options
  const callIntelligenceOptions: CallIntelligenceOptions = { 
    cognitiveServicesEndpoint: cognitiveServiceEndpoint 
  };
  
  // Configure answer call options
  const answerCallOptions: AnswerCallOptions = { 
    callIntelligenceOptions: callIntelligenceOptions
  };
  
  // Attempt to answer the call with timeout protection
  try {
    // Use Promise.race to implement a timeout
    return await Promise.race([
      acsClient.answerCall(incomingCallContext, callbackUri, answerCallOptions),
      // 15-second timeout to prevent hanging
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error("Answer call timeout after 15 seconds")), 15000)
      )
    ]);
  } catch (error) {
    console.error("Failed to answer incoming call:", error);
    throw error;
  }
}
