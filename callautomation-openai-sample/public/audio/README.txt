# Typing Indicator MP3 File

This directory should contain an MP3 file named `typing-indicator.mp3` that will be used as a typing indicator sound when the AI assistant is processing a response.
The typing mp3 was pulled from the internet at (here)[https://www.chosic.com/download-audio/29271/#google_vignette]
**Shout Out to Chosic** Thank you!

## Requirements

- The file should be named `typing-indicator.mp3`
- Keep the file small (ideally under 1MB) to reduce loading time
- Use a short sound (1-3 seconds) that can be looped
- The sound should indicate to the caller that processing is happening
- Examples: typing sounds, subtle beeps, or "thinking" sounds

## Hosting

For production environments, it's recommended to host the MP3 file on a public blob storage or CDN, and update the `TYPING_INDICATOR_AUDIO_URL` environment variable to point to this location.

## Fallback

If the MP3 file is not available or cannot be played, the system will fall back to using SSML-based audio with pauses and periods to indicate thinking.

## Creating a Custom Typing Indicator

You can create your own typing indicator sound using:
1. Audio editing software (Audacity, Adobe Audition, etc.)
2. Text-to-speech services (Azure Speech Service, etc.)
3. Online sound effect libraries

Place the final file in this directory with the name `typing-indicator.mp3`.
