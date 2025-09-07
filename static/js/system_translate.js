function handleTranslateFinalResult(data) {
    if (!data.original) return;

    const entryDiv = document.createElement('div');
    entryDiv.classList.add('text-container');

    const originalP = document.createElement('p');
    originalP.classList.add('original-text');
    originalP.textContent = data.original;
    entryDiv.appendChild(originalP);

    const translatedP = document.createElement('p');
    translatedP.classList.add('translated-text');
    translatedP.textContent = data.refined;
    entryDiv.appendChild(translatedP);

    reportDisplay.appendChild(entryDiv);
    reportDisplay.scrollTop = reportDisplay.scrollHeight;
}