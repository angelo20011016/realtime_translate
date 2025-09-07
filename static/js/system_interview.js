function handleInterviewFinalResult(data) {
    const p = document.createElement('p');
    p.textContent = data.original;
    reportDisplay.appendChild(p);
    reportDisplay.scrollTop = reportDisplay.scrollHeight;
}

function handleInterviewGenerate() {
    if (!fullTranscript) {
        statusDiv.textContent = "No transcript to process.";
        return;
    }
    statusDiv.textContent = `Sending transcript for interview coaching...`;
    socket.emit('process_batch', {
        transcript: fullTranscript,
        mode: 'interview',
        sourceLanguage: sourceLanguageSelect.value
    });
}

function handleInterviewBatchResult(data) {
    reportDisplay.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = data.report;
    reportDisplay.appendChild(p);
    statusDiv.textContent = "Interview feedback generated.";

    if (ttsToggle.checked) {
        socket.emit('request_report_audio', { text: data.report });
    }
}