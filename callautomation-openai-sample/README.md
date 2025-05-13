|page_type|languages|products
|---|---|---|
|sample|<table><tr><td>Typescript</tr></td></table>|<table><tr><td>azure</td><td>azure-communication-services</td></tr></table>|

# Call Automation - Quick Start Sample

This sample application shows how the Azure Communication Services - Call Automation SDK can be used with Azure OpenAI Service to enable intelligent conversational agents. It answers an inbound call, does a speech recognition with the recognize API and Cognitive Services, uses OpenAi Services with the input speech and responds to the caller through Cognitive Services' Text to Speech. This sample application configured for accepting input speech until the caller terminates the call or a long silence is detected

## Prerequisites

- Create an Azure account with an active subscription. For details, see [Create an account for free](https://azure.microsoft.com/free/)
- [Visual Studio Code](https://code.visualstudio.com/download) installed
- [Node.js](https://nodejs.org/en/download) installed
- Create an Azure Communication Services resource. For details, see [Create an Azure Communication Resource](https://docs.microsoft.com/azure/communication-services/quickstarts/create-communication-resource). You will need to record your resource **connection string** for this sample.
- Get a phone number for your new Azure Communication Services resource. For details, see [Get a phone number](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/telephony/get-phone-number?tabs=windows&pivots=programming-language-csharp)
- Create Azure AI Multi Service resource. For details, see [Create an Azure AI Multi service](https://learn.microsoft.com/en-us/azure/cognitive-services/cognitive-services-apis-create-account).
- An Azure OpenAI Resource and Deployed Model. See [instructions](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/create-resource?pivots=web-portal).

## Before running the sample for the first time

1. Open an instance of PowerShell, Windows Terminal, Command Prompt or equivalent and navigate to the directory that you would like to clone the sample to.
2. git clone `https://github.com/Azure-Samples/communication-services-javascript-quickstarts.git`.
3. cd into the `callautomation-openai-sample` folder.
4. From the root of the above folder, and with node installed, run `npm install`

### Setup and host your Azure DevTunnel

[Azure DevTunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started?tabs=windows) is an Azure service that enables you to share local web services hosted on the internet. Use the commands below to connect your local development environment to the public internet. This creates a tunnel with a persistent endpoint URL and which allows anonymous access. We will then use this endpoint to notify your application of calling events from the ACS Call Automation service.

```bash
devtunnel create --allow-anonymous
devtunnel port create -p 8080
devtunnel host
```
### Add a Managed Identity to the ACS Resource that connects to the Cognitive Services Resource

Follow the instructions in the [documentation](https://learn.microsoft.com/en-us/azure/communication-services/concepts/call-automation/azure-communication-services-azure-cognitive-services-integration).

### Configuring application

Open the `.env` file to configure the following settings

1. `CONNECTION_STRING`: Azure Communication Service resource's connection string.
2. `CALLBACK_URI`: Base url of the app. (For local development replace the dev tunnel url)
3. `COGNITIVE_SERVICE_ENDPOINT`: Azure Cognitive Service endpoint
4. `AZURE_OPENAI_SERVICE_KEY`: Azure Open AI service key
5. `AZURE_OPENAI_SERVICE_ENDPOINT`: Azure Open AI endpoint
6. `AZURE_OPENAI_DEPLOYMENT_MODEL_NAME`: Azure Open AI deployment name
6. `AGENT_PHONE_NUMBER`: Agent phone number to transfer the call to resolve queries

## Features

- Call Automation to answer and handle inbound calls
- Speech recognition to understand caller input
- Azure OpenAI integration for natural language processing
- Text to Speech for responding to callers
- Azure Communication Services Email for sending confirmation emails
- DTMF (Dual-Tone Multi-Frequency) handling for keypad inputs
- Error handling and reporting
- Technical difficulty tracking

## DTMF Functionality

This sample includes comprehensive DTMF (touchtone keypad) support for callers:

- Press `0` at any time to be transferred to a live agent
- Press `1` for "yes" responses
- Press `2` for "no" responses
- Enter a phone number directly using the keypad followed by `#`
- Enter dates in MMDD or MMDDYYYY format
- Enter numeric information such as duration of stay

The application will detect these inputs and respond appropriately, making it easier for callers to interact with the system without needing to speak.

## Configuration

This sample requires the following environment variables to be set in a `.env` file:

### Azure Communication Services

- CONNECTION_STRING: Your Azure Communication Services resource connection string
- CALLBACK_URI: The URI for callbacks from the service
- AGENT_PHONE_NUMBER: Phone number for agent transfers

### Azure OpenAI

- AZURE_OPENAI_SERVICE_ENDPOINT: Your Azure OpenAI service endpoint
- AZURE_OPENAI_SERVICE_KEY: Your Azure OpenAI service key
- AZURE_OPENAI_DEPLOYMENT_MODEL_NAME: Your Azure OpenAI deployed model name

### Cognitive Services

- COGNITIVE_SERVICE_ENDPOINT: Your Azure Cognitive Services endpoint

### Email Configuration

- ACS_SENDER_EMAIL: Your verified sender email address from Azure Communication Services
- TOURDL_EMAIL: The recipient email address

### Audio Configuration

- TYPING_INDICATOR_AUDIO_URL: URL to the MP3 file for typing indicator sound (optional)

## Audio Typing Indicators

This sample supports playing MP3 files as typing indicators while the AI is processing a response. This provides a better user experience than silence or SSML-based sounds.

To use this feature:
1. Place an MP3 file named `typing-indicator.mp3` in the `public/audio/` directory
2. Configure the `TYPING_INDICATOR_AUDIO_URL` environment variable (defaults to `{CALLBACK_URI}/audio/typing-indicator.mp3`)
3. The system will automatically use this MP3 file when indicating that the AI is processing

If the MP3 file cannot be accessed or played, the system will automatically fall back to the SSML-based typing indicator.

## Email Functionality

This sample uses Azure Communication Services Email to send confirmations and technical difficulty notifications. The email functionality is implemented in two functions:

1. `sendCustomerDataEmail`: Sends a formatted email to both admin and customer with booking details
2. `sendTechnicalDifficultyEmail`: Sends a notification to admin when technical difficulties occur

### Run app locally

1. Open a new Powershell window, cd into the `callautomation-openai-sample` folder and run `npm run dev`
2. Browser should pop up with the below page. If not navigate it to `http://localhost:8080/`
3. Register an EventGrid Webhook for the IncomingCall Event that points to your DevTunnel URI. Instructions [here](https://learn.microsoft.com/en-us/azure/communication-services/concepts/call-automation/incoming-call-notification).

Once that's completed you should have a running application. The best way to test this is to place a call to your ACS phone number and talk to your intelligent agent.
