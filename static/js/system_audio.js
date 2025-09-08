document.addEventListener("DOMContentLoaded", () => {
    const selectedMode = processingModeSelect.value;

    // Assign the correct handlers based on the selected mode
    switch (selectedMode) {
        case 'translate':
            onFinalResult = handleTranslateFinalResult;
            onBatchResult = () => {};
            break;
        case 'summarize':
            onFinalResult = handleSummarizeFinalResult;
            onBatchResult = handleSummarizeBatchResult;
            break;
        case 'interview':
            onFinalResult = handleInterviewFinalResult;
            onBatchResult = handleInterviewBatchResult;
            break;
        default:
            onFinalResult = handleTranslateFinalResult;
            break;
    }

    // --- Initialize the application ---
    connectSocket();
    initializeEventListeners();
    setSettingsEnabled(true);
    populateAudioInputDevices();

    // (AI 建議功能的事件註冊已統一移至 system_common.js，這裡不再重複註冊)
});