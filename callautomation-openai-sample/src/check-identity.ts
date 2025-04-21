import { config } from 'dotenv';
import { CallAutomationClient } from "@azure/communication-call-automation";
config();

async function checkConfiguration() {
    try {
        const connectionString = process.env.CONNECTION_STRING || "";
        const cognitiveServicesEndpoint = process.env.COGNITIVE_SERVICE_ENDPOINT || "";
        
        console.log("Checking ACS Client configuration...");
        console.log(`Connection String: ${connectionString.substring(0, 20)}...`);
        console.log(`Cognitive Services Endpoint: ${cognitiveServicesEndpoint}`);
        
        const acsClient = new CallAutomationClient(connectionString);
        
        // Test if the client can be initialized properly
        console.log("ACS Client initialized successfully.");
        
        // If we made it here, the ACS client was initialized - that doesn't guarantee the managed identity is set up correctly
        console.log("NOTE: To verify full integration with Cognitive Services, ensure the managed identity is properly configured in Azure portal.");
        console.log("Please follow these steps:");
        console.log("1. Go to your Azure Communication Services resource in the Azure portal");
        console.log("2. Select 'Identity' from the left menu");
        console.log("3. Under the 'System assigned' tab, ensure the status is set to 'On'");
        console.log("4. Go to your Cognitive Services resource");
        console.log("5. Select 'Access control (IAM)' from the left menu");
        console.log("6. Click '+ Add' and select 'Add role assignment'");
        console.log("7. Select 'Cognitive Services User' role and assign it to your ACS resource's managed identity");
    } catch (error) {
        console.error("Configuration check failed:", error);
    }
}

checkConfiguration();
