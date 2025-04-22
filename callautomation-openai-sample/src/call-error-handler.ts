// Helper function for handling incoming call errors
export async function handleIncomingCallError(error: any, logPrefix: string = "Error"): Promise<void> {
  console.error(`${logPrefix}: ${error}`);
  
  // Check for specific error types that might indicate connection issues
  const errorStr = error.toString().toLowerCase();
  
  if (errorStr.includes("timeout") || 
      errorStr.includes("connection") || 
      errorStr.includes("network") ||
      errorStr.includes("not found")) {
    console.log("Detected connection/timeout issue in call handling");
  }
  
  // Log detailed error information if available
  if (error.code) {
    console.error(`Error code: ${error.code}`);
  }
  
  if (error.details) {
    console.error(`Error details: ${JSON.stringify(error.details)}`);
  }
}
