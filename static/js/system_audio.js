document.addEventListener("DOMContentLoaded", () => {
    const selectedMode = processingModeSelect.value;

    // Assign the correct handlers based on the selected mode
    switch (selectedMode) {
        case 'translate':
            onFinalResult = handleTranslateFinalResult;
            // No batch processing or generate button in this mode
            onGenerateClick = () => {}; // Assign empty function to prevent errors
            onBatchResult = () => {};
            break;
        case 'summarize':
            onFinalResult = handleSummarizeFinalResult;
            onGenerateClick = handleSummarizeGenerate;
            onBatchResult = handleSummarizeBatchResult;
            break;
        case 'interview':
            onFinalResult = handleInterviewFinalResult;
            onGenerateClick = handleInterviewGenerate;
            onBatchResult = handleInterviewBatchResult;
            break;
        default:
            // Fallback to translate mode
            onFinalResult = handleTranslateFinalResult;
            break;
    }

    // --- Initialize the application ---
    // All these functions are defined in system_common.js
    initializeEventListeners();
    setSettingsEnabled(true);
    connectSocket();
    populateAudioInputDevices();
});