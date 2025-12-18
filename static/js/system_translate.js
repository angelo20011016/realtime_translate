function handleTranslateFinalResult(data) {
    if (!data.original) return;

    // In this mode, we can treat all as 'left' aligned since it's a log of captured audio
    const messageLine = document.createElement('div');
    messageLine.classList.add('flex', 'w-full', 'mb-4', 'justify-start');

    const messageBubble = document.createElement('div');
    messageBubble.classList.add('max-w-2xl', 'w-full', 'p-4', 'rounded-2xl', 'shadow-md', 'bg-surface-hover', 'text-text-main');

    const originalP = document.createElement('p');
    originalP.classList.add('text-sm', 'text-text-muted');
    originalP.textContent = data.original;
    messageBubble.appendChild(originalP);

    if (data.refined && data.refined.toLowerCase() !== data.original.toLowerCase()) {
        const separator = document.createElement('hr');
        separator.classList.add('my-2', 'border-t', 'border-surface-border');
        messageBubble.appendChild(separator);

        const translatedP = document.createElement('p');
        translatedP.classList.add('font-medium');
        translatedP.textContent = data.refined;
        messageBubble.appendChild(translatedP);
    }

    messageLine.appendChild(messageBubble);
    reportDisplay.appendChild(messageLine);
    reportDisplay.scrollTop = reportDisplay.scrollHeight;
}