function handleSummarizeFinalResult(data) {
    const p = document.createElement('p');
    p.textContent = data.original;
    reportDisplay.appendChild(p);
    reportDisplay.scrollTop = reportDisplay.scrollHeight;
}

function handleSummarizeGenerate() {
    if (!fullTranscript) {
        statusDiv.textContent = "No transcript to process.";
        return;
    }
    statusDiv.textContent = `Sending transcript for summary...`;
    socket.emit('process_batch', {
        transcript: fullTranscript,
        mode: 'summarize',
        sourceLanguage: sourceLanguageSelect.value
    });
}

function handleSummarizeBatchResult(data) {
    reportDisplay.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = data.report;
    reportDisplay.appendChild(p);
    statusDiv.textContent = "Summary generated.";
}