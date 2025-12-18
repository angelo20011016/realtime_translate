function handleSummarizeFinalResult(data) {
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
    reportDisplay.innerHTML = ''; // Clear the running transcript

    const messageLine = document.createElement('div');
    messageLine.classList.add('flex', 'w-full', 'mb-4', 'justify-center');

    const messageBubble = document.createElement('div');
    messageBubble.classList.add('max-w-4xl', 'w-full', 'p-6', 'rounded-2xl', 'shadow-lg', 'bg-white', 'border', 'border-primary-light');
    
    const title = document.createElement('h2');
    title.classList.add('text-xl', 'font-bold', 'text-primary', 'mb-4');
    title.textContent = "Summary Report";
    messageBubble.appendChild(title);

    const reportContent = document.createElement('div');
    // The report may contain markdown, so we use a 'prose' class if available
    // The parent 'reportDisplay' already has prose, so we just need to set the text.
    reportContent.classList.add('text-text-main');
    reportContent.innerText = data.report; // Using innerText to prevent any weird HTML injection
    
    // A better way would be to use a markdown parser if one was available
    // For now, let's just replace newlines with <br> for basic formatting.
    reportContent.innerHTML = data.report.replace(/\n/g, '<br>');

    messageBubble.appendChild(reportContent);

    messageLine.appendChild(messageBubble);

    reportDisplay.appendChild(messageLine);
    statusDiv.textContent = "Summary generated.";
}