document.addEventListener("DOMContentLoaded", () => {
    const recordButton = document.getElementById("recordButton");
    const statusDiv = document.getElementById("status");
    const sourceLanguageSelect = document.getElementById("sourceLanguage");
    const targetLanguageSelect = document.getElementById("targetLanguage");
    const ttsToggle = document.getElementById("ttsToggle");
    const conversationDisplay = document.getElementById("conversationDisplay"); // New
    const interimDisplay = document.getElementById("interimDisplay"); // New

    let isRecording = false;
    let socket; // Declared outside startRecording
    let audioContext;
    let processor;
    let source;
    const bufferSize = 2048;
    const targetSampleRate = 16000;

    // Function to enable/disable settings
    function setSettingsEnabled(enabled) {
        sourceLanguageSelect.disabled = !enabled;
        targetLanguageSelect.disabled = !enabled;
        ttsToggle.disabled = !enabled;
    }

    // Initialize socket once on page load
    socket = io();

    // Socket event handlers (defined once)
    socket.on('connect', () => {
        statusDiv.textContent = "Connected. Click 'Start Recording' to begin.";
        console.log("Socket connected.");
        // If already recording, proceed with audio capture
        if (isRecording) {
            startAudioCaptureAndEmitSettings();
        }
    });

    socket.on('interim_result', (data) => {
        interimDisplay.textContent = data.text;
    });

    socket.on('final_result', (data) => {
        interimDisplay.textContent = "";
        const entryDiv = document.createElement('div');
        entryDiv.classList.add('conversation-entry');

        const originalP = document.createElement('p');
        originalP.classList.add('original-text');
        originalP.textContent = `Original: ${data.original}`;
        entryDiv.appendChild(originalP);

        const translatedP = document.createElement('p');
        translatedP.classList.add('translated-text');
        translatedP.textContent = `Translated: ${data.refined}`;
        entryDiv.appendChild(translatedP);

        conversationDisplay.appendChild(entryDiv);
        conversationDisplay.scrollTop = conversationDisplay.scrollHeight;
    });

    socket.on('audio_synthesis_result', (data) => {
        const audioBytes = new Uint8Array(data.audio);
        const audioBlob = new Blob([audioBytes], { type: 'audio/mpeg' });
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        audio.play().catch(e => console.error("Error playing TTS audio:", e));
        audio.onended = () => URL.revokeObjectURL(audioUrl);
    });

    socket.on('translation_error', (data) => {
        console.error("Translation error:", data.error);
        statusDiv.textContent = `Error: ${data.error}`;
    });

    socket.on('disconnect', () => {
        statusDiv.textContent = "Disconnected. Click 'Start Recording' to reconnect.";
        stopRecording(); // Stop recording if disconnected
    });

    socket.on('connect_error', (error) => {
        console.error('Connection Error:', error);
        statusDiv.textContent = 'Connection failed. Please try again.';
        stopRecording();
    });

    // Function to start audio capture and emit settings
    function startAudioCaptureAndEmitSettings() {
        console.log("Starting audio capture and emitting settings.");
        socket.emit('start_translation', {
            sourceLanguage: sourceLanguageSelect.value,
            targetLanguage: targetLanguageSelect.value,
            ttsEnabled: ttsToggle.checked
        });

        navigator.mediaDevices.getUserMedia({ audio: true, video: false })
            .then(stream => {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                source = audioContext.createMediaStreamSource(stream);
                processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

                processor.onaudioprocess = (e) => {
                    if (!isRecording || !socket.connected) return;

                    const inputData = e.inputBuffer.getChannelData(0);
                    const downsampledBuffer = downsample(inputData, audioContext.sampleRate, targetSampleRate);
                    const pcm16Buffer = toPCM16(downsampledBuffer);
                    
                    socket.emit('audio_data', pcm16Buffer);
                };

                source.connect(processor);
                processor.connect(audioContext.destination);
            })
            .catch(err => {
                console.error("Error getting media stream:", err);
                statusDiv.textContent = `Error: ${err.message}`;
                stopRecording();
            });
    }

    recordButton.addEventListener("click", () => {
        if (isRecording) {
            stopRecording();
        } else {
            startRecording();
        }
    });

    function startRecording() {
        isRecording = true;
        recordButton.textContent = "Stop Recording";
        recordButton.classList.add("recording");
        statusDiv.textContent = "Connecting to server...";
        interimDisplay.textContent = "";
        setSettingsEnabled(false); // Disable settings when recording starts

        if (socket.connected) {
            startAudioCaptureAndEmitSettings();
        } else {
            statusDiv.textContent = "Connecting to server...";
            socket.connect(); // Ensure socket connects if not already
        }
    }

    function stopRecording() {
        if (!isRecording) return;
        isRecording = false;

        recordButton.textContent = "Start Recording";
        recordButton.classList.remove("recording");
        statusDiv.textContent = "Click 'Start Recording' and begin speaking.";
        setSettingsEnabled(true); // Enable settings when recording stops

        if (source) source.disconnect();
        if (processor) processor.disconnect();
        if (audioContext) audioContext.close();
        // Do NOT disconnect socket here, keep it persistent
        // if (socket && socket.connected) socket.disconnect();
    }

    function handleSettingsChange() {
        if (socket.connected) {
            console.log("Settings changed, emitting to server");
            socket.emit('settings_changed', {
                sourceLanguage: sourceLanguageSelect.value,
                targetLanguage: targetLanguageSelect.value,
                ttsEnabled: ttsToggle.checked
            });
        }
    }

    sourceLanguageSelect.addEventListener('change', handleSettingsChange);
    targetLanguageSelect.addEventListener('change', handleSettingsChange);
    ttsToggle.addEventListener('change', handleSettingsChange);

    function downsample(buffer, fromSampleRate, toSampleRate) {
        if (fromSampleRate === toSampleRate) {
            return buffer;
        }
        const sampleRateRatio = fromSampleRate / toSampleRate;
        const newLength = Math.round(buffer.length / sampleRateRatio);
        const result = new Float32Array(newLength);
        let offsetResult = 0;
        let offsetBuffer = 0;
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

    // Initial setup
    setSettingsEnabled(true); // Ensure settings are enabled on load
});
