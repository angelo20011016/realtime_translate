function handleInterviewFinalResult(data) {
    if (!data.original) return;
    const messageLine = document.createElement('div');
    messageLine.classList.add('flex', 'w-full', 'mb-2', 'justify-start');

    const messageBubble = document.createElement('div');
    messageBubble.classList.add('max-w-2xl', 'w-full', 'p-3', 'rounded-xl', 'shadow-sm', 'bg-gray-50', 'text-text-muted', 'text-sm');
    messageBubble.textContent = data.original;
    
    messageLine.appendChild(messageBubble);
    reportDisplay.appendChild(messageLine);
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
    reportDisplay.innerHTML = ''; // Clear the running transcript

    const messageLine = document.createElement('div');
    messageLine.classList.add('flex', 'w-full', 'mb-4', 'justify-center');

    const messageBubble = document.createElement('div');
    messageBubble.classList.add('max-w-4xl', 'w-full', 'p-6', 'rounded-2xl', 'shadow-lg', 'bg-white', 'border', 'border-accent-cyan');
    
    const title = document.createElement('h2');
    title.classList.add('text-xl', 'font-bold', 'text-accent-cyan', 'mb-4');
    title.textContent = "Interview Feedback";
    messageBubble.appendChild(title);

    const reportContent = document.createElement('div');
    reportContent.classList.add('text-text-main');
    
    // The report may contain markdown-like formatting.
    // A simple replacement of newlines with <br> helps with basic formatting.
    reportContent.innerHTML = data.report.replace(/\n/g, '<br>');

    messageBubble.appendChild(reportContent);
    messageLine.appendChild(messageBubble);
    reportDisplay.appendChild(messageLine);
    
    statusDiv.textContent = "Interview feedback generated.";

    if (ttsToggle.checked) {
        socket.emit('request_report_audio', { text: data.report });
    }
}
