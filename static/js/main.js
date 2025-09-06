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
    let captureMode = 'mic'; // 'mic' or 'display'
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

    // --- Create and add System Audio Capture Button ---
    const captureSystemButton = document.createElement('button');
    captureSystemButton.textContent = "Capture System Audio";
    captureSystemButton.id = "captureSystemAudioButton";
    captureSystemButton.style.marginTop = "10px";
    captureSystemButton.style.backgroundColor = "#007BFF";
    captureSystemButton.style.border = "none";
    captureSystemButton.style.color = "white";
    captureSystemButton.style.padding = "15px 32px";
    captureSystemButton.style.textAlign = "center";
    captureSystemButton.style.textDecoration = "none";
    captureSystemButton.style.display = "inline-block";
    captureSystemButton.style.fontSize = "16px";
    captureSystemButton.style.cursor = "pointer";
    captureSystemButton.style.borderRadius = "5px";
    captureSystemButton.style.width = "100%";

    const recordButtonContainer = recordButton.parentNode;
    recordButtonContainer.style.display = 'flex';
    recordButtonContainer.style.flexDirection = 'column';
    recordButtonContainer.style.gap = '10px';
    
    recordButton.parentNode.insertBefore(captureSystemButton, recordButton.nextSibling);

    captureSystemButton.addEventListener('click', async () => {
        if (isRecording) return; 

        captureMode = 'display';
        startRecording();

        try {
            const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            
            if (displayStream.getAudioTracks().length === 0) {
                alert("Audio sharing is required. Please try again and check the 'Share audio' box.");
                stopRecording();
                return;
            }
            
            displayStream.getVideoTracks().forEach(track => track.stop());

            socket.emit('start_translation', {
                sourceLanguage: sourceLanguageSelect.value,
                targetLanguage: targetLanguageSelect.value,
                ttsEnabled: ttsToggle.checked
            });

            setupAudioProcessing(displayStream);
            statusDiv.textContent = "Capturing system audio...";

        } catch (err) {
            console.error("Error starting system audio capture:", err);
            statusDiv.textContent = "Capture cancelled or failed.";
            stopRecording();
        }
    });

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

    function startAudioCaptureAndEmitSettings() {
        if (captureMode === 'display') {
            console.log("In display capture mode, skipping microphone setup.");
            return;
        }

        statusDiv.textContent = "Microphone connected. Connecting to server...";
        socket.emit('start_translation', {
            sourceLanguage: sourceLanguageSelect.value,
            targetLanguage: targetLanguageSelect.value,
            ttsEnabled: ttsToggle.checked
        });

        const constraints = { audio: { deviceId: { exact: audioSourceSelect.value } }, video: false };

        navigator.mediaDevices.getUserMedia(constraints)
            .then(stream => {
                setupAudioProcessing(stream);
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

    recordButton.addEventListener("click", () => {
        if (isRecording) {
            stopRecording();
        } else {
            captureMode = 'mic';
            startRecording();
        }
    });

    function startRecording() {
        isRecording = true;
        recordButton.textContent = "Stop Recording";
        recordButton.classList.add("recording");
        captureSystemButton.disabled = true;
        statusDiv.textContent = "Requesting microphone access...";
        interimDisplay.textContent = "Listening...";
        setSettingsEnabled(false);

        lastAudioTime = Date.now();
        if (inactivityTimer) clearInterval(inactivityTimer);
        inactivityTimer = setInterval(checkInactivity, 2000);

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
        if (inactivityTimer) {
            clearInterval(inactivityTimer);
            inactivityTimer = null;
        }

        if (!isRecording) return;
        isRecording = false;

        recordButton.textContent = "Start Recording";
        recordButton.classList.remove("recording");
        captureSystemButton.disabled = false;
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
        captureMode = 'mic';
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
    if (Notification.permission === 'default') {
        Notification.requestPermission();
    }
});
