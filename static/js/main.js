document.addEventListener("DOMContentLoaded", () => {
    // --- DOM Elements ---
    const recordButton = document.getElementById("recordButton");
    const statusDiv = document.getElementById("status");
    const sourceLanguageSelect = document.getElementById("sourceLanguage");
    const targetLanguageSelect = document.getElementById("targetLanguage");
    const audioSourceSelect = document.getElementById("audioSource");
    const ttsToggle = document.getElementById("ttsToggle");
    const conversationDisplay = document.getElementById("conversationDisplay");
    const interimDisplay = document.getElementById("interimDisplay");
    const vuMeterLevel = document.getElementById('vu-meter-level');
    const settingsSidebar = document.getElementById('settings-sidebar');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const sidebarOverlay = document.getElementById('sidebar-overlay');

    // --- State Variables ---
    let isRecording = false;
    let socket;
    let audioContext;
    let processor;
    let source;
    let mediaStream;
    let analyser;
    let reconnectInterval;
    let animationFrameId;
    const bufferSize = 2048;
    const targetSampleRate = 16000;
    const audioQueue = [];
    let isPlayingAudio = false;

    // --- Sidebar Logic ---
    sidebarToggle.addEventListener('click', () => {
        settingsSidebar.classList.toggle('open');
        sidebarOverlay.classList.toggle('active');
    });

    sidebarOverlay.addEventListener('click', () => {
        settingsSidebar.classList.remove('open');
        sidebarOverlay.classList.remove('active');
    });

    // --- Core Functions ---
    function setSettingsEnabled(enabled) {
        sourceLanguageSelect.disabled = !enabled;
        targetLanguageSelect.disabled = !enabled;
        audioSourceSelect.disabled = !enabled;
        ttsToggle.disabled = !enabled;
    }

    async function populateAudioInputDevices() {
        try {
            await navigator.mediaDevices.getUserMedia({ audio: true });
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputDevices = devices.filter(device => device.kind === 'audioinput');
            
            audioSourceSelect.innerHTML = '';
            if (audioInputDevices.length === 0) {
                audioSourceSelect.innerHTML = '<option>No microphones found</option>';
                return;
            }

            audioInputDevices.forEach(device => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Microphone ${audioSourceSelect.length + 1}`;
                audioSourceSelect.appendChild(option);
            });
        } catch (err) {
            console.error("Could not get audio devices:", err);
            statusDiv.textContent = "Microphone access denied.";
            audioSourceSelect.innerHTML = '<option>Permission denied</option>';
        }
    }

    function connectSocket() {
        if (socket && socket.connected) {
            if (isRecording) {
                statusDiv.textContent = "Connected. Start to speak.";
                startAudioCaptureAndEmitSettings();
            }
            return;
        }

        socket = io({ reconnection: false });

        socket.on('connect', () => {
            console.log("Socket connected.");
            if (reconnectInterval) {
                clearInterval(reconnectInterval);
                reconnectInterval = null;
            }
            if (isRecording) {
                statusDiv.textContent = "Connected. Start to speak.";
                startAudioCaptureAndEmitSettings();
            }
        });

        socket.on('interim_result', (data) => { interimDisplay.textContent = data.text; });

        socket.on('final_result', (data) => {
            interimDisplay.textContent = "";
            if (!data.original) return;

            const entryDiv = document.createElement('div');
            entryDiv.classList.add('conversation-entry');
            const originalP = document.createElement('p');
            originalP.classList.add('original-text');
            originalP.textContent = data.original;
            entryDiv.appendChild(originalP);
            const translatedP = document.createElement('p');
            translatedP.classList.add('translated-text');
            translatedP.textContent = data.refined;
            entryDiv.appendChild(translatedP);
            conversationDisplay.appendChild(entryDiv);
            conversationDisplay.scrollTop = conversationDisplay.scrollHeight;
        });

        socket.on('audio_synthesis_result', (data) => {
            const audioBlob = new Blob([new Uint8Array(data.audio)], { type: 'audio/mpeg' });
            audioQueue.push(audioBlob);
            playNextInQueue();
        });

        socket.on('server_error', (data) => {
            console.error("Server error:", data.error);
            statusDiv.textContent = `Error: ${data.error}`;
            stopRecording();
        });

        socket.on('disconnect', () => {
            console.log("Socket disconnected.");
            statusDiv.textContent = "Disconnected. Attempting to reconnect...";
            stopAudioCapture();
            if (!reconnectInterval) {
                reconnectInterval = setInterval(() => {
                    if (!socket.connected) {
                        console.log("Attempting to reconnect...");
                        socket.connect();
                    }
                }, 3000);
            }
        });

        socket.on('connect_error', (error) => {
            console.error('Connection Error:', error);
            statusDiv.textContent = 'Connection failed. Retrying...';
        });
    }

    function playNextInQueue() {
        if (isPlayingAudio || audioQueue.length === 0) {
            return;
        }
        isPlayingAudio = true;
        const audioBlob = audioQueue.shift();
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        audio.play().catch(e => {
            console.error("Error playing TTS audio:", e);
            isPlayingAudio = false;
        });
        audio.onended = () => {
            URL.revokeObjectURL(audioUrl);
            isPlayingAudio = false;
            playNextInQueue();
        };
    }

    function startAudioCaptureAndEmitSettings() {
        statusDiv.textContent = "Microphone connected. Connecting to server...";
        socket.emit('start_translation', {
            sourceLanguage: sourceLanguageSelect.value,
            targetLanguage: targetLanguageSelect.value,
            ttsEnabled: ttsToggle.checked
        });

        const constraints = { audio: { deviceId: { exact: audioSourceSelect.value } }, video: false };

        navigator.mediaDevices.getUserMedia(constraints)
            .then(stream => {
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
                if (socket.connected) {
                    statusDiv.textContent = "Connected. Start to speak.";
                }
            })
            .catch(err => {
                console.error("Error getting media stream:", err);
                statusDiv.textContent = `Mic Error: ${err.message}`;
                stopRecording();
            });
    }

    function updateVUMeter() {
        if (!isRecording || !analyser) {
            vuMeterLevel.style.width = '0%';
            return;
        }
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        analyser.getByteTimeDomainData(dataArray);

        let sumSquares = 0.0;
        for (const amplitude of dataArray) {
            const normalized = (amplitude / 128.0) - 1.0;
            sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);
        const maxLevel = 0.5;
        const level = Math.min(1, rms / maxLevel) * 100;
        vuMeterLevel.style.width = level + '%';

        animationFrameId = requestAnimationFrame(updateVUMeter);
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
        statusDiv.textContent = "Requesting microphone access...";
        interimDisplay.textContent = "Listening...";
        setSettingsEnabled(false);
        connectSocket();
    }

    function stopAudioCapture() {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        vuMeterLevel.style.width = '0%';
        if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
        if (source) source.disconnect();
        if (processor) processor.disconnect();
        if (analyser) analyser.disconnect();
        if (audioContext) audioContext.close();
        mediaStream = null;
        audioContext = null;
        analyser = null;
    }

    function stopRecording() {
        if (!isRecording) return;
        isRecording = false;

        recordButton.textContent = "Start Recording";
        recordButton.classList.remove("recording");
        statusDiv.textContent = "Click 'Start Recording' and begin speaking.";
        interimDisplay.textContent = "";
        setSettingsEnabled(true);

        stopAudioCapture();
        audioQueue.length = 0;
        isPlayingAudio = false;

        if (socket && socket.connected) socket.emit('stop_translation');
        if (reconnectInterval) {
            clearInterval(reconnectInterval);
            reconnectInterval = null;
        }
    }

    function handleSettingsChange() {
        if (socket && socket.connected && isRecording) {
            console.log("Settings changed while recording, re-initializing...");
            stopAudioCapture();
            startAudioCaptureAndEmitSettings();
        }
    }

    [sourceLanguageSelect, targetLanguageSelect, ttsToggle, audioSourceSelect].forEach(el => {
        el.addEventListener('change', handleSettingsChange);
    });

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

    // Initial setup
    setSettingsEnabled(true);
    populateAudioInputDevices();
});
