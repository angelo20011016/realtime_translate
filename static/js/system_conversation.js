document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const languageASelect = document.getElementById('languageA');
    const languageBSelect = document.getElementById('languageB');
    const swapButton = document.getElementById('swapButton');
    const recordButton = document.getElementById('recordButton');
    const chatDisplay = document.getElementById('chatDisplay');
    const statusDiv = document.getElementById('status');
    const audioSourceSelect = document.getElementById('audioSource');
    const ttsToggle = document.getElementById('ttsToggle');
    const vuMeterLevel = document.getElementById('vu-meter-level');
    const settingsSidebar = document.getElementById('settings-sidebar');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const recordIcon = document.getElementById('recordIcon');
    const recordButtonText = document.getElementById('recordButtonText');
    const myMessageAlignmentToggle = null; // Removed from HTML, set to null
    const swapLanguagesButton = document.getElementById('swapLanguagesButton');

    // --- State Variables ---
    let isRecording = false;
    let socket;
    let audioContext;
    let processor;
    let source;
    let mediaStream;
    let analyser;
    let animationFrameId;
    const bufferSize = 2048;
    const targetSampleRate = 16000;

    // --- New state for fixed alignment ---
    let langOnLeft, langOnRight;

    // --- Sidebar Logic ---
    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', () => settingsSidebar.classList.toggle('open'));
    }

    // --- Initialization ---
    function initializeLanguages() {
        langOnLeft = languageASelect.value;
        langOnRight = languageBSelect.value;
        console.log(`Initial setup: Left is ${langOnLeft}, Right is ${langOnRight}`);
    }

    populateAudioInputDevices().then(() => {
        initializeLanguages();
        connectSocket();
    });

    // --- Event Listeners ---
    recordButton.addEventListener('click', toggleRecording);
    ttsToggle.addEventListener('change', handleSettingsChange);
    audioSourceSelect.addEventListener('change', handleSettingsChange);
    myMessageAlignmentToggle.addEventListener('change', handleSettingsChange); // REMOVE THIS LINE
    swapLanguagesButton.addEventListener('click', swapLanguages);

    // UX Fix: 讓點擊開關圖示也能觸發 checkbox
    [ttsToggle].forEach(toggle => {
        if (toggle && toggle.parentElement) {
            toggle.parentElement.addEventListener('click', (e) => {
                if (e.target !== toggle && e.target.tagName !== 'LABEL') {
                    toggle.checked = !toggle.checked;
                    toggle.dispatchEvent(new Event('change'));
                }
            });
            toggle.parentElement.style.cursor = 'pointer';
        }
    });

    // --- Socket Connection ---
    function connectSocket() {
        if (socket && socket.connected) return;
        socket = io({ reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 1000 });

        socket.on('connect', () => {
            console.log("Socket connected.");
            statusDiv.textContent = "Connected. Ready to translate.";
        });

        socket.on('disconnect', () => {
            console.log("Socket disconnected.");
            statusDiv.textContent = "Disconnected. Trying to reconnect...";
            if (isRecording) stopRecording(true);
        });

        socket.on('server_error', (data) => {
            console.error("Server error:", data.error);
            statusDiv.textContent = `Error: ${data.error}`;
            if (isRecording) stopRecording();
        });

        socket.on('interim_result', handleInterimResult);
        socket.on('final_result', handleFinalResult);

        socket.on('audio_synthesis_result', (data) => {
            const audioBlob = new Blob([data.audio], { type: 'audio/mpeg' });
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            audio.play();
        });
    }

    // --- Result Handlers ---
    function handleInterimResult(data) {
        let interimBubble = document.getElementById('interim-bubble');
        if (!interimBubble) {
            const alignment = data.source_lang === langOnLeft ? 'bubble-left' : 'bubble-right';
            interimBubble = createBubble(data.text, 'interim', '', alignment, data.source_lang);
            interimBubble.id = 'interim-bubble';
            chatDisplay.appendChild(interimBubble);
        } else {
            interimBubble.querySelector('.bubble-original-text').textContent = data.text;
        }
        chatDisplay.scrollTop = chatDisplay.scrollHeight;
    }

    function handleFinalResult(data) {
        const interimBubble = document.getElementById('interim-bubble');
        if (interimBubble) interimBubble.remove();

        if (!data.original || !data.refined) return;

        const alignment = data.source_lang === langOnLeft ? 'bubble-left' : 'bubble-right';
        
        const bubble = createBubble(data.original, 'final', data.refined, alignment, data.source_lang);
        chatDisplay.appendChild(bubble);
        chatDisplay.scrollTop = chatDisplay.scrollHeight;
    }

    // --- Core Functions ---
    function toggleRecording() {
        isRecording ? stopRecording() : startRecording();
    }

    function startRecording() {
        if (!socket || !socket.connected) {
            statusDiv.textContent = "Not connected. Please wait.";
            return;
        }
        isRecording = true;
        updateRecordButton();
        setSettingsEnabled(false);
        statusDiv.textContent = "Requesting microphone...";

        socket.emit('start_translation', {
            candidateLanguages: [languageASelect.value, languageBSelect.value],
            ttsEnabled: ttsToggle.checked,
            mode: 'conversation'
        });

        startAudioProcessing();
    }

    async function stopRecording(disconnected = false) {
        if (!isRecording) return;
        isRecording = false;
        if (!disconnected) {
            updateRecordButton();
            setSettingsEnabled(true);
            statusDiv.textContent = "Ready to translate.";
        }
        const interimBubble = document.getElementById('interim-bubble');
        if (interimBubble) interimBubble.remove();

        await stopAudioCapture();

        if (socket && socket.connected) {
            socket.emit('stop_translation');
        }
    }

    function handleSettingsChange() {
        if (!isRecording || !socket || !socket.connected) return;
        console.log('Settings changed, sending update...');
        socket.emit('settings_changed', {
            ttsEnabled: ttsToggle.checked
        });
        statusDiv.textContent = 'Applying new settings...';
    }

    // --- Audio Processing ---
    function startAudioProcessing() {
        const constraints = { audio: { deviceId: { exact: audioSourceSelect.value } }, video: false };
        navigator.mediaDevices.getUserMedia(constraints).then(stream => {
            mediaStream = stream;
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            source = audioContext.createMediaStreamSource(stream);
            processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;

            processor.onaudioprocess = (e) => {
                if (!isRecording || !socket.connected) return;
                const inputData = e.inputBuffer.getChannelData(0);
                const downsampledBuffer = downsample(inputData, audioContext.sampleRate, targetSampleRate);
                const pcm16Buffer = toPCM16(downsampledBuffer);
                socket.emit('audio_data', pcm16Buffer);
            };

            source.connect(analyser);
            analyser.connect(processor);
            processor.connect(audioContext.destination);
            
            updateVUMeter();
            statusDiv.textContent = "Recording... Speak now.";
        }).catch(err => {
            console.error("Error getting media stream:", err);
            statusDiv.textContent = `Mic Error: ${err.message}`;
            stopRecording();
        });
    }

    async function stopAudioCapture() {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        if(vuMeterLevel) vuMeterLevel.style.width = '0%';
        if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
        if (source) source.disconnect();
        if (processor) {
            processor.disconnect();
            processor.onaudioprocess = null;
        }
        if (analyser) analyser.disconnect();
        if (audioContext && audioContext.state !== 'closed') {
            await audioContext.close();
        }
        mediaStream = null;
    }

    function updateVUMeter() {
        if (!isRecording || !analyser) {
            if(vuMeterLevel) vuMeterLevel.style.width = '0%';
            return;
        }
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(dataArray);
        let sumSquares = 0.0;
        for (const amplitude of dataArray) {
            const normalized = (amplitude / 128.0) - 1.0;
            sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);
        const level = Math.min(1, rms / 0.5) * 100;
        if(vuMeterLevel) vuMeterLevel.style.width = level + '%';
        animationFrameId = requestAnimationFrame(updateVUMeter);
    }

    // --- UI & Helper Functions ---
    function createBubble(originalText, type, translatedText = '', alignment, sourceLang = null) {
        const bubble = document.createElement('div');
        bubble.classList.add('chat-bubble', alignment, type);
        if (sourceLang) {
            bubble.dataset.sourceLang = sourceLang;
        }

        const originalP = document.createElement('p');
        originalP.classList.add('bubble-original-text');
        originalP.textContent = originalText;
        bubble.appendChild(originalP);

        if (translatedText) {
            const translatedP = document.createElement('p');
            translatedP.classList.add('bubble-translated-text');
            translatedP.textContent = translatedText;
            bubble.appendChild(translatedP);
        }
        return bubble;
    }

    function updateBubbleAlignments() {
        const bubbles = chatDisplay.querySelectorAll('.chat-bubble');
        bubbles.forEach(bubble => {
            const sourceLang = bubble.dataset.sourceLang; // Get stored source language
            if (sourceLang) {
                let newAlignment = (sourceLang === langOnLeft) ? 'bubble-left' : 'bubble-right';
                
                // Remove existing alignment classes
                bubble.classList.remove('bubble-left', 'bubble-right');
                // Add new alignment class
                bubble.classList.add(newAlignment);
            }
        });
    }

    function swapLanguages() {
        const tempValue = languageASelect.value;
        languageASelect.value = languageBSelect.value;
        languageBSelect.value = tempValue;

        // Manually trigger change events to update dependent logic (e.g., handleSettingsChange)
        languageASelect.dispatchEvent(new Event('change'));
        languageBSelect.dispatchEvent(new Event('change'));

        initializeLanguages(); // Re-initialize langOnLeft/Right based on new selections
        updateBubbleAlignments(); // Call this after languages are initialized

        // Add a visual click effect
        if (swapLanguagesButton) {
            swapLanguagesButton.classList.add('animate-bounce');
            setTimeout(() => {
                swapLanguagesButton.classList.remove('animate-bounce');
            }, 500); // Bounce for 500ms
        }
    }

    function updateRecordButton() {
        const icon = document.getElementById('recordIcon');
        const text = document.getElementById('recordButtonText');
        if (isRecording) {
            icon.textContent = 'stop';
            text.textContent = 'Stop Talking';
            recordButton.classList.add('animate-pulse-ring');
        } else {
            icon.textContent = 'mic';
            text.textContent = 'Start Talking';
            recordButton.classList.remove('animate-pulse-ring');
        }
    }

    function setSettingsEnabled(enabled) {
        if (languageASelect) languageASelect.disabled = !enabled;
        if (languageBSelect) languageBSelect.disabled = !enabled;
        if (audioSourceSelect) audioSourceSelect.disabled = !enabled;
        if (ttsToggle) ttsToggle.disabled = !enabled;
        if (swapLanguagesButton) swapLanguagesButton.disabled = !enabled;
    }

    async function populateAudioInputDevices() {
        try {
            await navigator.mediaDevices.getUserMedia({ audio: true });
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioDevices = devices.filter(device => device.kind === 'audioinput');
            audioSourceSelect.innerHTML = '';
            if (audioDevices.length > 0) {
                audioDevices.forEach(device => {
                    const option = document.createElement('option');
                    option.value = device.deviceId;
                    option.textContent = device.label || `Microphone ${audioSourceSelect.length + 1}`;
                    audioSourceSelect.appendChild(option);
                });
            } else {
                 audioSourceSelect.innerHTML = '<option>No microphones found</option>';
            }
        } catch (err) {
            console.error("Could not enumerate audio devices:", err);
            statusDiv.textContent = "Microphone access denied.";
        }
    }

    // --- Audio Conversion Utilities ---
    function downsample(buffer, fromSampleRate, toSampleRate) {
        if (fromSampleRate === toSampleRate) return buffer;
        const sampleRateRatio = fromSampleRate / toSampleRate;
        const newLength = Math.round(buffer.length / sampleRateRatio);
        const result = new Float32Array(newLength);
        let offsetResult = 0, offsetBuffer = 0;
        while (offsetResult < result.length) {
            const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
            let accum = 0, count = 0;
            for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
                accum += buffer[i];
                count++;
            }
            result[offsetResult] = accum / count;
            offsetResult++;
            offsetBuffer = nextOffsetBuffer;
        }
        return result;
    }

    function toPCM16(input) {
        const buffer = new ArrayBuffer(input.length * 2);
        const view = new DataView(buffer);
        for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }
        return buffer;
    }

    // Force enable settings on load
    setSettingsEnabled(true);
});