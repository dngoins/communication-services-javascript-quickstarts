/**
 * Utility functions for the Call Automation sample application
 */

/**
 * Formats a phone number for use in call transfers
 * Ensures the number is in E.164 format (e.g., +12065551234)
 */
export function formatPhoneNumberForTransfer(phoneNumber: string | undefined): string {
  if (!phoneNumber) {
    return "";
  }
  
  // Remove any non-digit characters
  let cleanNumber = phoneNumber.replace(/\D/g, '');
  
  // Handle different formats
  if (cleanNumber.length === 10) {
    // Assume US number without country code
    return "+1" + cleanNumber;
  } else if (cleanNumber.length > 10) {
    // Assume it has a country code
    return "+" + cleanNumber;
  } else {
    // Return as is with a + sign
    return "+" + cleanNumber;
  }
}

/**
 * Processes DTMF (keypad) input from the caller
 * Returns an appropriate response based on the tones pressed
 */
export async function processDtmfInput(tones: string, operationContext?: string): Promise<string> {
  // Default response
  let response = "";
  
  // Basic DTMF handling logic
  if (tones === "1") {
    // User pressed 1 (yes)
    response = "I understand that's a yes. Thank you.";
  } else if (tones === "2") {
    // User pressed 2 (no)
    response = "I understand that's a no. Thank you.";
  } else if (tones.length >= 10) {
    // Likely a phone number
    response = `I've received your phone number. Thank you.`;
  } else {
    // Other DTMF input
    response = `I received your keypad input. Thank you.`;
  }
  
  return response;
}
