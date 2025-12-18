document.addEventListener("DOMContentLoaded", () => {
    // --- DOM Elements ---
    const recordButton = document.getElementById("recordButton");
    const statusDiv = document.getElementById("status");
    const myLanguageSelect = document.getElementById("myLanguage");
    const audioSourceSelect = document.getElementById("audioSource");
    const ttsToggle = document.getElementById("ttsToggle");
    const chatMessagesDisplay = document.getElementById("chatMessages");
    const interimDisplay = document.getElementById("interimDisplay");
    const vuMeterLevel = document.getElementById('vu-meter-level');
    const settingsSidebar = document.getElementById('settings-sidebar');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    const roomIdInput = document.getElementById('roomId');
    const userIdInput = document.getElementById('userId');
    const joinRoomButton = document.getElementById('joinRoomButton');
    const userList = document.getElementById('userList');
    const recordIcon = document.getElementById("recordIcon");
    const recordButtonText = document.getElementById("recordButtonText");

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
    let currentRoomId = null;
    let currentUserId = null;

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
        if (myLanguageSelect) myLanguageSelect.disabled = !enabled;
        if (audioSourceSelect) audioSourceSelect.disabled = !enabled;
        if (ttsToggle) ttsToggle.disabled = !enabled;
        if (joinRoomButton) joinRoomButton.disabled = !enabled;
        if (roomIdInput) roomIdInput.disabled = !enabled;
        if (userIdInput) userIdInput.disabled = !enabled;
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
            if (currentRoomId && currentUserId) {
                socket.emit('join_room', { roomId: currentRoomId, userId: currentUserId, language: myLanguageSelect.value });
            }
            if (isRecording) {
                statusDiv.textContent = "Connected. Start to speak.";
                startAudioCaptureAndEmitSettings();
            }
        });

        socket.on('interim_result', (data) => { interimDisplay.textContent = data.text; });

        socket.on('chat_message', (data) => {
            lastAudioTime = Date.now();
            interimDisplay.textContent = "";
            if (!data.original) return;

            console.log("Received message from sender:", data.senderId, "My user ID:", currentUserId); // Diagnostic log

            const isSent = data.senderId === currentUserId;

            // The main container for the whole message line (aligns left or right)
            const messageLine = document.createElement('div');
            messageLine.classList.add('flex', 'w-full', 'mb-4', isSent ? 'justify-end' : 'justify-start');

            // The bubble containing the message content
            const messageBubble = document.createElement('div');
            messageBubble.classList.add(
                'max-w-lg', // Max width of the bubble
                'p-3', // Padding
                'rounded-2xl', // Rounded corners
                'shadow-md' // A subtle shadow
            );

            if (isSent) {
                messageBubble.classList.add('bg-primary', 'text-white');
            } else {
                messageBubble.classList.add('bg-surface-hover', 'text-text-main');
            }

            // Sender's name
            const senderInfo = document.createElement('p');
            senderInfo.classList.add('font-bold', 'text-sm', 'mb-1');
            // Use a different label for the user's own messages
            senderInfo.textContent = isSent ? "You" : data.senderId; 
            messageBubble.appendChild(senderInfo);

            // Original text
            const originalP = document.createElement('p');
            originalP.classList.add('text-sm');
            if (isSent) {
                originalP.classList.add('text-primary-light', 'opacity-90'); // Lighter color for own original text
            } else {
                originalP.classList.add('text-text-muted'); // Muted color for received original text
            }
            originalP.textContent = data.original;
            messageBubble.appendChild(originalP);
            
            // Don't show translated text if it's the same as the original
            if (data.translated && data.translated.toLowerCase() !== data.original.toLowerCase()) {
                // Separator line
                const separator = document.createElement('hr');
                separator.classList.add('my-2', 'border-t', isSent ? 'border-white/20' : 'border-surface-border');
                messageBubble.appendChild(separator);

                // Translated text
                const translatedP = document.createElement('p');
                translatedP.classList.add('font-medium'); // Make translated text stand out a bit
                translatedP.textContent = data.translated;
                messageBubble.appendChild(translatedP);
            }


            messageLine.appendChild(messageBubble);
            chatMessagesDisplay.appendChild(messageLine);
            chatMessagesDisplay.scrollTop = chatMessagesDisplay.scrollHeight;

            if (ttsToggle.checked && !isSent) {
                if (data.audio) {
                    const audioBlob = new Blob([new Uint8Array(data.audio)], { type: 'audio/mpeg' });
                    audioQueue.push(audioBlob);
                    playNextInQueue();
                }
            }
        });

        socket.on('room_update', (data) => {
            userList.innerHTML = '';
            data.users.forEach(user => {
                const li = document.createElement('li');
                li.textContent = user.userId;
                if (user.userId === currentUserId) {
                    li.classList.add('self');
                }
                userList.appendChild(li);
            });
        });

        socket.on('status_update', (data) => {
            statusDiv.textContent = data.message;
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
        socket.emit('start_chat_translation', {
            language: myLanguageSelect.value,
            ttsEnabled: ttsToggle.checked,
            roomId: currentRoomId,
            userId: currentUserId
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

    recordButton.addEventListener("click", () => {
        if (isRecording) {
            stopRecording();
        } else {
            startRecording();
        }
    });

    function startRecording() {
        if (!currentRoomId || !currentUserId) {
            statusDiv.textContent = "Please join a room first.";
            return;
        }
        isRecording = true;
        recordIcon.textContent = 'stop';
        recordButtonText.textContent = "Stop Speaking";
        recordButton.classList.add("recording");
        statusDiv.textContent = "Requesting microphone access...";
        interimDisplay.textContent = "Listening...";
                setSettingsEnabled(false);

        lastAudioTime = Date.now();
        if (inactivityTimer) clearInterval(inactivityTimer);
        inactivityTimer = setInterval(checkInactivity, 2000);

        startAudioCaptureAndEmitSettings();
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
                recordIcon.textContent = 'mic';
                recordButtonText.textContent = "Start Speaking";
                recordButton.classList.remove("recording");
        statusDiv.textContent = "Click 'Start Speaking' and begin speaking.";
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
        } else if (socket && socket.connected && currentRoomId && currentUserId) {
            // If not recording but connected to a room, just update language setting on server
            socket.emit('update_user_settings', { language: myLanguageSelect.value, ttsEnabled: ttsToggle.checked });
        }
    }

    [myLanguageSelect, audioSourceSelect, ttsToggle].forEach(el => {
        el.addEventListener('change', handleSettingsChange);
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

    joinRoomButton.addEventListener('click', () => {
        const roomId = roomIdInput.value.trim();
        const userId = userIdInput.value.trim();

        if (!roomId || !userId) {
            statusDiv.textContent = "Please enter both Room ID and Your ID.";
            return;
        }

        currentRoomId = roomId;
        currentUserId = userId;
        joinRoomButton.disabled = true;
        roomIdInput.disabled = true;
        userIdInput.disabled = true;
        statusDiv.textContent = `Joining room ${currentRoomId} as ${currentUserId}...`;
        connectSocket(); // Connects or re-uses existing socket
        setSettingsEnabled(true); // Enable TTS and Record button after joining
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
    setSettingsEnabled(true); // Enable settings initially so user can interact
    populateAudioInputDevices();
});