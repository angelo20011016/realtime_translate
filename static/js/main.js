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
        if (sourceLanguageSelect) sourceLanguageSelect.disabled = !enabled;
        if (targetLanguageSelect) targetLanguageSelect.disabled = !enabled;
        if (audioSourceSelect) audioSourceSelect.disabled = !enabled;
        if (ttsToggle) ttsToggle.disabled = !enabled;
    }

    async function populateAudioInputDevices() {
        if (!audioSourceSelect) return;
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

        socket.on('interim_result', (data) => {
            if (!conversationDisplay) return;
            let interimContainer = document.getElementById('interim-container');
            if (!interimContainer) {
                interimContainer = document.createElement('div');
                interimContainer.id = 'interim-container';
                // We don't know who is speaking yet, so align left for now.
                interimContainer.classList.add('flex', 'w-full', 'mb-4', 'justify-start');
                
                const bubble = document.createElement('div');
                bubble.id = 'interim-bubble';
                bubble.classList.add('max-w-lg', 'p-3', 'rounded-2xl', 'shadow-md', 'bg-gray-50', 'text-gray-400', 'italic');
                interimContainer.appendChild(bubble);
                conversationDisplay.appendChild(interimContainer);
            }
            
            const bubble = document.getElementById('interim-bubble');
            bubble.textContent = data.text || '...';
            conversationDisplay.scrollTop = conversationDisplay.scrollHeight;
        });

        socket.on('final_result', (data) => {
            lastAudioTime = Date.now();
            if (!conversationDisplay) return;

            const interimContainer = document.getElementById('interim-container');
            if (interimContainer) interimContainer.remove();

            if (!data.original) return;

            const modeHeader = document.querySelector('#settings-sidebar h1');
            const isSoloMode = modeHeader && modeHeader.textContent.includes('Solo Mode');

            const isPrimarySpeaker = sourceLanguageSelect && data.source_lang.startsWith(sourceLanguageSelect.value.split('-')[0]);

            const messageLine = document.createElement('div');
            let alignmentClass = 'justify-start'; // Default for conversation non-primary speaker
            if (isSoloMode) {
                alignmentClass = 'justify-center';
            } else if (isPrimarySpeaker) {
                alignmentClass = 'justify-end';
            }

            messageLine.classList.add('flex', 'w-full', 'mb-4', alignmentClass);

            const messageBubble = document.createElement('div');
            messageBubble.classList.add('max-w-2xl', 'w-full', 'p-4', 'rounded-2xl', 'shadow-lg', 'border');
            
            // Add animation classes
            messageBubble.classList.add('transition-all', 'duration-500', 'ease-out', 'transform', 'opacity-0', 'translate-y-3');


            if (isSoloMode) {
                messageBubble.classList.add('bg-white', 'border-surface-border');
            } else if (isPrimarySpeaker) {
                messageBubble.classList.add('bg-primary', 'text-white', 'border-transparent');
            } else {
                messageBubble.classList.add('bg-surface-hover', 'text-text-main', 'border-transparent');
            }

            const langName = document.createElement('p');
            langName.classList.add('font-bold', 'text-sm', 'mb-1', 'opacity-80');
            langName.textContent = data.source_lang;
            messageBubble.appendChild(langName);

            const originalP = document.createElement('p');
            originalP.classList.add('text-lg');
            if (isSoloMode) {
                originalP.classList.add('text-text-muted');
            } else if (isPrimarySpeaker) {
                originalP.classList.add('text-primary-light', 'opacity-90');
            } else {
                originalP.classList.add('text-text-muted');
            }
            originalP.textContent = data.original;
            messageBubble.appendChild(originalP);

            const separator = document.createElement('hr');
            let separatorColor = isPrimarySpeaker && !isSoloMode ? 'border-white/20' : 'border-surface-border';
            separator.classList.add('my-3', 'border-t', separatorColor);
            messageBubble.appendChild(separator);

            const translatedP = document.createElement('p');
            translatedP.classList.add('font-semibold', 'text-2xl');
             if (isSoloMode) {
                translatedP.classList.add('text-primary');
            }
            messageBubble.appendChild(translatedP);
            translatedP.textContent = data.refined;

            messageLine.appendChild(messageBubble);
            conversationDisplay.appendChild(messageLine);
            conversationDisplay.scrollTop = conversationDisplay.scrollHeight;

            // Trigger the animation
            setTimeout(() => {
                messageBubble.classList.remove('opacity-0', 'translate-y-3');
            }, 10);
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
            socket.emit('settings_changed', {
                sourceLanguage: sourceLanguageSelect.value,
                targetLanguage: targetLanguageSelect.value,
                ttsEnabled: ttsToggle.checked
            });
        }
    }

    function playNextInQueue() {
        if (isPlayingAudio || audioQueue.length === 0) return;
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
            statusDiv.textContent = "Connected. Start to speak.";
        }
    }

    function startAudioProcessing() {
        statusDiv.textContent = "Microphone connected. Connecting to server...";
        const constraints = { audio: { deviceId: { exact: audioSourceSelect.value } }, video: false };
        navigator.mediaDevices.getUserMedia(constraints)
            .then(stream => setupAudioProcessing(stream))
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

    function startRecording() {
        if (!socket || !socket.connected) {
            statusDiv.textContent = "Not connected to server. Please wait.";
            return;
        }
        isRecording = true;
        recordButton.textContent = "Stop Recording";
        recordButton.classList.add("recording");
        statusDiv.textContent = "Requesting microphone access...";
        setSettingsEnabled(false);

        lastAudioTime = Date.now();
        if (inactivityTimer) clearInterval(inactivityTimer);
        inactivityTimer = setInterval(checkInactivity, 2000);

        startAudioProcessing();
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

        recordButton.textContent = "Start Recording";
        recordButton.classList.remove("recording");
        statusDiv.textContent = "Click 'Start Recording' and begin speaking.";
        if (interimDisplay) interimDisplay.textContent = "";
        setSettingsEnabled(true);

        await stopAudioCapture();
        audioQueue.length = 0;
        isPlayingAudio = false;

        if (socket && socket.connected) socket.emit('stop_translation');
    }

    function handleSettingsChange() {
        sendSettings();
    }

    [sourceLanguageSelect, targetLanguageSelect, ttsToggle, audioSourceSelect].forEach(el => {
        if (el) el.addEventListener('change', handleSettingsChange);
    });

    // UX Fix: 讓點擊開關圖示也能觸發 checkbox
    if (ttsToggle && ttsToggle.parentElement) {
        ttsToggle.parentElement.addEventListener('click', (e) => {
            if (e.target !== ttsToggle && e.target.tagName !== 'LABEL') {
                ttsToggle.checked = !ttsToggle.checked;
                ttsToggle.dispatchEvent(new Event('change'));
            }
        });
        ttsToggle.parentElement.style.cursor = 'pointer';
    }

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
    populateAudioInputDevices().then(() => {
        connectSocket();
    });

    if (Notification.permission === 'default') {
        Notification.requestPermission();
    }
});
