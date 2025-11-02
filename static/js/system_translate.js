function handleTranslateFinalResult(data) {
    if (!data.original) return;

    const entryDiv = document.createElement('div');
    // In this mode, we can treat all as 'left' aligned since it's a log of captured audio
    entryDiv.classList.add('chat-bubble', 'bubble-left'); 

    const originalP = document.createElement('p');
    originalP.classList.add('bubble-original-text');
    originalP.textContent = data.original;
    entryDiv.appendChild(originalP);

    if (data.refined) {
        const translatedP = document.createElement('p');
        translatedP.classList.add('bubble-translated-text');
        translatedP.textContent = data.refined;
        entryDiv.appendChild(translatedP);
    }

    reportDisplay.appendChild(entryDiv);
    reportDisplay.scrollTop = reportDisplay.scrollHeight;
}