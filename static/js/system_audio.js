document.addEventListener("DOMContentLoaded", () => {
    // --- DOM Elements ---
    const recordButton = document.getElementById("recordButton");
    const statusDiv = document.getElementById("status");
    const sourceLanguageSelect = document.getElementById("sourceLanguage");
    const targetLanguageSelect = document.getElementById("targetLanguage");
    const ttsToggle = document.getElementById("ttsToggle");
    const conversationDisplay = document.getElementById("conversationDisplay");
    const interimDisplay = document.getElementById("interimDisplay");
    const vuMeterLevel = document.getElementById('vu-meter-level');
    const settingsSidebar = document.getElementById('settings-sidebar');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const sidebarOverlay = document.getElementById('sidebar-overlay');

    // --- State Variables ---
    let isRecording = false;
    let inactivityTimer = null;
    let lastAudioTime = 0;
    const INACTIVITY_TIMEOUT_SECONDS = 60;
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
        ttsToggle.disabled = !enabled;
    }

    function connectSocket() {
        if (socket && socket.connected) {
            sendSettings();
            return;
        }

        socket = io({ reconnection: false });

        socket.on('connect', () => {
            console.log("Socket connected.");
            statusDiv.textContent = "Connected to server.";
            if (reconnectInterval) {
                clearInterval(reconnectInterval);
                reconnectInterval = null;
            }
            sendSettings(); // Send initial settings on connect
        });

        socket.on('interim_result', (data) => { interimDisplay.textContent = data.text; });

        socket.on('final_result', (data) => {
            lastAudioTime = Date.now(); // Reset inactivity timer on new result
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
                    if (!socket || !socket.connected) {
                        console.log("Attempting to reconnect...");
                        connectSocket();
                    }
                }, 3000);
            }
        });

        socket.on('connect_error', (error) => {
            console.error('Connection Error:', error);
            statusDiv.textContent = 'Connection failed. Retrying...';
        });
    }

    function sendSettings() {
        if (socket && socket.connected) {
            console.log("Sending settings to server...");
            socket.emit('settings_changed', {
                sourceLanguage: sourceLanguageSelect.value,
                targetLanguage: targetLanguageSelect.value,
                ttsEnabled: ttsToggle.checked
            });
        } else {
            console.log("Socket not connected. Cannot send settings.");
        }
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

    function setupAudioProcessing(stream) {
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
            statusDiv.textContent = "Connected. Start to speak or play audio.";
        }
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

    function showNotification(title, body) {
        if (Notification.permission === 'granted') {
            new Notification(title, { body: body });
        } else {
            statusDiv.textContent = body;
        }
    }

    function checkInactivity() {
        if (!isRecording) {
            clearInterval(inactivityTimer);
            inactivityTimer = null;
            return;
        }
        const inactiveDuration = (Date.now() - lastAudioTime) / 1000;
        if (inactiveDuration > INACTIVITY_TIMEOUT_SECONDS) {
            console.log(`Stopping due to inactivity for over ${INACTIVITY_TIMEOUT_SECONDS} seconds.`);
            stopRecording();
            showNotification("Recording Auto-Stopped", `Stopped due to ${INACTIVITY_TIMEOUT_SECONDS}s of inactivity.`);
        }
    }

    recordButton.addEventListener("click", async () => {
        if (isRecording) {
            await stopRecording();
        } else {
            startRecording();
        }
    });

    async function startRecording() {
        if (!socket || !socket.connected) {
            statusDiv.textContent = "Not connected to server. Please wait.";
            return;
        }
        isRecording = true;
        recordButton.textContent = "Stop Recording";
        recordButton.classList.add("recording");
        statusDiv.textContent = "Requesting system audio access...";
        interimDisplay.textContent = "Listening...";
        setSettingsEnabled(false);

        lastAudioTime = Date.now();
        if (inactivityTimer) clearInterval(inactivityTimer);
        inactivityTimer = setInterval(checkInactivity, 2000);

        try {
            const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            
            if (displayStream.getAudioTracks().length === 0) {
                alert("Audio sharing is required. Please try again and check the 'Share audio' box.");
                await stopRecording();
                return;
            }
            
            displayStream.getVideoTracks().forEach(track => track.stop());

            setupAudioProcessing(displayStream);
            statusDiv.textContent = "Capturing system audio...";

        } catch (err) {
            console.error("Error starting system audio capture:", err);
            statusDiv.textContent = "Capture cancelled or failed.";
            await stopRecording();
        }
    }

    async function stopAudioCapture() {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        vuMeterLevel.style.width = '0%';
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
        audioContext = null;
        analyser = null;
        processor = null;
    }

    async function stopRecording() {
        if (inactivityTimer) {
            clearInterval(inactivityTimer);
            inactivityTimer = null;
        }

        if (!isRecording) return;
        isRecording = false;

        recordButton.textContent = "Start System Capture";
        recordButton.classList.remove("recording");
        statusDiv.textContent = "Click 'Start System Capture' to begin.";
        interimDisplay.textContent = "";
        setSettingsEnabled(true);

        await stopAudioCapture();
        audioQueue.length = 0;
        isPlayingAudio = false;

        if (socket && socket.connected) socket.emit('stop_translation');
    }

    function handleSettingsChange() {
        sendSettings();
    }

    [sourceLanguageSelect, targetLanguageSelect, ttsToggle].forEach(el => {
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
    connectSocket();

    if (Notification.permission === 'default') {
        Notification.requestPermission();
    }
});
