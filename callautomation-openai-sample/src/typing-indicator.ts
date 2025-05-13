// This file contains our enhanced typing indicator implementation
import { CallMedia, PlayOptions, FileSource, TextSource } from "@azure/communication-call-automation";

// Variables to track and control typing sound playback
let typingSoundPlaying: boolean = false;
let stopTypingSound: boolean = false;

/**
 * Plays a typing indicator sound to the caller while waiting for a response
 * Will try to use MP3 file first, then fall back to SSML if that fails
 * 
 * @param callConnectionMedia The call media object
 * @param audioUrl URL of the MP3 file to play
 * @param cacheId Cache ID for the audio file
 * @param voiceName Voice name to use for SSML fallback
 * @returns Promise that resolves when typing sound stops
 */
export async function playEnhancedTypingIndicator(
  callConnectionMedia: CallMedia, 
  audioUrl: string,
  cacheId: string,
  voiceName: string
): Promise<void> {
  // Check if we're already playing - this prevents overlapping indicators
  if (typingSoundPlaying) {
    console.log("Typing indicator already playing, stopping previous one first");
    stopEnhancedTypingIndicator();
    await new Promise(resolve => setTimeout(resolve, 100)); // Brief pause to ensure cleanup
  }

  // Set the flags to indicate we're playing typing sounds
  typingSoundPlaying = true;
  stopTypingSound = false;
  
  // Track whether to use SSML fallback after MP3 failure
  let useSSMLFallback = false;
  
  try {
    console.log(`Starting enhanced typing indicator with audio URL: ${audioUrl}`);
    
    // Continue playing typing indicators until stopped - check both flags
    while (typingSoundPlaying && !stopTypingSound) {
      // Immediate check for stop flag at start of loop
      if (stopTypingSound) {
        console.log("Stop flag detected at start of loop, breaking out");
        break;
      }
      
      let playSource;
      
      if (!useSSMLFallback) {
        // Try using MP3 file first
        playSource = { 
          url: audioUrl,
          playsourcacheid: cacheId,
          kind: "fileSource" as const
        };
      } else {
        // Fallback to SSML if MP3 fails
        playSource = { 
          ssmlText: `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voiceName}'>thinking<break time='300ms'/> .<break time='300ms'/> .<break time='300ms'/> .</voice></speak>`, 
          kind: "ssmlSource" as const
        };
      }
      
      const playOptions: PlayOptions = { 
        operationContext: "TypingIndicator"
      };
      
      // Check stop flag again right before playing
      if (stopTypingSound) {
        console.log("Stop flag detected before playToAll, breaking out");
        break;
      }
      
      // Play the typing indicator with a timeout to prevent getting stuck
      try {
        // Add timeout protection to prevent infinite wait if service hangs
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Typing indicator play timeout")), 5000);
        });
        
        // Race the playback against the timeout
        await Promise.race([
          callConnectionMedia.playToAll([playSource], playOptions),
          timeoutPromise
        ]);
        
        // Check stop flag immediately after playing completes
        if (stopTypingSound) {
          console.log("Stop flag detected after playToAll completed, breaking out");
          break;
        }
      } catch (error) {
        console.error("Error playing typing indicator:", error);
        
        // Check if the error was our timeout
        if (error.message === "Typing indicator play timeout") {
          console.log("Playback timed out, checking stop flag");
          if (stopTypingSound) {
            console.log("Stop flag detected during timeout, breaking out");
            break;
          }
          // Continue to next iteration if we're not stopping
          continue;
        }
        
        // Check for specific error conditions that would indicate audio file issues
        const errorStr = error.toString().toLowerCase();
        const isFileAccessError = errorStr.includes("access") || 
                                  errorStr.includes("not found") || 
                                  errorStr.includes("404") ||
                                  errorStr.includes("403") ||
                                  errorStr.includes("unauthorized") ||
                                  errorStr.includes("denied");
        
        if (!useSSMLFallback && isFileAccessError) {
          // If MP3 file access failed, switch to SSML fallback
          console.log(`Switching to SSML fallback for typing indicator. MP3 URL was: ${audioUrl}`);
          useSSMLFallback = true;
          continue;
        }
        
        // For other errors, stop the typing sound loop
        console.log("Setting stop flag due to playback error");
        stopTypingSound = true;
        break;
      }
      
      // Short pause between indicators if we're still supposed to be playing
      if (!stopTypingSound) {
        // Use a polling approach to check stop flag during the pause
        const pauseStartTime = Date.now();
        let pauseComplete = false;
        
        while (!pauseComplete && !stopTypingSound) {
          // Check if we've waited long enough
          if (Date.now() - pauseStartTime >= 100) {
            pauseComplete = true;
          } else {
            // Small sleep to avoid tight loop
            await new Promise(resolve => setTimeout(resolve, 10));
            
            // Recheck stop flag
            if (stopTypingSound) {
              console.log("Stop flag detected during pause, breaking out");
              break;
            }
          }
        }
        
        // If stop was requested during pause, break out of main loop too
        if (stopTypingSound) {
          break;
        }
      }
    }
    
    console.log(`Exited typing indicator play loop. typingSoundPlaying=${typingSoundPlaying}, stopTypingSound=${stopTypingSound}`);
  } catch (error) {
    console.error("Error in typing indicator loop:", error);
  } finally {
    // Reset the flags when we're done - ensure we're fully stopped
    typingSoundPlaying = false;
    stopTypingSound = true;
    console.log("Enhanced typing indicator playback fully stopped in finally block");
  }
}

/**
 * Function to stop the typing indicator sound
 * This function now forcefully sets both flags to ensure the loop exits immediately
 */
export function stopEnhancedTypingIndicator(): void {
  // Set both flags to ensure the loop exits from any point
  stopTypingSound = true;
  typingSoundPlaying = false;
  console.log("Forcefully stopping enhanced typing indicator with both flags set");
}
